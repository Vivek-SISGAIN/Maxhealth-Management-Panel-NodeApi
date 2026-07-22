const { Router } = require("express");
const { prisma } = require("../../lib/prisma");
const brm = require("../../services/brmInsights.service");
const medical = require("../../services/medicalInsights.service");
const router = Router();

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

  const [
    brmSnap,
    medSnap,
    pendingPack,
    activeAlerts,
    caseStats,
    taskStats,
    trend,
    depts,
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
  ]);

  const [totalCases, newCases, inReview, completed] = caseStats;
  const [uwTasks, tasksActive, slaBreached, tasksPending] = taskStats;

  // Department cards — prefer live BRM/Medical counts
  const openPipeline = Number(brmSnap?.cards?.openPipelineCount ?? 0);
  const pipelinePremium = Number(brmSnap?.cards?.openPremium ?? 0);
  const bookedPremium = Number(brmSnap?.cards?.bookedPremium ?? brmSnap?.cards?.achievedTotal ?? 0);
  const forecastPremium = Number(brmSnap?.cards?.forecastTotal ?? 0);
  const topExec = Array.isArray(brmSnap?.byExecutive) ? brmSnap.byExecutive[0] : null;
  const topBrm = topExec?.executiveName || topExec?.executiveEmail || "—";
  const topBrmDetail = topExec
    ? `${topExec.executiveName || topExec.executiveEmail} · ${Number(topExec.totalCases || 0)} cases · AED ${Math.round(Number(topExec.totalGrossPremium || 0)).toLocaleString("en-AE")}`
    : "—";

  const departments = [
    {
      id: "brm",
      name: "Business Relationship Mgmt",
      accent: "teal",
      link: "brm-overview",
      primary: { label: "Open cases", value: openPipeline },
      secondary: {
        label: "Pipeline GP",
        value: pipelinePremium
          ? `AED ${pipelinePremium.toLocaleString("en-AE", { maximumFractionDigits: 0 })}`
          : "—",
      },
      pending: [
        { label: "Renewals due", count: Number(brmSnap?.cards?.renCount ?? 0) },
        { label: "Executives active", count: Number(brmSnap?.cards?.brmCount ?? brmSnap?.executiveCount ?? 0) },
      ],
      trendPct: null,
      performance: Math.min(99, Math.round(70 + Math.min(25, openPipeline / 20))),
    },
    {
      id: "medical",
      name: "Medical Underwriting",
      accent: "cyan",
      link: "medical-overview",
      primary: { label: "UW cases", value: totalCases },
      secondary: { label: "In review", value: inReview },
      pending: [
        { label: "Pending approvals", count: pendingPack.total },
        { label: "SLA breached", count: slaBreached },
      ],
      trendPct: null,
      performance: slaBreached > 20 ? 72 : slaBreached > 5 ? 84 : 93,
    },
    {
      id: "operations",
      name: "Operations",
      accent: "violet",
      link: "operations-metrics",
      primary: { label: "Active alerts", value: activeAlerts.filter((a) => a.Status === "active").length },
      secondary: { label: "Tasks pending", value: tasksPending },
      pending: [
        { label: "Critical alerts", count: activeAlerts.filter((a) => a.Severity === "critical" && a.Status === "active").length },
        { label: "UW tasks", count: uwTasks },
      ],
      trendPct: null,
      performance: 87,
    },
    {
      id: "hr",
      name: "HR Management",
      accent: "emerald",
      link: "hr-insights",
      primary: { label: "Dept metrics", value: depts.length || "—" },
      secondary: { label: "Source", value: "shared DB" },
      pending: [
        { label: "Open signals", count: activeAlerts.filter((a) => String(a.Department || "").toLowerCase().includes("hr")).length },
        { label: "Tracked rows", count: depts.length },
      ],
      trendPct: null,
      performance: 91,
    },
  ].map((d) => ({ ...d, status: scoreLabel(d.performance) }));

  const departmentPerformance = departments.map((d) => ({
    department: d.name,
    performance: d.performance,
    status: d.status,
  }));

  // System health — live DB ping + Redis/Rabbit config presence
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
  ];

  return {
    heroes: {
      brmAchieved: bookedPremium,
      brmAchievedLabel: "booked production",
      brmPipelineCount: openPipeline,
      brmBookedGp: bookedPremium || pipelinePremium,
      brmBookedLabel: bookedPremium ? "master production" : "open pipeline GP",
      brmNbCount: Number(brmSnap?.cards?.nbCount ?? openPipeline),
      medicalCases: totalCases,
      medicalInReview: inReview,
      pendingApprovals: pendingPack.total,
      urgentApprovals: pendingPack.urgent || medSnap?.cards?.urgentApprovals || 0,
    },
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
    cards: medSnap?.cards || null,
    brmCards: brmSnap?.cards || null,
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
