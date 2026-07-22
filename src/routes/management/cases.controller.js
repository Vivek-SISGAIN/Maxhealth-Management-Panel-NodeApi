const { Router } = require("express");
const { prisma } = require("../../lib/prisma");
const router = Router();

// ─── Transformers ─────────────────────────────────────────────────────────────

const transformTask = (task) => {
  const created = task.CreatedAt ? new Date(task.CreatedAt).getTime() : null;
  const ageDays =
    created != null ? Math.max(0, Math.round((Date.now() - created) / 86400000)) : null;
  return {
    id: task.Id,
    taskType: task.TaskType,
    caseId: task.CaseId,
    policyId: task.PolicyId,
    assignedTo: task.AssignedTo,
    priority: task.Priority,
    status: task.SlaBreach ? "SLA_BREACH" : task.Status,
    slaDeadline: task.SlaDeadline,
    slaBreach: task.SlaBreach,
    ageDays,
    metadata: task.Metadata,
    createdAt: task.CreatedAt,
    updatedAt: task.UpdatedAt,
    completedAt: task.CompletedAt,
  };
};

const transformUnderwritingCase = (uc) => ({
  id: uc.Id,
  caseId: uc.CaseId,
  client: uc.Client,
  broker: uc.Broker,
  policyType: uc.PolicyType,
  memberCount: uc.MemberCount,
  riskScore: uc.RiskScore,
  status: uc.Status,
  result: uc.Result,
  assignedDoctor: uc.AssignedDoctor,
  notes: uc.Notes,
  completedAt: uc.CompletedAt,
  createdAt: uc.CreatedAt,
  updatedAt: uc.UpdatedAt,
});

const transformMember = (m) => ({
  id: m.Id,
  caseId: m.CaseId,
  memberId: m.MemberId,
  name: m.Name,
  age: m.Age,
  gender: m.Gender,
  planCategory: m.PlanCategory,
});

