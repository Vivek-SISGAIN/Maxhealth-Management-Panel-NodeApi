/**
 * Live management insights — departments / performance / analytics
 * from shared Postgres (BRM + Medical UW + Alerts + optional HRMS tables).
 */
const { PrismaClient } = require("@prisma/client");
const brm = require("./brmInsights.service");
const medical = require("./medicalInsights.service");

const prisma = new PrismaClient();

const SENT = "SENT_FOR_MANAGEMENT_APPROVAL";
const RESUB = "RESUBMITTED";

const scoreLabel = (score) => {
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Good";
  if (score >= 70) return "Warning";
  return "Critical";
};

async function safeHrms() {
  try {
    const [employees, leaves, onboarding] = await Promise.all([
      prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "HrmsEmployee"`),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c FROM "HrmsLeaveRequest" WHERE "Status" IN ('PENDING','Pending','pending')`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c FROM "HrmsOnboarding" WHERE "Stage"::text <> 'COMPLETED' AND "CompletedAt" IS NULL`,
      ),
    ]);
    return {
      available: true,
      employees: employees?.[0]?.c || 0,
      pendingLeaves: leaves?.[0]?.c || 0,
      pendingOnboarding: onboarding?.[0]?.c || 0,
    };
  } catch {
    return { available: false, employees: 0, pendingLeaves: 0, pendingOnboarding: 0 };
  }
}

async function countPendingApprovals() {
  const tasks = await prisma.medicalTask.findMany({
    where: { TaskType: "UNDERWRITING" },
    select: { Metadata: true },
    take: 300,
  });
  let total = 0;
  for (const t of tasks) {
    const members = t.Metadata?.doctorWorkbench?.members || {};
    for (const wb of Object.values(members)) {
      if (!wb || typeof wb !== "object") continue;
      const stage = String(wb.stage || "");
      if (stage === SENT || stage === RESUB) total += 1;
    }
  }
  return total;
}

async function monthBuckets(months = 6) {
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en", { month: "short" }),
      year: d.getFullYear(),
      month: d.getMonth(),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
    });
  }
  return out;
}

async function getDepartmentsLive({ dateFrom, dateTo } = {}) {
  const [brmSnap, medSnap, alerts, hrms, pendingApprovals, slaBreached, uwTasks] =
    await Promise.all([
      brm.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
      medical.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
      prisma.managementAlert.findMany({
        where: { Status: { in: ["active", "acknowledged"] } },
        orderBy: { CreatedAt: "desc" },
        take: 40,
      }),
      safeHrms(),
      countPendingApprovals(),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING", SlaBreach: true } }),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING" } }),
    ]);

  const openPipeline = Number(brmSnap?.cards?.openPipelineCount ?? 0);
  const openPremium = Number(brmSnap?.cards?.openPremium ?? 0);
  const booked = Number(brmSnap?.cards?.bookedPremium ?? 0);
  const renCount = Number(brmSnap?.cards?.renCount ?? 0);
  const brmCount = Number(brmSnap?.cards?.brmCount ?? brmSnap?.executiveCount ?? 0);
  const totalCases = Number(medSnap?.cards?.totalCases ?? 0);
  const inReview = Number(medSnap?.cards?.inReview ?? 0);
  const activeAlerts = alerts.filter((a) => a.Status === "active").length;

  const fmt = (n) =>
    `AED ${Math.round(Number(n) || 0).toLocaleString("en-AE", { maximumFractionDigits: 0 })}`;

  const departments = [
    {
      id: "sales",
      name: "Sales & Marketing",
      accent: "blue",
      link: "brm-new-business",
      status: scoreLabel(Math.min(95, 70 + Math.min(25, openPipeline / 30))),
      performance: Math.min(95, 70 + Math.min(25, openPipeline / 30)),
      metrics: [
        { key: "Open pipeline", value: openPipeline },
        { key: "Pipeline GP", value: fmt(openPremium) },
        { key: "Booked GP", value: fmt(booked) },
        { key: "NB cases", value: Number(brmSnap?.cards?.nbCount ?? 0) },
      ],
      activity: [
        { label: "Open B-cases", count: openPipeline, severity: openPipeline > 100 ? "high" : "medium" },
        { label: "Renewals tracked", count: renCount, severity: "medium" },
      ],
    },
    {
      id: "operations",
      name: "Operations",
      accent: "violet",
      link: "medical-tasks",
      status: scoreLabel(slaBreached > 20 ? 72 : 87),
      performance: slaBreached > 20 ? 72 : 87,
      metrics: [
        { key: "UW tasks", value: uwTasks },
        { key: "SLA breached", value: slaBreached },
        { key: "Active alerts", value: activeAlerts },
        { key: "Pending UW", value: Number(medSnap?.cards?.tasksPending ?? 0) },
      ],
      activity: [
        { label: "SLA reassignment needed", count: slaBreached, severity: slaBreached ? "critical" : "low" },
        { label: "Operational alerts", count: activeAlerts, severity: activeAlerts ? "high" : "low" },
      ],
    },
    {
      id: "brm",
      name: "Business Relationship Mgmt",
      accent: "teal",
      link: "brm-overview",
      status: scoreLabel(Math.min(96, 75 + Math.min(20, brmCount))),
      performance: Math.min(96, 75 + Math.min(20, brmCount)),
      metrics: [
        { key: "Active BRMs", value: brmCount },
        { key: "Open cases", value: openPipeline },
        { key: "Forecast", value: fmt(brmSnap?.cards?.forecastTotal ?? 0) },
        { key: "Renewals", value: renCount },
      ],
      activity: [
        { label: "Pipeline cases", count: openPipeline, severity: "medium" },
        { label: "Executives covered", count: brmCount, severity: "low" },
      ],
    },
    {
      id: "hr",
      name: "HR Management",
      accent: "emerald",
      link: "hr-insights",
      status: hrms.available ? scoreLabel(hrms.pendingLeaves > 20 ? 78 : 91) : "Good",
      performance: hrms.available ? (hrms.pendingLeaves > 20 ? 78 : 91) : 88,
      metrics: [
        { key: "Employees", value: hrms.available ? hrms.employees : "—" },
        { key: "Pending leave", value: hrms.available ? hrms.pendingLeaves : "—" },
        { key: "Onboarding open", value: hrms.available ? hrms.pendingOnboarding : "—" },
        { key: "Source", value: hrms.available ? "HRMS live" : "HRMS unavailable" },
      ],
      activity: [
        { label: "Leave approvals", count: hrms.pendingLeaves, severity: hrms.pendingLeaves ? "medium" : "low" },
        { label: "Onboarding in progress", count: hrms.pendingOnboarding, severity: "medium" },
      ],
    },
    {
      id: "medical",
      name: "Medical Underwriting",
      accent: "cyan",
      link: "medical-overview",
      status: scoreLabel(slaBreached > 15 ? 74 : 92),
      performance: slaBreached > 15 ? 74 : 92,
      metrics: [
        { key: "UW cases", value: totalCases },
        { key: "In review", value: inReview },
        { key: "Pending approvals", value: pendingApprovals },
        { key: "Members in UW", value: Number(medSnap?.cards?.totalMembers ?? 0) },
      ],
      activity: [
        { label: "Awaiting management decision", count: pendingApprovals, severity: pendingApprovals ? "high" : "low" },
        { label: "SLA breached tasks", count: slaBreached, severity: slaBreached ? "critical" : "low" },
      ],
    },
    {
      id: "finance",
      name: "Finance & Accounting",
      accent: "amber",
      link: "analytics",
      status: scoreLabel(booked > 0 ? 85 : 78),
      performance: booked > 0 ? 85 : 78,
      metrics: [
        { key: "Booked production", value: fmt(booked) },
        { key: "Open pipeline GP", value: fmt(openPremium) },
        { key: "Forecast", value: fmt(brmSnap?.cards?.forecastTotal ?? 0) },
        { key: "UW adjusted load", value: pendingApprovals },
      ],
      activity: [
        { label: "Premium decisions pending", count: pendingApprovals, severity: "medium" },
        { label: "Active financial alerts", count: alerts.filter((a) => String(a.Type || "").toLowerCase().includes("financ")).length, severity: "low" },
      ],
    },
  ];

  return {
    departments,
    alerts: alerts.slice(0, 10).map((a) => ({
      id: a.Id,
      title: a.Title,
      message: a.Message,
      severity: a.Severity,
      status: a.Status,
      department: a.Department,
      createdAt: a.CreatedAt,
    })),
    alertCount: activeAlerts,
    hrms,
    summary: {
      departments: departments.length,
      openPipeline,
      pendingApprovals,
      slaBreached,
      employees: hrms.employees,
    },
  };
}

async function getPerformanceLive({ dateFrom, dateTo } = {}) {
  const [brmSnap, medSnap, hrms, pendingApprovals, slaBreached, totalCases, completed] =
    await Promise.all([
      brm.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
      medical.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
      safeHrms(),
      countPendingApprovals(),
      prisma.medicalTask.count({ where: { TaskType: "UNDERWRITING", SlaBreach: true } }),
      prisma.underwritingCase.count(),
      prisma.underwritingCase.count({ where: { Status: "COMPLETED" } }),
    ]);

  const booked = Number(brmSnap?.cards?.bookedPremium ?? 0);
  const openPremium = Number(brmSnap?.cards?.openPremium ?? 0);
  const forecast = Number(brmSnap?.cards?.forecastTotal ?? 0);
  const openPipeline = Number(brmSnap?.cards?.openPipelineCount ?? 0);
  const completionRate = totalCases ? Math.round((completed / totalCases) * 100) : 0;

  const annualTargets = [
    {
      name: "Booked production",
      current: booked,
      target: Math.max(booked * 1.15, forecast || booked * 1.2 || 1),
      unit: "AED",
      owner: "BRM / Sales",
    },
    {
      name: "Open pipeline conversion",
      current: openPipeline,
      target: Math.max(openPipeline, 1),
      unit: "cases",
      owner: "BRM",
    },
    {
      name: "UW completion rate",
      current: completionRate,
      target: 90,
      unit: "%",
      owner: "Medical",
    },
    {
      name: "SLA breach control",
      current: Math.max(0, 100 - Math.min(100, slaBreached * 3)),
      target: 95,
      unit: "%",
      owner: "Operations",
    },
  ].map((t) => ({
    ...t,
    progress: Math.min(100, Math.round((Number(t.current) / Math.max(Number(t.target), 1)) * 100)),
  }));

  const buckets = await monthBuckets(4);
  const start = buckets[0].start;
  const cases = await prisma.underwritingCase.findMany({
    where: { CreatedAt: { gte: start } },
    select: { CreatedAt: true, Status: true },
  });

  const quarterly = buckets.map((b, idx) => {
    const periodCases = cases.filter((c) => {
      const x = new Date(c.CreatedAt);
      return x >= b.start && x <= b.end;
    });
    const done = periodCases.filter((c) => c.Status === "COMPLETED").length;
    return {
      period: b.label,
      label: `M${idx + 1}`,
      medicalCases: periodCases.length,
      completed: done,
      bookedShare: Math.round(booked / Math.max(buckets.length, 1)),
      pipelineShare: Math.round(openPremium / Math.max(buckets.length, 1)),
    };
  });

  const insights = [
    {
      severity: slaBreached > 0 ? "warning" : "info",
      title: "UW SLA watch",
      detail: `${slaBreached} underwriting tasks currently in SLA breach`,
    },
    {
      severity: pendingApprovals > 0 ? "warning" : "success",
      title: "Management approval queue",
      detail: `${pendingApprovals} members awaiting decision`,
    },
    {
      severity: "info",
      title: "BRM forecast",
      detail: `Forecast AED ${Math.round(forecast).toLocaleString("en-AE")} · pipeline AED ${Math.round(openPremium).toLocaleString("en-AE")}`,
    },
    hrms.available
      ? {
          severity: hrms.pendingLeaves > 10 ? "warning" : "success",
          title: "HR capacity",
          detail: `${hrms.employees} employees · ${hrms.pendingLeaves} leave requests · ${hrms.pendingOnboarding} onboarding`,
        }
      : {
          severity: "info",
          title: "HR feed",
          detail: "HRMS tables not reachable from Management DB — connect shared HR schema",
        },
  ];

  const depts = await getDepartmentsLive({ dateFrom, dateTo });

  return {
    annualTargets,
    quarterly,
    competitive: {
      note: "Internal parity only — no invented industry benchmarks",
      rows: [
        { label: "Booked vs Pipeline", us: booked, peer: openPremium },
        { label: "UW completed vs open", us: completed, peer: Math.max(0, totalCases - completed) },
        { label: "Approvals cleared vs pending", us: Number(medSnap?.cards?.byResult?.approved ?? 0), peer: pendingApprovals },
      ],
    },
    departmentPerformance: depts.departments.map((d) => ({
      department: d.name,
      performance: d.performance,
      status: d.status,
    })),
    insights,
    kpis: [
      { name: "Booked Premium", value: String(Math.round(booked)), category: "BRM", trend: "up" },
      { name: "Open Pipeline", value: String(openPipeline), category: "BRM", trend: "up" },
      { name: "UW Cases", value: String(totalCases), category: "Medical", trend: "up" },
      { name: "Pending Approvals", value: String(pendingApprovals), category: "Medical", trend: pendingApprovals ? "down" : "up" },
    ],
  };
}

async function getAnalyticsLive({ dateFrom, dateTo } = {}) {
  const buckets = await monthBuckets(6);
  const start = buckets[0].start;

  const [cases, tasks, brmSnap, hrms, pendingApprovals, alertsActive] = await Promise.all([
    prisma.underwritingCase.findMany({
      where: { CreatedAt: { gte: start } },
      select: { CreatedAt: true, Status: true, Result: true },
    }),
    prisma.medicalTask.findMany({
      where: { TaskType: "UNDERWRITING", CreatedAt: { gte: start } },
      select: { CreatedAt: true, SlaBreach: true, Status: true },
    }),
    brm.getOverviewSnapshot({ dateFrom, dateTo }).catch(() => null),
    safeHrms(),
    countPendingApprovals(),
    prisma.managementAlert.count({ where: { Status: "active" } }),
  ]);

  const trends = buckets.map((b) => {
    const c = cases.filter((x) => {
      const d = new Date(x.CreatedAt);
      return d >= b.start && d <= b.end;
    });
    const t = tasks.filter((x) => {
      const d = new Date(x.CreatedAt);
      return d >= b.start && d <= b.end;
    });
    return {
      period: b.label,
      medicalCases: c.length,
      completed: c.filter((x) => x.Status === "COMPLETED").length,
      slaBreach: t.filter((x) => x.SlaBreach).length,
      approved: c.filter((x) => x.Result === "APPROVED").length,
    };
  });

  const booked = Number(brmSnap?.cards?.bookedPremium ?? 0);
  const openPremium = Number(brmSnap?.cards?.openPremium ?? 0);
  const forecast = Number(brmSnap?.cards?.forecastTotal ?? 0);

  const distribution = [
    { name: "Booked production", value: Math.max(0, Math.round(booked)) },
    { name: "Open pipeline GP", value: Math.max(0, Math.round(openPremium)) },
    { name: "Forecast residual", value: Math.max(0, Math.round(forecast - booked)) },
  ];

  const performance = [
    { name: "Medical UW", score: Math.min(99, 70 + Math.min(25, cases.length)) },
    { name: "BRM pipeline", score: Math.min(99, 65 + Math.min(30, Number(brmSnap?.cards?.openPipelineCount || 0) / 40)) },
    { name: "Approvals queue", score: Math.max(40, 100 - pendingApprovals * 2) },
    { name: "SLA control", score: Math.max(40, 100 - tasks.filter((t) => t.SlaBreach).length * 3) },
    { name: "HR capacity", score: hrms.available ? Math.max(50, 95 - hrms.pendingLeaves) : 70 },
    { name: "Alert hygiene", score: Math.max(50, 100 - alertsActive * 5) },
  ];

  const kpis = [
    { name: "Booked GP", value: booked, format: "aed" },
    { name: "Open Pipeline", value: Number(brmSnap?.cards?.openPipelineCount ?? 0), format: "number" },
    { name: "UW Cases (6m)", value: cases.length, format: "number" },
    { name: "Pending Approvals", value: pendingApprovals, format: "number" },
    { name: "Active Alerts", value: alertsActive, format: "number" },
    { name: "Employees", value: hrms.available ? hrms.employees : null, format: "number" },
  ];

  return {
    period: "monthly",
    kpis,
    trends,
    distribution,
    performance,
    revenue: trends.map((t, i) => ({
      period: t.period,
      bookedShare: Math.round(booked / Math.max(trends.length, 1)),
      pipelineShare: Math.round(openPremium / Math.max(trends.length, 1)),
      medicalCases: t.medicalCases,
      index: i,
    })),
    source: "live",
  };
}

module.exports = {
  getDepartmentsLive,
  getPerformanceLive,
  getAnalyticsLive,
  safeHrms,
  countPendingApprovals,
};
