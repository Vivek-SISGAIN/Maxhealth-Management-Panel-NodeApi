const { Router } = require("express");
const { prisma } = require("../../lib/prisma");
const brm = require("../../services/brmInsights.service");
const medical = require("../../services/medicalInsights.service");
const opsInsights = require("../../services/opsInsights.service");
const opsProxy = require("../../services/opsProxy.service");
const hrmsProxy = require("../../services/hrmsProxy.service");
const executiveCache = require("../../services/executiveCache");
const { DATE_POLICY_META } = require("../../services/managementDatePolicy");
const router = Router();

const EXEC_HRMS_TIMEOUT_MS = Math.max(
  parseInt(process.env.EXEC_HRMS_TIMEOUT_MS || "4000", 10) || 4000,
  1000,
);
const EXEC_SECONDARY_TIMEOUT_MS = Math.max(
  parseInt(process.env.EXEC_SECONDARY_TIMEOUT_MS || "5000", 10) || 5000,
  1000,
);
const EXEC_OPS_PROXY =
  String(process.env.EXEC_OVERVIEW_OPS_PROXY || "false").toLowerCase() === "true";

const aed = (n) => {
  const v = Number(n) || 0;
  return `AED ${v.toLocaleString("en-AE", { maximumFractionDigits: 0 })}`;
};

const SENT = "SENT_FOR_MANAGEMENT_APPROVAL";
const RESUB = "RESUBMITTED";

const transformAlert = (alert) => ({
  id: alert.Id,
  type: alert.Type,
  title: alert.Title,
  message: alert.Message,
  department: alert.Department,
  severity: alert.Severity,
  status: alert.Status,
  actionRequired: alert.ActionRequired,
  source: alert.Source,
  createdAt: alert.CreatedAt,
});

async function collectPendingMedicalApprovals(limit = 8) {
  const tasks = await prisma.medicalTask.findMany({
    where: { TaskType: "UNDERWRITING" },
    select: { Id: true, CaseId: true, Metadata: true, Priority: true, SlaDeadline: true, UpdatedAt: true },
    orderBy: { UpdatedAt: "desc" },
    take: 80,
  });
  const out = [];
  let urgent = 0;
  for (const task of tasks) {
    const members = task.Metadata?.doctorWorkbench?.members || {};
    for (const [memberId, wb] of Object.entries(members)) {
      if (!wb || typeof wb !== "object") continue;
      const stage = String(wb.stage || "");
      if (stage !== SENT && stage !== RESUB) continue;
      const summary = wb.summary || {};
      const amount = summary.adjustedPremium ?? summary.annualPremium ?? null;
      const name = wb.formSnapshot?.memberName || wb.formSnapshot?.name || "Member";
      const pri = String(task.Priority || "MEDIUM").toLowerCase();
      if (pri === "high" || pri === "critical") urgent += 1;
      out.push({
        id: `${task.Id}:${memberId}`,
        type: "Medical Underwriting Approval",
        department: "Medical Underwriting",
        memberName: name,
        memberAge: wb.formSnapshot?.age ?? null,
        caseId: task.CaseId,
        amount: amount
          ? `AED ${Number(amount).toLocaleString("en-AE", { maximumFractionDigits: 0 })}`
          : null,
        priority: pri === "critical" ? "urgent" : pri === "high" ? "high" : "medium",
        dueDate: task.SlaDeadline ? new Date(task.SlaDeadline).toLocaleDateString() : "N/A",
        submittedDate: wb.stageUpdatedAt || task.UpdatedAt,
      });
    }
  }
  return { items: out.slice(0, limit), total: out.length, urgent };
}