// Attach workbench & members to a case record
const enrichCase = async (uc) => {
  const members = await prisma.underwritingMember.findMany({
    where: { CaseId: uc.Id },
  });

  // Find linked task — CaseId on MedicalTask may be UUID Id or business CaseId
  const task = await prisma.medicalTask.findFirst({
    where: {
      TaskType: "UNDERWRITING",
      OR: [{ CaseId: uc.Id }, { CaseId: uc.CaseId }],
    },
    orderBy: { UpdatedAt: "desc" },
  });

  const workbench = task?.Metadata?.doctorWorkbench || null;

  return {
    ...transformUnderwritingCase(uc),
    members: members.map(transformMember),
    task: task ? transformTask(task) : null,
    workbench,
  };
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /management/cases
 * List all medical cases (UnderwritingCase) with optional filters.
 * Query params: status, result, policyType, broker, page, limit, search
 */
router.get("/cases", async (req, res) => {
  try {
    const {
      status,
      result,
      policyType,
      broker,
      assignedDoctor,
      search,
      dateFrom,
      dateTo,
      page = "1",
      limit = "20",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where = {};
    if (status) where.Status = status;
    if (result) where.Result = result;
    if (policyType) where.PolicyType = policyType;
    if (broker) where.Broker = { contains: broker, mode: "insensitive" };
    if (assignedDoctor) {
      if (assignedDoctor === "unassigned") where.AssignedDoctor = null;
      else where.AssignedDoctor = { contains: assignedDoctor, mode: "insensitive" };
    }
    if (dateFrom || dateTo) {
      where.CreatedAt = {};
      if (dateFrom) where.CreatedAt.gte = new Date(dateFrom);
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        where.CreatedAt.lte = to;
      }
    }
    if (search) {
      where.OR = [
        { CaseId: { contains: search, mode: "insensitive" } },
        { Client: { contains: search, mode: "insensitive" } },
        { Broker: { contains: search, mode: "insensitive" } },
        { AssignedDoctor: { contains: search, mode: "insensitive" } },
      ];
    }

    const [cases, count] = await Promise.all([
      prisma.underwritingCase.findMany({
        where,
        orderBy: { CreatedAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.underwritingCase.count({ where }),
    ]);

    res.json({
      success: true,
      cases: cases.map(transformUnderwritingCase),
      meta: {
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch cases" });
  }
});

/**
 * GET /management/cases/stats
 * Aggregated stats across all cases.
 */
router.get("/cases/stats", async (req, res) => {
  try {
    const [total, newCases, inReview, completed, onHold, approved, rejected, conditional] =
      await Promise.all([
        prisma.underwritingCase.count(),
        prisma.underwritingCase.count({ where: { Status: "NEW" } }),
        prisma.underwritingCase.count({ where: { Status: "IN_REVIEW" } }),
        prisma.underwritingCase.count({ where: { Status: "COMPLETED" } }),
        prisma.underwritingCase.count({ where: { Status: "ON_HOLD" } }),
        prisma.underwritingCase.count({ where: { Result: "APPROVED" } }),
        prisma.underwritingCase.count({ where: { Result: "REJECTED" } }),
        prisma.underwritingCase.count({ where: { Result: "CONDITIONAL" } }),
      ]);

    const totalMembers = await prisma.underwritingMember.count();
    const slaBreached = await prisma.medicalTask.count({
      where: { TaskType: "UNDERWRITING", SlaBreach: true },
    });

    res.json({
      success: true,
      stats: {
        total,
        byStatus: { new: newCases, inReview, completed, onHold },
        byResult: { approved, rejected, conditional },
        totalMembers,
        slaBreached,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch case stats" });
  }
});

/**
 * GET /management/cases/:id
 * Full details of a single case including members, linked task, and workbench data.
 */
router.get("/cases/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let uc = await prisma.underwritingCase.findUnique({ where: { Id: id } });
    if (!uc) {
      uc = await prisma.underwritingCase.findFirst({ where: { CaseId: id } });
    }
    if (!uc) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    res.json({ success: true, data: await enrichCase(uc) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch case" });
  }
});

/**
 * GET /management/cases/:id/members
 * All members belonging to a specific underwriting case.
 */
router.get("/cases/:id/members", async (req, res) => {
  try {
    const uc = await prisma.underwritingCase.findUnique({
      where: { Id: req.params.id },
    });
    if (!uc) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }

    const members = await prisma.underwritingMember.findMany({
      where: { CaseId: req.params.id },
    });

    res.json({ success: true, data: members.map(transformMember) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch members" });
  }
});

/**
 * GET /management/cases/:id/workbench
 * Doctor workbench data for a case (member-level underwriting decisions from task metadata).
 */
router.get("/cases/:id/workbench", async (req, res) => {
  try {
    const id = req.params.id;
    const uc = await prisma.underwritingCase.findFirst({
      where: { OR: [{ Id: id }, { CaseId: id }] },
      select: { Id: true, CaseId: true },
    });
    const caseRefs = uc ? [uc.Id, uc.CaseId].filter(Boolean) : [id];

    const task = await prisma.medicalTask.findFirst({
      where: { TaskType: "UNDERWRITING", CaseId: { in: caseRefs } },
      orderBy: { UpdatedAt: "desc" },
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "No task found for this case" });
    }

    const workbench = task.Metadata?.doctorWorkbench || {};
    const membersData = workbench.members || {};

    // Enrich with DB member names
    const memberIds = Object.keys(membersData);
    const dbMembers = memberIds.length
      ? await prisma.underwritingMember.findMany({ where: { Id: { in: memberIds } } })
      : [];
    const memberMap = new Map(dbMembers.map((m) => [m.Id, m]));

    const enrichedMembers = Object.entries(membersData).map(([memberId, wb]) => ({
      memberId,
      memberName: wb.formSnapshot?.memberName || memberMap.get(memberId)?.Name || "Unknown",
      stage: wb.stage,
      stageUpdatedAt: wb.stageUpdatedAt,
      stageHistory: wb.stageHistory || [],
      riskLevel: wb.riskLevel,
      summary: wb.summary || null,
      clinicalRemarks: wb.clinicalRemarks || null,
      underwritingRemarks: wb.underwritingRemarks || null,
      managementDecision: wb.managementDecision || null,
      documents: wb.documents || [],
    }));

    res.json({
      success: true,
      data: {
        taskId: task.Id,
        caseId: task.CaseId,
        members: enrichedMembers,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch workbench" });
  }
});

/**
 * GET /management/cases/:id/timeline
 * Full audit trail / stage history across all members in a case.
 */
router.get("/cases/:id/timeline", async (req, res) => {
  try {
    const task = await prisma.medicalTask.findFirst({
      where: { CaseId: req.params.id, TaskType: "UNDERWRITING" },
      orderBy: { UpdatedAt: "desc" },
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "No task found for this case" });
    }

    const membersData = task.Metadata?.doctorWorkbench?.members || {};
    const timeline = [];

    for (const [memberId, wb] of Object.entries(membersData)) {
      const memberName = wb.formSnapshot?.memberName || memberId;
      for (const entry of wb.stageHistory || []) {
        timeline.push({
          memberId,
          memberName,
          stage: entry.stage,
          at: entry.at,
          by: entry.by,
          notes: entry.notes || null,
        });
      }
    }

    // Sort by time ascending
    timeline.sort((a, b) => new Date(a.at) - new Date(b.at));

    res.json({ success: true, data: timeline });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch timeline" });
  }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

/**
 * GET /management/tasks
 * All medical tasks with filters: taskType, status, priority, caseId, slaBreach
 */
router.get("/tasks", async (req, res) => {
  try {
    const {
      taskType,
      status,
      priority,
      caseId,
      assignedTo,
      slaBreach,
      page = "1",
      limit = "20",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where = {};
    if (taskType) where.TaskType = taskType;
    if (status === "SLA_BREACH") where.SlaBreach = true;
    else if (status) where.Status = status;
    if (priority) where.Priority = priority;
    if (caseId) where.CaseId = { contains: String(caseId), mode: "insensitive" };
    if (assignedTo) where.AssignedTo = { contains: String(assignedTo), mode: "insensitive" };
    if (slaBreach !== undefined) where.SlaBreach = slaBreach === "true";

    const [tasks, count] = await Promise.all([
      prisma.medicalTask.findMany({
        where,
        orderBy: { UpdatedAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.medicalTask.count({ where }),
    ]);

    const caseRefs = [...new Set(tasks.map((t) => t.CaseId).filter(Boolean))];
    const caseIdMap = new Map();
    if (caseRefs.length) {
      const linked = await prisma.underwritingCase.findMany({
        where: { OR: [{ Id: { in: caseRefs } }, { CaseId: { in: caseRefs } }] },
        select: { Id: true, CaseId: true },
      });
      for (const c of linked) {
        caseIdMap.set(c.Id, c.CaseId);
        caseIdMap.set(c.CaseId, c.CaseId);
      }
    }

    res.json({
      success: true,
      tasks: tasks.map((t) => {
        const mapped = transformTask(t);
        return {
          ...mapped,
          caseId: (t.CaseId && caseIdMap.get(t.CaseId)) || t.CaseId || null,
        };
      }),
      meta: {
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch tasks" });
  }
});

/**
 * GET /management/tasks/stats
 * Task-level stats: by status, by type, SLA breach count.
 */
router.get("/tasks/stats", async (req, res) => {
  try {
    const [total, pending, inProgress, completed, cancelled, slaBreach] = await Promise.all([
      prisma.medicalTask.count(),
      prisma.medicalTask.count({ where: { Status: "PENDING" } }),
      prisma.medicalTask.count({ where: { Status: "IN_PROGRESS" } }),
      prisma.medicalTask.count({ where: { Status: "COMPLETED" } }),
      prisma.medicalTask.count({ where: { Status: "CANCELLED" } }),
      prisma.medicalTask.count({ where: { SlaBreach: true } }),
    ]);

    const byType = await Promise.all(
      ["PREAUTH", "UNDERWRITING", "RENEWAL", "LOADING", "LATE_ADDITION"].map(async (type) => ({
        type,
        count: await prisma.medicalTask.count({ where: { TaskType: type } }),
      }))
    );

    res.json({
      success: true,
      stats: {
        total,
        byStatus: { pending, inProgress, completed, cancelled },
        slaBreach,
        byType: byType.reduce((acc, { type, count }) => ({ ...acc, [type]: count }), {}),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch task stats" });
  }
});

/**
 * GET /management/tasks/:id
 * Single task with full metadata.
 */
router.get("/tasks/:id", async (req, res) => {
  try {
    const task = await prisma.medicalTask.findUnique({ where: { Id: req.params.id } });
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    res.json({ success: true, data: transformTask(task) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch task" });
  }
});

// ─── Members ──────────────────────────────────────────────────────────────────

/**
 * GET /management/members
 * All underwriting members. Filter by caseId.
 */
router.get("/members", async (req, res) => {
  try {
    const { caseId, gender, planCategory, page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const where = {};
    if (caseId) where.CaseId = caseId;
    if (gender) where.Gender = gender;
    if (planCategory) where.PlanCategory = planCategory;

    const [members, count] = await Promise.all([
      prisma.underwritingMember.findMany({
        where,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.underwritingMember.count({ where }),
    ]);

    res.json({
      success: true,
      members: members.map(transformMember),
      meta: {
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch members" });
  }
});

/**
 * GET /management/members/:id
 * Single member with linked case and workbench snapshot.
 */
router.get("/members/:id", async (req, res) => {
  try {
    const member = await prisma.underwritingMember.findUnique({
      where: { Id: req.params.id },
    });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // Fetch workbench data for this member
    const task = await prisma.medicalTask.findFirst({
      where: { CaseId: member.CaseId, TaskType: "UNDERWRITING" },
      orderBy: { UpdatedAt: "desc" },
    });

    const workbench = task?.Metadata?.doctorWorkbench?.members?.[member.Id] || null;

    res.json({
      success: true,
      data: {
        ...transformMember(member),
        workbench,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch member" });
  }
});

module.exports = router;
