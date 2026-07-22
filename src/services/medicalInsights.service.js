/**
 * Management Medical Insights — aggregated UW / workbench / SLA views.
 * Source: shared UnderwritingCase + MedicalTask (doctorWorkbench in Metadata).
 */
const { prisma } = require("../lib/prisma");

const toNumber = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const daysBetween = (from, to = new Date()) => {
  if (!from) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
};

async function getFilterOptions() {
  const [cases, tasks] = await Promise.all([
    prisma.underwritingCase.findMany({
      select: { Broker: true, AssignedDoctor: true },
      take: 2000,
      orderBy: { UpdatedAt: "desc" },
    }),
    prisma.medicalTask.findMany({
      where: { TaskType: "UNDERWRITING" },
      select: { Priority: true, AssignedTo: true },
      take: 2000,
    }),
  ]);

  const brokers = [
    ...new Set(cases.map((c) => c.Broker).filter((b) => b && String(b).trim())),
  ].sort((a, b) => a.localeCompare(b));

  const doctors = [
    ...new Set(
      [
        ...cases.map((c) => c.AssignedDoctor),
        ...tasks.map((t) => t.AssignedTo),
      ].filter((d) => d && String(d).trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const priorities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  return { brokers, doctors, priorities };
}

async function getDoctorLoad() {
  const activeStatuses = ["NEW", "IN_REVIEW", "ON_HOLD"];
  const cases = await prisma.underwritingCase.findMany({
    where: { Status: { in: activeStatuses } },
    select: {
      AssignedDoctor: true,
      CreatedAt: true,
      UpdatedAt: true,
      Status: true,
    },
  });

  const map = new Map();
  for (const c of cases) {
    const key = c.AssignedDoctor && String(c.AssignedDoctor).trim() ? c.AssignedDoctor.trim() : "__unassigned__";
    if (!map.has(key)) {
      map.set(key, { name: key === "__unassigned__" ? "Unassigned" : key, cases: [], unassigned: key === "__unassigned__" });
    }
    map.get(key).cases.push(c);
  }

  const maxLoad = Math.max(1, ...[...map.values()].map((g) => g.cases.length));

  return [...map.values()]
    .map((g) => {
      const tats = g.cases
        .map((c) => daysBetween(c.CreatedAt, c.UpdatedAt || new Date()))
        .filter((d) => d != null);
      const avgTatDays =
        tats.length > 0 ? Math.round((tats.reduce((a, b) => a + b, 0) / tats.length) * 10) / 10 : 0;
      const oldestDays = g.cases.reduce((max, c) => {
        const d = daysBetween(c.CreatedAt) || 0;
        return Math.max(max, d);
      }, 0);
      return {
        name: g.name,
        unassigned: g.unassigned,
        activeCases: g.cases.length,
        avgTatDays,
        oldestDays,
        loadPct: Math.min(100, Math.round((g.cases.length / maxLoad) * 100)),
      };
    })
    .sort((a, b) => b.activeCases - a.activeCases)
    .slice(0, 8);
}

async function getTrends(months = 6) {
  const start = new Date();
  start.setMonth(start.getMonth() - (months - 1));
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const [cases, breached] = await Promise.all([
    prisma.underwritingCase.findMany({
      where: { CreatedAt: { gte: start } },
      select: { CreatedAt: true },
    }),
    prisma.medicalTask.findMany({
      where: {
        TaskType: "UNDERWRITING",
        SlaBreach: true,
        CreatedAt: { gte: start },
      },
      select: { CreatedAt: true },
    }),
  ]);

  const bucket = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
  };

  const map = new Map();
  for (let i = 0; i < months; i++) {
    const d = new Date(start);
    d.setMonth(start.getMonth() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    map.set(key, { period: key, caseCount: 0, slaBreach: 0 });
  }
  for (const c of cases) {
    const k = bucket(c.CreatedAt);
    if (map.has(k)) map.get(k).caseCount += 1;
  }
  for (const t of breached) {
    const k = bucket(t.CreatedAt);
    if (map.has(k)) map.get(k).slaBreach += 1;
  }

  return [...map.values()];
}

async function getOverviewSnapshot({
  status,
  priority,
  broker,
  assignedDoctor,
  dateFrom,
  dateTo,
} = {}) {
  const caseWhere = {};
  if (status && status !== "all") caseWhere.Status = status;
  if (broker && broker !== "all") caseWhere.Broker = { contains: broker, mode: "insensitive" };
  if (assignedDoctor && assignedDoctor !== "all") {
    if (assignedDoctor === "unassigned") {
      caseWhere.OR = [
        { AssignedDoctor: null },
        { AssignedDoctor: "" },
      ];
    } else {
      caseWhere.AssignedDoctor = { equals: assignedDoctor, mode: "insensitive" };
    }
  }
  if (dateFrom || dateTo) {
    caseWhere.CreatedAt = {};
    if (dateFrom) caseWhere.CreatedAt.gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      caseWhere.CreatedAt.lte = to;
    }
  }

  const taskWhere = { TaskType: "UNDERWRITING" };
  if (priority && priority !== "all") taskWhere.Priority = priority;
  if (assignedDoctor && assignedDoctor !== "all" && assignedDoctor !== "unassigned") {
    taskWhere.AssignedTo = assignedDoctor;
  }

  const [
    total,
    newCases,
    inReview,
    completed,
    onHold,
    approved,
    rejected,
    conditional,
    totalMembers,
    slaBreached,
    uwTasks,
    pendingTasks,
    inProgressTasks,
    recentCases,
    slaRiskTasks,
    doctorLoad,
    trends,
    filterOptions,
    approvalPending,
  ] = await Promise.all([
    prisma.underwritingCase.count({ where: caseWhere }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Status: "NEW" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Status: "IN_REVIEW" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Status: "COMPLETED" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Status: "ON_HOLD" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Result: "APPROVED" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Result: "REJECTED" } }),
    prisma.underwritingCase.count({ where: { ...caseWhere, Result: "CONDITIONAL" } }),
    prisma.underwritingMember.count(),
    prisma.medicalTask.count({ where: { ...taskWhere, SlaBreach: true } }),
    prisma.medicalTask.count({ where: taskWhere }),
    prisma.medicalTask.count({ where: { ...taskWhere, Status: "PENDING" } }),
    prisma.medicalTask.count({ where: { ...taskWhere, Status: "IN_PROGRESS" } }),
    prisma.underwritingCase.findMany({
      where: caseWhere,
      orderBy: { UpdatedAt: "desc" },
      take: 12,
    }),
    prisma.medicalTask.findMany({
      where: { ...taskWhere, SlaBreach: true },
      orderBy: { SlaDeadline: "asc" },
      take: 12,
    }),
    getDoctorLoad(),
    getTrends(6),
    getFilterOptions(),
    // Approximate pending mgmt approvals via tasks that have SENT_FOR_MANAGEMENT_APPROVAL in metadata
    prisma.medicalTask.findMany({
      where: { TaskType: "UNDERWRITING" },
      select: { Id: true, CaseId: true, Metadata: true, UpdatedAt: true, Priority: true },
      take: 200,
      orderBy: { UpdatedAt: "desc" },
    }),
  ]);

  const pendingApprovals = [];
  let urgentApprovals = 0;
  const rawPending = [];
  for (const task of approvalPending) {
    const members = task.Metadata?.doctorWorkbench?.members || {};
    for (const [memberId, wb] of Object.entries(members)) {
      if (!wb || typeof wb !== "object") continue;
      const stage = String(wb.stage || "");
      if (stage !== "SENT_FOR_MANAGEMENT_APPROVAL" && stage !== "RESUBMITTED") continue;
      const summary = wb.summary || {};
      const snap = wb.formSnapshot || {};
      rawPending.push({
        id: `${task.Id}:${memberId}`,
        taskId: task.Id,
        rawCaseId: task.CaseId,
        memberId,
        memberName: snap.memberName || snap.name || null,
        memberAge: snap.age ?? snap.memberAge ?? null,
        priority: String(task.Priority || "MEDIUM").toLowerCase(),
        status: "pending",
        amount: summary.adjustedPremium ?? summary.annualPremium ?? null,
        submittedDate: wb.stageUpdatedAt || task.UpdatedAt,
      });
      if (String(task.Priority).toUpperCase() === "CRITICAL" || String(task.Priority).toUpperCase() === "HIGH") {
        urgentApprovals += 1;
      }
    }
  }

  const uniqueCaseRefs = [
    ...new Set([
      ...rawPending.map((p) => p.rawCaseId),
      ...slaRiskTasks.map((t) => t.CaseId),
    ].filter(Boolean)),
  ];
  const caseIdMap = new Map();
  if (uniqueCaseRefs.length) {
    const linked = await prisma.underwritingCase.findMany({
      where: {
        OR: [{ Id: { in: uniqueCaseRefs } }, { CaseId: { in: uniqueCaseRefs } }],
      },
      select: { Id: true, CaseId: true },
    });
    for (const c of linked) {
      caseIdMap.set(c.Id, c.CaseId);
      caseIdMap.set(c.CaseId, c.CaseId);
    }
  }

  const uniqueMemberRefs = [...new Set(rawPending.map((p) => p.memberId).filter(Boolean))];
  const memberMap = new Map();
  if (uniqueMemberRefs.length) {
    const dbMembers = await prisma.underwritingMember.findMany({
      where: {
        OR: [{ Id: { in: uniqueMemberRefs } }, { MemberId: { in: uniqueMemberRefs } }],
      },
      select: { Id: true, MemberId: true, Name: true, Age: true },
    });
    for (const m of dbMembers) {
      memberMap.set(m.Id, m);
      if (m.MemberId) memberMap.set(m.MemberId, m);
    }
  }

  for (const p of rawPending) {
    const dbm = memberMap.get(p.memberId);
    const name = p.memberName || dbm?.Name || null;
    const age = p.memberAge ?? dbm?.Age ?? null;
    pendingApprovals.push({
      id: p.id,
      taskId: p.taskId,
      caseId: (p.rawCaseId && caseIdMap.get(p.rawCaseId)) || p.rawCaseId || "—",
      memberId: dbm?.MemberId || p.memberId,
      memberName: name || "Unknown member",
      memberAge: age,
      priority: p.priority,
      status: p.status,
      amount: p.amount,
      submittedDate: p.submittedDate,
    });
  }

  return {
    cards: {
      totalCases: total,
      inReview,
      newCases,
      totalMembers,
      slaBreached,
      pendingApprovals: pendingApprovals.length,
      urgentApprovals,
      byResult: { approved, rejected, conditional },
      byStatus: { new: newCases, inReview, completed, onHold },
      uwTasks,
      tasksPending: pendingTasks,
      tasksInProgress: inProgressTasks,
    },
    doctorLoad,
    recentCases: recentCases.map((uc) => ({
      id: uc.Id,
      caseId: uc.CaseId,
      client: uc.Client,
      broker: uc.Broker,
      policyType: uc.PolicyType,
      memberCount: uc.MemberCount,
      status: uc.Status,
      result: uc.Result,
      assignedDoctor: uc.AssignedDoctor,
      updatedAt: uc.UpdatedAt,
      createdAt: uc.CreatedAt,
    })),
    pendingApprovals: pendingApprovals.slice(0, 12),
    slaRiskTasks: slaRiskTasks.map((t) => ({
      id: t.Id,
      caseId: (t.CaseId && caseIdMap.get(t.CaseId)) || t.CaseId || "—",
      caseRef: t.CaseId,
      priority: t.Priority,
      status: t.SlaBreach ? "SLA_BREACH" : t.Status,
      assignedTo: t.AssignedTo || "—",
      ageDays: daysBetween(t.CreatedAt),
      slaDeadline: t.SlaDeadline,
      createdAt: t.CreatedAt,
    })),
    trends,
    filterOptions,
    decisionMixTotal: total,
  };
}

module.exports = {
  getOverviewSnapshot,
  getFilterOptions,
  getDoctorLoad,
  daysBetween,
};
