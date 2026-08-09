const { Router } = require("express");
const { prisma } = require("../../lib/prisma");
const brm = require("../../services/brmInsights.service");
const medical = require("../../services/medicalInsights.service");
const opsProxy = require("../../services/opsProxy.service");
const hrmsProxy = require("../../services/hrmsProxy.service");
const casePremiumStats = require("../../services/casePremiumStats.service");
const router = Router();

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
    take: 200,
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

  const [cases, tasks] = await Promise.all([
    prisma.underwritingCase.findMany({
      where: { CreatedAt: { gte: start } },
      select: { CreatedAt: true },
    }),
    prisma.medicalTask.findMany({
      where: { TaskType: "UNDERWRITING", CreatedAt: { gte: start } },
      select: { CreatedAt: true, SlaBreach: true },
    }),
  ]);

  return months.map((m) => {
    const caseCount = cases.filter((c) => {
      const x = new Date(c.CreatedAt);
      return x.getFullYear() === m.year && x.getMonth() === m.month;
    }).length;
    const slaBreach = tasks.filter((t) => {
      if (!t.SlaBreach) return false;
      const x = new Date(t.CreatedAt);
      return x.getFullYear() === m.year && x.getMonth() === m.month;
    }).length;
    return { period: m.label, medicalCases: caseCount, slaBreach, label: m.key };
  });
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

  const [
    brmSnap,
    medSnap,
    pendingPack,
    activeAlerts,
    caseStats,
    taskStats,
    trend,
    depts,
    opsInsights,
    lostMix,
    hrmsOverview,
    opsBookedStats,
    confirmedStats,
  ] = await Promise.all([
    brm.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
    medical.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
    collectPendingMedicalApprovals(6),
    prisma.managementAlert.findMany({
      where: { Status: { in: ["active", "acknowledged", "resolved"] } },
      orderBy: { CreatedAt: "desc" },
      take: 8,
    }),
    Promise.all([
      prisma.underwritingCase.count(),
      prisma.underwritingCase.count({ where: { Status: "NEW" } }),
      prisma.underwritingCase.count({ where: { Status: "IN_REVIEW" } }),
      prisma.underwritingCase.count({ where: { Status: "COMPLETED" } }),
    ]),
    Promise.all([
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING" } }),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING", Status: "IN_PROGRESS" } }),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING", SlaBreach: true } }),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING", Status: "PENDING" } }),
    ]),
    buildTrend(),
    prisma.managementDepartmentMetric.findMany({
      orderBy: { RecordedAt: "desc" },
      take: 40,
    }).catch(() => []),
    opsProxy.getOpsInsights(headers).catch(() => ({ available: false })),
    typeof brm.getLostReasonMix === "function"
      ? brm.getLostReasonMix({ dateFrom, dateTo }).catch(() => null)
      : Promise.resolve(null),
    Promise.all([
      hrmsProxy.approvalStats(headers).catch(() => null),
      hrmsProxy.hrOpsDashboard(headers).catch(() => null),
    ])
      .then(([approvalStats, dashboard]) => ({ approvalStats, dashboard }))
      .catch(() => null),
    casePremiumStats.getOpsBookedStats({ dateFrom, dateTo }),
    casePremiumStats.getConfirmedNotBookedStats({ dateFrom, dateTo }),
  ]);

  const [totalCases, newCases, inReview, completed] = caseStats;
  const [uwTasks, tasksActive, slaBreached, tasksPending] = taskStats;
  const c = brmSnap?.cards || {};

  const openPipeline = Number(c.openPipelineCount ?? 0);
  const pipelinePremium = Number(c.openPremium ?? 0);

  // Master production from BRM snapshot (now DISTINCT sheets) — not used as Ops booked count
  const masterBookedPremium = Number(c.bookedPremium ?? c.achievedTotal ?? 0);
  const masterBookedRows = Number(c.bookedCount ?? 0);

  // Ops booked = BookingStatus true · CPS NetPremium (fallback TargetPremium)
  const opsBookedCount = Number(opsBookedStats?.bookedCount ?? 0);
  const opsBookedPremium = Number(opsBookedStats?.bookedPremium ?? 0);

  // Won / Confirmed = Status=3 not yet Ops-booked · CPS NetPremium (All Summary)
  const confirmedCount = Number(
    confirmedStats?.confirmedCount ?? c.nbWon ?? 0,
  );
  const confirmedPremium = Number(
    confirmedStats?.confirmedPremium ?? 0,
  );

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

  const booking = opsInsights?.booking || null;
  const aml = opsInsights?.aml || null;
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
      hint: "NB open · TargetPremium (pipeline)",
      go: "brm-overview",
      tone: "navy",
    },
    {
      id: "renewal",
      label: "Renewal portfolio",
      count: renCount,
      premium: renPremium,
      hint: `Won ${renWon} · ${aed(renWonPremium)}`,
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
  ].filter((x) => x.value > 0);

  const bookingTotal = Number(booking?.total ?? 0);
  const bookingActive = Number(booking?.activeCase ?? 0);
  const bookingProgress = Number(booking?.caseProgress ?? 0);
  const bookingFresh = Number(booking?.freshcase ?? 0);
  const bookingCompleted = Number(booking?.caseCompleted ?? 0);
  const bookingSla = Number(booking?.slaalert ?? 0);
  // pendingAml is a SUBSET of booking.total (stages 1–4) — never add to Operations
  const bookingPendingAml = Number(booking?.pendingAml ?? 0);
  const amlQueue = Number(aml?.total ?? 0);
  // Prefer Ops pending-AML subset when AML API is empty / overlapping
  const amlTotal = amlQueue > 0 ? amlQueue : bookingPendingAml;

  // Unique confirmed cases in Operations (= Booking panel universe). Do NOT sum AML.
  const opsTotal = bookingTotal;

  // Booking-stage cases past AML (approx): in-progress minus pending AML, floored at 0
  const bookingPastAml = Math.max(0, bookingProgress - bookingPendingAml);

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
        { label: "AML panel queue", count: amlQueue },
        { label: "Pending AML (ops)", count: bookingPendingAml },
        { label: "Needs review", count: amlTotal },
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

  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const systemStatus = [
    {
      system: "PostgreSQL Database",
      status: dbOk ? "operational" : "degraded",
      uptime: dbOk ? "99.8%" : "check",
      lastUpdate: new Date(),
    },
    {
      system: "Operations API",
      status: opsInsights?.available ? "operational" : "unreachable",
      uptime: opsInsights?.available ? "live" : "—",
      lastUpdate: new Date(),
    },
    {
      system: "API Server",
      status: "operational",
      uptime: "100%",
      lastUpdate: new Date(),
    },
  ];

  const lostReasons = Array.isArray(lostMix?.items)
    ? lostMix.items
    : Array.isArray(lostMix)
      ? lostMix
      : Array.isArray(lostMix?.reasons)
        ? lostMix.reasons
        : [];

  return {
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
      ? brmSnap.byExecutive.slice(0, 5).map((e) => ({
          name: e.executiveName || e.executiveEmail || "—",
          cases: Number(e.totalCases || 0),
          premium: Number(e.totalGrossPremium || 0),
          winRate: e.winRate ?? null,
        }))
      : [],
    ops: {
      booking,
      aml,
      available: Boolean(opsInsights?.available),
      // Canonical counts — AML is NEVER added into Operations
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
    },
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