async function buildTrend() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en", { month: "short" }),
      year: d.getFullYear(),
      month: d.getMonth(),
    });
  }
  const start = new Date(months[0].year, months[0].month, 1);

  const [caseRows, taskRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        date_trunc('month', "CreatedAt") AS bucket,
        COUNT(*)::int AS cnt
      FROM "UnderwritingCase"
      WHERE "CreatedAt" >= ${start}
      GROUP BY 1
    `,
    prisma.$queryRaw`
      SELECT
        date_trunc('month', "CreatedAt") AS bucket,
        COUNT(*)::int AS cnt
      FROM "MedicalTask"
      WHERE "TaskType" = 'UNDERWRITING'
        AND "SlaBreach" = true
        AND "CreatedAt" >= ${start}
      GROUP BY 1
    `,
  ]);

  const caseMap = new Map(
    (caseRows || []).map((r) => {
      const d = new Date(r.bucket);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return [key, Number(r.cnt || 0)];
    }),
  );
  const slaMap = new Map(
    (taskRows || []).map((r) => {
      const d = new Date(r.bucket);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return [key, Number(r.cnt || 0)];
    }),
  );

  return months.map((m) => ({
    period: m.label,
    medicalCases: caseMap.get(m.key) || 0,
    slaBreach: slaMap.get(m.key) || 0,
    label: m.key,
  }));
}

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    }),
  ]);
}

function softTimeout(promise, ms, fallback = null, label = "secondary") {
  return Promise.race([
    promise.catch((e) => {
      console.warn(`[executive] ${label} failed:`, e?.message || e);
      return fallback;
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        console.warn(`[executive] ${label} soft-timeout ${ms}ms — continuing with live KPIs`);
        resolve(fallback);
      }, ms);
    }),
  ]);
}

async function fetchHrmsOverview(headers) {
  try {
    const [approvalStats, dashboard] = await withTimeout(
      Promise.all([
        hrmsProxy.approvalStats(headers),
        hrmsProxy.hrOpsDashboard(headers),
      ]),
      EXEC_HRMS_TIMEOUT_MS,
      "HRMS proxy",
    );
    return { approvalStats, dashboard };
  } catch (e) {
    console.warn("[executive] HRMS skipped:", e?.message || e);
    return null;
  }
}

function scoreLabel(score) {
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Good";
  if (score >= 70) return "Warning";
  return "Critical";
}

/**
 * GET /management/overview  (legacy)
 * GET /management/executive — full executive dashboard payload
 */
router.get("/overview", async (req, res) => {
  try {
    const data = await buildExecutive(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch overview" });
  }
});

router.get("/executive", async (req, res) => {
  try {
    const data = await buildExecutive(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch executive dashboard" });
  }
});

async function buildExecutive(req) {
  const dateFrom = req.query.dateFrom || req.query.from || undefined;
  const dateTo = req.query.dateTo || req.query.to || undefined;
  const headers = req.headers || {};

  const cached = executiveCache.get(dateFrom, dateTo);
  if (cached) return cached;

  const t0 = Date.now();

  // Critical live KPIs (must complete) — secondary charts/HR soft-timeout so they never block.
  const [
    brmSnap,
    medSnap,
    pendingPack,
    activeAlerts,
    trend,
    opsKpis,
    lostMix,
    hrmsOverview,
  ] = await Promise.all([
    brm.getExecutiveSnapshot({ dateFrom, dateTo }).catch((e) => {
      console.warn("[executive] BRM snapshot failed:", e?.message || e);
      return null;
    }),
    medical.getExecutiveCounts({ dateFrom, dateTo }).catch((e) => {
      console.warn("[executive] medical counts failed:", e?.message || e);
      return null;
    }),
    collectPendingMedicalApprovals(6),
    prisma.managementAlert
      .findMany({
        where: { Status: { in: ["active", "acknowledged", "resolved"] } },
        orderBy: { CreatedAt: "desc" },
        take: 8,
      })
      .catch(() => []),
    buildTrend(),
    opsInsights.getDeptKpis({ dateFrom, dateTo }).catch((e) => {
      console.warn("[executive] ops KPIs failed:", e?.message || e);
      return null;
    }),
    softTimeout(
      typeof brm.getLostReasonMix === "function"
        ? brm.getLostReasonMix({ dateFrom, dateTo })
        : Promise.resolve(null),
      EXEC_SECONDARY_TIMEOUT_MS,
      null,
      "lost reasons",
    ),
    softTimeout(fetchHrmsOverview(headers), EXEC_HRMS_TIMEOUT_MS, null, "HRMS"),
  ]);

  const opsLive = EXEC_OPS_PROXY
    ? await softTimeout(
        opsProxy.getOpsInsights(headers),
        EXEC_SECONDARY_TIMEOUT_MS,
        { available: false },
        "ops proxy",
      )
    : { available: false, booking: null, aml: null };

  const depts = [];
  console.log(
    `[executive] build ${Date.now() - t0}ms ` +
      `ops=${opsKpis ? "ok" : "null"} brm=${brmSnap ? "ok" : "null"} ` +
      `range=${dateFrom || "all"}->${dateTo || "all"}`,
  );

  const k = opsKpis || {};
  const opsBookedCount = Number(k.opsBooked ?? 0);
  const opsBookedPremium = Number(k.bookedPremium ?? 0);
  const confirmedCount = Number(k.total ?? 0);
  const confirmedPremium = Number(k.totalPremium ?? 0);

  const medCards = medSnap?.cards || {};
  const totalCases = Number(medCards.totalCases ?? 0);
  const newCases = Number(medCards.newCases ?? 0);
  const inReview = Number(medCards.inReview ?? 0);
  const completed = Number(medCards.completed ?? medCards.byStatus?.completed ?? 0);
  const slaBreached = Number(medCards.slaBreached ?? 0);
  const uwTasks = Number(medCards.uwTasks ?? 0);
  const tasksActive = Number(medCards.tasksInProgress ?? 0);
  const tasksPending = Number(medCards.tasksPending ?? 0);
  const c = brmSnap?.cards || {};

  const openPipeline = Number(c.openPipelineCount ?? 0);
  const pipelinePremium = Number(c.openPremium ?? 0);
  const masterBookedPremium = Number(c.bookedPremium ?? c.achievedTotal ?? 0);
  const masterBookedRows = Number(c.bookedCount ?? 0);

  const bookedCount = opsBookedCount;
  const bookedPremium = opsBookedPremium;
  const wonCount = confirmedCount || Number(c.nbWon ?? 0);
  const wonPremium = confirmedPremium || Number(c.winCasePremium ?? 0);
  const renCount = Number(c.renCount ?? 0);
  const renPremium = Number(c.renExpiringPremium ?? 0);
  const renWon = Number(c.renWon ?? c.renConfirmed ?? 0);
  const renWonPremium = Number(c.renWonPremium ?? 0);
  const nbCount = Number(c.nbCount ?? openPipeline);
  const nbLost = Number(c.nbLost ?? 0);
  const forecastPremium = Number(
    (bookedPremium || masterBookedPremium) + pipelinePremium * 0.6,
  );

  const decided = wonCount + nbLost;
  const conversionPct =
    decided > 0 ? Math.round((wonCount / decided) * 1000) / 10 : null;
  const renDecided = renWon + Number(c.renLost ?? 0);
  const renewalRetentionPct =
    renDecided > 0 ? Math.round((renWon / renDecided) * 1000) / 10 : null;
  const uwTotal = Math.max(totalCases, 1);
  const slaCompliancePct = Math.round(
    ((uwTotal - Math.min(slaBreached, uwTotal)) / uwTotal) * 1000,
  ) / 10;

  const booking = opsLive?.booking || null;
  const aml = opsLive?.aml || null;
  const hrLeavePending = Number(
    hrmsOverview?.approvalStats?.pending ??
      hrmsOverview?.dashboard?.leave?.pending ??
      0,
  );
  const hrActiveEmp = Number(
    hrmsOverview?.dashboard?.employees?.active ??
      hrmsOverview?.dashboard?.employees?.total ??
      0,
  );

  const topExec = Array.isArray(brmSnap?.byExecutive) ? brmSnap.byExecutive[0] : null;
  const topBrm = topExec?.executiveName || topExec?.executiveEmail || "—";
  const topBrmDetail = topExec
    ? `${topExec.executiveName || topExec.executiveEmail} · ${Number(topExec.totalCases || 0)} cases · ${aed(topExec.totalGrossPremium)}`
    : "—";

  /** Primary KPI tiles — each has count + premium where applicable */
  const primaryKpis = [
    {
      id: "won",
      label: "Won / Confirmed",
      count: wonCount,
      premium: wonPremium,
      hint: "All Status 3 confirmed · booked + not booked · CPS net",
      go: "brm-overview",
      tone: "blue",
    },
    {
      id: "booked",
      label: "Ops booked",
      count: bookedCount,
      premium: bookedPremium,
      hint: "Subset of Won · BookingStatus · CPS net only",
      go: "booking-overview",
      tone: "green",
    },
    {
      id: "pipeline",
      label: "Open pipeline",
      count: openPipeline,
      premium: pipelinePremium,
      hint: "NB open · TargetPremium · policy start date",
      go: "brm-overview",
      tone: "navy",
    },
    {
      id: "renewal",
      label: "Renewal portfolio",
      count: renCount,
      premium: renPremium,
      hint: `Won ${renWon} · ${aed(renWonPremium)} · policy expiry date`,
      go: "brm-renewals",
      tone: "teal",
    },
  ];

  const fsdKpis = [
    {
      id: "conversion",
      label: "Conversion ratio",
      value: conversionPct != null ? `${conversionPct}%` : "—",
      hint: `Won ${wonCount} of ${decided || "—"} decided`,
    },
    {
      id: "retention",
      label: "Renewal retention",
      value: renewalRetentionPct != null ? `${renewalRetentionPct}%` : "—",
      hint: `Won ${renWon} · Lost ${Number(c.renLost ?? 0)}`,
    },
    {
      id: "sla",
      label: "Medical SLA compliance",
      value: `${slaCompliancePct}%`,
      hint: `${slaBreached} breaches`,
    },
    {
      id: "forecast",
      label: "Forecast GP",
      value: aed(forecastPremium),
      hint: "Ops booked + 60% open pipeline",
    },
  ];

  const pipelineMix = [
    { name: "Hot", value: Number(c.nbHot ?? 0) },
    { name: "Active / Med", value: Number(c.nbActive ?? 0) },
    { name: "Warm", value: Number(c.nbWarm ?? 0) },
    { name: "Cold / Low", value: Number(c.nbCold ?? 0) },
    { name: "Ongoing", value: Number(c.nbOngoing ?? 0) },
    { name: "Won", value: wonCount },
    { name: "Lost", value: nbLost },
  ];

  const opsTotal = Number(k.total ?? 0);
  const bookingTotal = opsTotal;
  const bookingActive = Number(k.notBooked ?? 0);
  const bookingProgress = Number(k.bookingProgress ?? 0);
  const bookingFresh = Number(k.fresh ?? 0);
  const bookingCompleted = Number(k.stageCompleted ?? 0);
  const bookingSla = Number(k.slaAlerts ?? 0);
  const bookingPendingAml = Number(k.pendingAml ?? 0);
  const amlTotal = Number(k.amlSentTotal ?? 0);
  const bookingPastAml = Math.max(0, bookingProgress - bookingPendingAml);

  const amlBreakdown = {
    total: amlTotal,
    pending: Number(k.amlPending ?? 0),
    partial: Number(k.amlPartial ?? 0),
    approved: Number(k.amlApproved ?? 0),
    rejected: Number(k.amlRejected ?? 0),
  };

  const bookingBreakdown = {
    fresh: bookingFresh,
    inAmlStages: bookingPendingAml,
    inProgress: Number(k.bookingInProgress ?? 0),
    fullyBooked: Number(k.opsBooked ?? bookedCount),
    completed: bookingCompleted,
  };

  const deptChart = [
    { name: "BRM", count: openPipeline, premium: pipelinePremium },
    { name: "Booked", count: bookedCount, premium: bookedPremium },
    { name: "Renewals", count: renCount, premium: renPremium },
    { name: "Medical", count: totalCases, premium: 0 },
    { name: "Operations", count: opsTotal, premium: 0 },
    { name: "Past AML", count: bookingPastAml, premium: 0 },
    { name: "AML", count: amlTotal, premium: 0 },
  ];

  const deptMixChart = [
    { name: "BRM open", value: openPipeline, fill: "#0a2f6b" },
    { name: "Medical", value: totalCases, fill: "#0891b2" },
    { name: "Operations", value: opsTotal, fill: "#6d28d9" },
    { name: "AML", value: amlTotal, fill: "#3B62F0" },
    { name: "HR leave", value: hrLeavePending, fill: "#16794b" },
  ].filter((d) => d.value > 0);

  const departments = [
    {
      id: "brm",
      name: "Business Relationship Mgmt",
      accent: "teal",
      link: "brm-overview",
      primary: { label: "Open cases", value: openPipeline },
      secondary: { label: "Pipeline GP", value: aed(pipelinePremium) },
      metrics: [
        { label: "Won", count: wonCount, premium: aed(wonPremium) },
        { label: "Booked", count: bookedCount, premium: aed(bookedPremium) },
        { label: "Renewals", count: renCount, premium: aed(renPremium) },
        { label: "BRMs active", count: Number(c.brmCount ?? 0) },
      ],
      pending: [
        { label: "Lost NB", count: nbLost },
        { label: "Conversion", count: conversionPct != null ? `${conversionPct}%` : "—" },
      ],
      performance: Math.min(99, Math.round(70 + Math.min(25, openPipeline / 20))),
    },
    {
      id: "medical",
      name: "Medical Underwriting",
      accent: "cyan",
      link: "medical-overview",
      primary: { label: "UW cases", value: totalCases },
      secondary: { label: "In review", value: inReview },
      metrics: [
        { label: "New", count: newCases },
        { label: "In review", count: inReview },
        { label: "Completed", count: completed },
        { label: "SLA breach", count: slaBreached },
      ],
      pending: [
        { label: "Pending approvals", count: pendingPack.total },
        { label: "Active tasks", count: tasksActive },
      ],
      performance: slaBreached > 20 ? 72 : slaBreached > 5 ? 84 : 93,
    },
    {
      id: "operations",
      name: "Operations",
      accent: "amber",
      link: "ops-overview",
      primary: { label: "Confirmed cases", value: opsTotal },
      secondary: {
        label: "In progress",
        value: bookingProgress,
      },
      metrics: [
        { label: "Total (unique)", count: opsTotal },
        { label: "Active", count: bookingActive },
        { label: "In progress", count: bookingProgress },
        { label: "Completed", count: bookingCompleted },
        { label: "Fresh", count: bookingFresh },
        { label: "SLA alerts", count: bookingSla },
      ],
      pending: [
        { label: "Pending AML (subset)", count: bookingPendingAml },
        { label: "Past AML / booking", count: bookingPastAml },
      ],
      performance: bookingSla > 10 ? 74 : 89,
    },
    {
      id: "booking",
      name: "Booking",
      accent: "violet",
      link: "booking-overview",
      primary: {
        label: "Past AML / booking",
        value: bookingPastAml || bookingProgress,
      },
      secondary: {
        label: "Full ops queue",
        value: bookingTotal,
      },
      metrics: [
        { label: "Ops confirmed (unique)", count: bookingTotal },
        { label: "Past AML stage", count: bookingPastAml },
        { label: "Active", count: bookingActive },
        { label: "Fresh", count: bookingFresh },
        { label: "Completed", count: bookingCompleted },
        { label: "SLA alerts", count: bookingSla },
      ],
      pending: [
        { label: "Pending AML handoff", count: bookingPendingAml },
        { label: "SLA alerts", count: bookingSla },
      ],
      performance: bookingSla > 10 ? 75 : 88,
    },
    {
      id: "aml",
      name: "AML",
      accent: "blue",
      link: "aml-overview",
      primary: {
        label: "AML queue",
        value: amlTotal,
      },
      secondary: {
        label: "Ops stages 1–4",
        value: bookingPendingAml,
      },
      metrics: [
        { label: "AML sent", count: amlTotal },
        { label: "Pending", count: amlBreakdown.pending },
        { label: "Partial", count: amlBreakdown.partial },
        { label: "Approved", count: amlBreakdown.approved },
        { label: "Rejected", count: amlBreakdown.rejected },
      ],
      pending: [
        { label: "Needs review", count: amlTotal },
      ],
      note: "AML is a subset of Operations — not added on top",
      performance: amlTotal > 20 ? 78 : 90,
    },
    {
      id: "hr",
      name: "HRMS",
      accent: "emerald",
      link: "hr-overview",
      primary: { label: "Active employees", value: hrActiveEmp || depts.length || "—" },
      secondary: { label: "Leave / WF pending", value: hrLeavePending },
      metrics: [
        { label: "Leave approvals", count: hrLeavePending },
        { label: "Active staff", count: hrActiveEmp },
      ],
      pending: [
        { label: "Workflow pending", count: hrLeavePending },
      ],
      performance: hrLeavePending > 15 ? 80 : 92,
    },
  ].map((d) => ({ ...d, status: scoreLabel(d.performance) }));

  const departmentPerformance = departments.map((d) => ({
    department: d.name,
    performance: d.performance,
    status: d.status,
  }));

  let dbOk = Boolean(opsKpis);
  const systemStatus = [
    {
      system: "PostgreSQL Database",
      status: dbOk ? "operational" : "degraded",
      uptime: dbOk ? "99.8%" : "check",
      lastUpdate: new Date(),
    },
    {
      system: "Operations API",
      status: opsLive?.available ? "operational" : "db-backed",
      uptime: opsLive?.available ? "live" : "database",
      lastUpdate: new Date(),
    },
    {
      system: "API Server",
      status: "operational",
      uptime: "100%",
      lastUpdate: new Date(),
    },
  ];

  const lostReasons = Array.isArray(lostMix?.mix)
    ? lostMix.mix
    : Array.isArray(lostMix?.items)
      ? lostMix.items
      : Array.isArray(lostMix)
        ? lostMix
        : Array.isArray(lostMix?.reasons)
          ? lostMix.reasons
          : [];

  const payload = {
    heroes: {
      // Legacy fields kept for any older UI consumers
      brmAchieved: wonPremium,
      brmAchievedLabel: "won / achieved GP",
      brmPipelineCount: openPipeline,
      brmBookedGp: bookedPremium,
      brmBookedLabel: "booked GP",
      brmNbCount: nbCount,
      medicalCases: totalCases,
      medicalInReview: inReview,
      pendingApprovals: pendingPack.total,
      urgentApprovals: pendingPack.urgent || medSnap?.cards?.urgentApprovals || 0,
      // New explicit count + premium
      wonCount,
      wonPremium,
      bookedCount,
      bookedPremium,
      masterBookedPremium,
      masterBookedRows,
      openPipeline,
      pipelinePremium,
      renCount,
      renPremium,
      renWon,
      renWonPremium,
      conversionPct,
      renewalRetentionPct,
      slaCompliancePct,
      hrLeavePending,
    },
    primaryKpis,
    fsdKpis,
    pipelineMix,
    deptChart,
    lostReasons: lostReasons.slice(0, 8),
    topBrokers: Array.isArray(brmSnap?.byExecutive)
      ? brmSnap.byExecutive.slice(0, 15).map((e) => ({
          name: e.executiveName || e.executiveEmail || "—",
          cases: Number(e.totalCases || 0),
          premium: Number(e.totalGrossPremium || 0),
          winRate: e.winRate ?? null,
        }))
      : [],
    ops: {
      booking,
      aml,
      available: Boolean(opsKpis || opsLive?.available),
      totals: {
        operations: opsTotal,
        booking: bookingTotal,
        aml: amlTotal,
        pendingAml: bookingPendingAml,
        pastAml: bookingPastAml,
        inProgress: bookingProgress,
        active: bookingActive,
        completed: bookingCompleted,
        slaAlerts: bookingSla,
      },
      amlBreakdown,
      bookingBreakdown,
    },
    amlBreakdown,
    bookingBreakdown,
    datePolicy: DATE_POLICY_META,
    deptMixChart,
    opsBreakdown: [
      { name: "Operations (unique)", value: opsTotal, fill: "#0a2f6b" },
      { name: "Pending AML", value: bookingPendingAml, fill: "#3B62F0" },
      { name: "Past AML", value: bookingPastAml, fill: "#6d28d9" },
      { name: "Completed", value: bookingCompleted, fill: "#16794b" },
      { name: "Fresh", value: bookingFresh, fill: "#0E9AA0" },
    ].filter((d) => d.value > 0),
    brmBanner: {
      forecast: forecastPremium,
      topBrm,
      topBrmDetail,
      cases: openPipeline,
      pipelinePremium,
    },
    medicalStrip: {
      totalCases,
      newCases,
      inReview,
      completed,
      slaBreached,
      tasksActive,
      tasksPending,
      uwTasks,
    },
    departments,
    departmentPerformance,
    pendingApprovals: pendingPack.items,
    pendingApprovalsTotal: pendingPack.total,
    alerts: activeAlerts.map(transformAlert),
    systemStatus,
    trend,
    crossDeptTrend: (() => {
      const brmSeries = Array.isArray(brmSnap?.trends) ? brmSnap.trends : [];
      const byKey = new Map(
        trend.map((t) => [
          t.label || t.period,
          {
            period: t.period,
            medical: Number(t.medicalCases || 0),
            slaBreach: Number(t.slaBreach || 0),
            brmCases: 0,
            renewals: 0,
          },
        ]),
      );
      for (const row of brmSeries) {
        const key = String(row.period || "");
        const short =
          key.length >= 7
            ? new Date(`${key}-01`).toLocaleString("en", { month: "short" })
            : key;
        const existing = byKey.get(key) || byKey.get(short) || {
          period: short,
          medical: 0,
          slaBreach: 0,
          brmCases: 0,
          renewals: 0,
        };
        existing.brmCases = Number(row.caseCount || 0);
        existing.renewals = Number(row.renewalBatches || 0);
        byKey.set(existing.period, existing);
      }
      const rows = Array.from(byKey.values());
      // Attach live ops snapshot on the latest month so Ops/AML appear on the multi-dept chart
      if (rows.length) {
        const last = rows[rows.length - 1];
        last.operations = opsTotal;
        last.booking = bookingTotal;
        last.aml = amlTotal;
      }
      return rows;
    })(),
    cards: medSnap?.cards || null,
    brmCards: c,
  };

  // Only cache successful live payloads (never blank/failed KPI shells)
  const liveOk = Boolean(opsKpis) && Boolean(brmSnap?.cards);
  if (liveOk) executiveCache.set(dateFrom, dateTo, payload);
  return payload;
}

router.get("/system-status", async (_req, res) => {
  try {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    res.json({
      success: true,
      data: [
        {
          system: "PostgreSQL Database",
          status: dbOk ? "operational" : "degraded",
          uptime: dbOk ? "99.8%" : "check",
          lastUpdate: new Date(),
        },
        {
          system: "Redis Cache",
          status: process.env.REDIS_URL ? "configured" : "not-configured",
          uptime: process.env.REDIS_URL ? "99.9%" : "—",
          lastUpdate: new Date(),
        },
        {
          system: "RabbitMQ",
          status: process.env.RABBITMQ_URL ? "configured" : "not-configured",
          uptime: process.env.RABBITMQ_URL ? "99.5%" : "—",
          lastUpdate: new Date(),
        },
        {
          system: "API Server",
          status: "operational",
          uptime: "100%",
          lastUpdate: new Date(),
        },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch system status" });
  }
});

module.exports = router;
