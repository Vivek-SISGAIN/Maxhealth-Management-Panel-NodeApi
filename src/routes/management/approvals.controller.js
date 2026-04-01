const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

const MEDICAL_STAGES = {
  SENT_FOR_APPROVAL: "SENT_FOR_MANAGEMENT_APPROVAL",
  RESUBMITTED: "RESUBMITTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

const isPendingManagementStage = (stage) =>
  stage === MEDICAL_STAGES.SENT_FOR_APPROVAL || stage === MEDICAL_STAGES.RESUBMITTED;

const stageToStatus = (stage) => {
  if (stage === MEDICAL_STAGES.APPROVED) return "approved";
  if (stage === MEDICAL_STAGES.REJECTED) return "rejected";
  return "pending";
};

const buildApprovalId = (taskId, memberId) => `${taskId}:${memberId}`;
const parseApprovalId = (id) => {
  const [taskId, memberId] = String(id || "").split(":");
  return { taskId, memberId };
};

// Transform database fields to frontend format
const transformApproval = (approval) => ({
  id: approval.Id || approval.ApprovalCode,
  approvalCode: approval.ApprovalCode,
  type: approval.Type,
  department: approval.Department,
  requestor: approval.Requestor,
  requestorId: approval.RequestorId,
  description: approval.Description,
  details: approval.Details,
  amount: approval.Amount,
  priority: approval.Priority || "medium",
  status: approval.Status,
  dueDate: approval.DueDate ? new Date(approval.DueDate).toLocaleDateString() : "N/A",
  submittedDate: approval.SubmittedDate,
  decidedBy: approval.DecidedBy,
  decidedAt: approval.DecidedAt,
  rejectionNotes: approval.RejectionNotes,
  icon: approval.Type === "Variation Approval" ? "FileText" : 
        approval.Type === "Pre-authorization" ? "Shield" :
        approval.Type === "Budget Approval" ? "CreditCard" :
        approval.Type === "Employee Hiring" ? "UserPlus" : "TrendingUp"
});

const transformMedicalApproval = (item) => {
  const summary = item.workbench.summary || {};
  const adjustedPremium = Number(summary.adjustedPremium || 0);
  const clinicalNotes = item.workbench.underwritingRemarks || item.workbench.clinicalRemarks || "";
  const urgency = adjustedPremium > 200000 ? "urgent" : adjustedPremium > 100000 ? "high" : "medium";

  return {
    id: buildApprovalId(item.task.Id, item.memberId),
    approvalCode: item.underwritingCase?.CaseId || item.task.CaseId,
    referenceId: item.underwritingCase?.Id || item.task.CaseId,
    type: "Medical Underwriting Approval",
    department: "Medical Underwriting",
    requestor: item.workbench.stageHistory?.[0]?.by || "medical",
    requestorId: item.workbench.stageHistory?.[0]?.by || null,
    description: `Underwriting decision required for ${item.memberName || "member"}`,
    details: clinicalNotes || "Medical underwriting case submitted to management for decision.",
    amount: adjustedPremium ? `AED ${adjustedPremium.toLocaleString("en-AE", { maximumFractionDigits: 0 })}` : null,
    priority: urgency,
    status: stageToStatus(item.workbench.stage),
    dueDate: item.task.SlaDeadline ? new Date(item.task.SlaDeadline).toLocaleDateString() : "N/A",
    submittedDate: item.workbench.stageUpdatedAt || item.task.UpdatedAt,
    decidedBy: item.workbench?.managementDecision?.by || null,
    decidedAt: item.workbench?.managementDecision?.at || null,
    rejectionNotes: item.workbench?.managementDecision?.decision === "REJECTED" ? (item.workbench?.managementDecision?.notes || null) : null,
    icon: "Shield",
    source: "medical_workbench",
    taskId: item.task.Id,
    caseId: item.task.CaseId,
    memberId: item.memberId,
    memberName: item.memberName || item.underwritingMember?.Name || "Unknown",
    workbenchStage: item.workbench.stage,
    summary: {
      annualPremium: Number(summary.annualPremium || 0),
      medicalServicesCharges: Number(summary.medicalServicesCharges || 0),
      complicationPercent: Number(summary.complicationPercent || 0),
      complicationAmount: Number(summary.complicationAmount || 0),
      totalLoad: Number(summary.totalLoad || 0),
      adjustedPremium,
    },
  };
};

async function fetchMedicalApprovals(options = {}) {
  const { status } = options;
  const want =
    status && status !== "all"
      ? String(status).toLowerCase()
      : null;

  const stageFilter = (stage) => {
    if (!want) return true;
    if (want === "pending") return isPendingManagementStage(stage);
    if (want === "approved") return stage === MEDICAL_STAGES.APPROVED;
    if (want === "rejected") return stage === MEDICAL_STAGES.REJECTED;
    return true;
  };

  const tasks = await prisma.medicalTask.findMany({
    where: {
      TaskType: "UNDERWRITING",
    },
    orderBy: { UpdatedAt: "desc" },
  });

  const caseIds = [...new Set(tasks.map((t) => t.CaseId).filter(Boolean))];
  const underwritingCases = caseIds.length
    ? await prisma.underwritingCase.findMany({ where: { Id: { in: caseIds } } })
    : [];

  const underwritingMap = new Map(underwritingCases.map((c) => [c.Id, c]));

  const memberIdsSet = new Set();
  const items = [];
  for (const task of tasks) {
    const members = task?.Metadata?.doctorWorkbench?.members;
    if (!members || typeof members !== "object") continue;

    for (const [memberId, workbench] of Object.entries(members)) {
      if (!workbench || typeof workbench !== "object") continue;
      if (!stageFilter(workbench.stage)) continue;

      memberIdsSet.add(memberId);
      items.push({
        task,
        underwritingCase: underwritingMap.get(task.CaseId) || null,
        memberId,
        memberName: workbench.formSnapshot?.memberName || null,
        workbench,
      });
    }
  }

  const memberIds = [...memberIdsSet];
  const underwritingMembers = memberIds.length
    ? await prisma.underwritingMember.findMany({ where: { Id: { in: memberIds } } })
    : [];
  const memberMap = new Map(underwritingMembers.map((m) => [m.Id, m]));

  return items.map((i) => ({ ...i, underwritingMember: memberMap.get(i.memberId) || null }));
}

router.get("/approvals", async (req, res) => {
  try {
    const { status, priority, department, search, source = "medical", page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    if (source === "legacy") {
      const where = {};
      if (status) where.Status = status;
      if (priority) where.Priority = priority;
      if (department) where.Department = department;
      if (search) where.Description = { contains: search, mode: "insensitive" };

      const approvals = await prisma.managementApproval.findMany({
        where,
        orderBy: { SubmittedDate: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      });
      const count = await prisma.managementApproval.count({ where });

      return res.json({
        success: true,
        approvals: approvals.map(transformApproval),
        meta: { total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil(count / limitNum) },
      });
    }

    const all = await fetchMedicalApprovals({ status: status || "pending" });
    let mapped = all.map(transformMedicalApproval);

    if (status && String(status).toLowerCase() !== "all") {
      mapped = mapped.filter((a) => a.status === String(status).toLowerCase());
    }
    if (priority) mapped = mapped.filter((a) => a.priority === String(priority).toLowerCase());
    if (department) mapped = mapped.filter((a) => a.department === department);
    if (search) {
      const s = String(search).toLowerCase();
      mapped = mapped.filter((a) =>
        [a.approvalCode, a.description, a.memberName, a.details].some((v) =>
          String(v || "").toLowerCase().includes(s)
        )
      );
    }

    const count = mapped.length;
    const paged = mapped.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    res.json({
      success: true,
      approvals: paged,
      meta: { total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil(count / limitNum) || 1 },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch approvals" });
  }
});

router.get("/approvals/stats", async (req, res) => {
  try {
    const all = await fetchMedicalApprovals({ status: "all" });
    const mapped = all.map(transformMedicalApproval);
    const pending = mapped.filter((a) => a.status === "pending").length;
    const approved = mapped.filter((a) => a.status === "approved").length;
    const rejected = mapped.filter((a) => a.status === "rejected").length;
    const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const todayApprovals = mapped.filter((a) => a.decidedAt && new Date(a.decidedAt).getTime() >= today).length;

    res.json({
      success: true,
      totalPending: pending,
      totalApproved: approved,
      totalRejected: rejected,
      urgentRequests: mapped.filter((i) => i.status === "pending" && Number(i?.summary?.adjustedPremium || 0) > 200000).length,
      todayApprovals,
      avgProcessingTime: "2.5 days",
      departmentStats: [
        { department: "Medical Underwriting", pending, approved, rejected, avgTime: "2.5 days" },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

router.get("/approvals/:id", async (req, res) => {
  try {
    const { source = "medical" } = req.query;

    if (source === "legacy") {
      const approval = await prisma.managementApproval.findUnique({ where: { Id: req.params.id } });
      if (!approval) {
        res.status(404).json({ success: false, message: "Approval not found" });
        return;
      }
      res.json({ success: true, data: transformApproval(approval) });
      return;
    }

    const { taskId, memberId } = parseApprovalId(req.params.id);
    if (!taskId || !memberId) {
      res.status(400).json({ success: false, message: "Invalid approval id. Use taskId:memberId" });
      return;
    }

    const task = await prisma.medicalTask.findUnique({ where: { Id: taskId } });
    if (!task) {
      res.status(404).json({ success: false, message: "Medical task not found" });
      return;
    }

    const members = task?.Metadata?.doctorWorkbench?.members || {};
    const workbench = members[memberId];
    if (!workbench) {
      res.status(404).json({ success: false, message: "Member workbench record not found" });
      return;
    }

    const [underwritingCase, underwritingMember] = await Promise.all([
      task.CaseId ? prisma.underwritingCase.findUnique({ where: { Id: task.CaseId } }) : Promise.resolve(null),
      prisma.underwritingMember.findUnique({ where: { Id: memberId } }),
    ]);

    res.json({
      success: true,
      data: {
        ...transformMedicalApproval({
          task,
          memberId,
          underwritingCase,
          underwritingMember,
          memberName: underwritingMember?.Name || null,
          workbench,
        }),
        workbench: {
          stage: workbench.stage,
          stageUpdatedAt: workbench.stageUpdatedAt,
          stageHistory: workbench.stageHistory || [],
          messages: workbench.messages || [],
          riskLevel: workbench.riskLevel,
          clinicalRemarks: workbench.clinicalRemarks || null,
          underwritingRemarks: workbench.underwritingRemarks || null,
          summary: workbench.summary || null,
          chargesBreakdown: workbench.chargesBreakdown || null,
          documents: workbench.documents || [],
          formSnapshot: workbench.formSnapshot || null,
          managementDecision: workbench.managementDecision || null,
        },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch approval" });
  }
});

router.post("/approvals", async (req, res) => {
  try {
    const { type, department, requestor, requestorId, description, details, amount, priority, dueDate, metadata } = req.body;
    const count = await prisma.managementApproval.count();
    const approvalCode = `APV-${String(count + 1).padStart(3, '0')}`;
    const newApproval = await prisma.managementApproval.create({
      data: { ApprovalCode: approvalCode, Type: type, Department: department, Requestor: requestor, RequestorId: requestorId, Description: description, Details: details, Amount: amount, Priority: priority || 'medium', Status: 'pending', DueDate: dueDate ? new Date(dueDate) : null, Metadata: metadata }
    });
    res.status(201).json({ success: true, data: transformApproval(newApproval) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to create approval" });
  }
});

router.patch("/approvals/:id/approve", async (req, res) => {
  try {
    const { taskId, memberId } = parseApprovalId(req.params.id);
    if (!taskId || !memberId) {
      return res.status(400).json({ success: false, message: "Invalid approval id. Use taskId:memberId" });
    }

    const task = await prisma.medicalTask.findUnique({ where: { Id: taskId } });
    if (!task) {
      return res.status(404).json({ success: false, message: "Medical task not found" });
    }

    const members = task?.Metadata?.doctorWorkbench?.members || {};
    const member = members[memberId];
    if (!member) {
      return res.status(404).json({ success: false, message: "Member workbench record not found" });
    }

    const stage = MEDICAL_STAGES.APPROVED;
    const decidedBy = req.body.decidedBy || "management";
    const at = new Date().toISOString();
    const nextMember = {
      ...member,
      stage,
      stageUpdatedAt: at,
      stageHistory: [...(member.stageHistory || []), { stage, at, by: decidedBy, notes: req.body.notes || null }],
      messages: [
        ...(member.messages || []),
        { direction: "MANAGEMENT_TO_MEDICAL_UW", at, by: decidedBy, notes: req.body.notes || null, decision: "APPROVED" },
      ],
      managementDecision: { decision: "APPROVED", notes: req.body.notes || null, at, by: decidedBy },
    };

    const updated = await prisma.medicalTask.update({
      where: { Id: taskId },
      data: {
        Metadata: {
          ...(task.Metadata || {}),
          doctorWorkbench: {
            ...((task.Metadata || {}).doctorWorkbench || {}),
            members: { ...members, [memberId]: nextMember },
          },
        },
      },
    });

    res.json({ success: true, data: transformMedicalApproval({ task: updated, memberId, memberName: member.formSnapshot?.memberName, workbench: nextMember }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to approve" });
  }
});

router.patch("/approvals/:id/reject", async (req, res) => {
  try {
    const { taskId, memberId } = parseApprovalId(req.params.id);
    if (!taskId || !memberId) {
      return res.status(400).json({ success: false, message: "Invalid approval id. Use taskId:memberId" });
    }

    const task = await prisma.medicalTask.findUnique({ where: { Id: taskId } });
    if (!task) {
      return res.status(404).json({ success: false, message: "Medical task not found" });
    }

    const members = task?.Metadata?.doctorWorkbench?.members || {};
    const member = members[memberId];
    if (!member) {
      return res.status(404).json({ success: false, message: "Member workbench record not found" });
    }

    const stage = MEDICAL_STAGES.REJECTED;
    const decidedBy = req.body.decidedBy || "management";
    const at = new Date().toISOString();
    const nextMember = {
      ...member,
      stage,
      stageUpdatedAt: at,
      stageHistory: [...(member.stageHistory || []), { stage, at, by: decidedBy, notes: req.body.notes || null }],
      messages: [
        ...(member.messages || []),
        { direction: "MANAGEMENT_TO_MEDICAL_UW", at, by: decidedBy, notes: req.body.notes || null, decision: "REJECTED" },
      ],
      managementDecision: { decision: "REJECTED", notes: req.body.notes || null, at, by: decidedBy },
    };

    const updated = await prisma.medicalTask.update({
      where: { Id: taskId },
      data: {
        Metadata: {
          ...(task.Metadata || {}),
          doctorWorkbench: {
            ...((task.Metadata || {}).doctorWorkbench || {}),
            members: { ...members, [memberId]: nextMember },
          },
        },
      },
    });

    res.json({ success: true, data: transformMedicalApproval({ task: updated, memberId, memberName: member.formSnapshot?.memberName, workbench: nextMember }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to reject" });
  }
});

router.get("/approvals/document-access", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, message: "Query param 'url' is required" });
    }

    const medicalBase = process.env.MEDICAL_API_BASE_URL || "http://localhost:2808";
    const upstream = `${medicalBase}/medical/underwriting/documents/access?url=${encodeURIComponent(url)}`;
    const response = await fetch(upstream);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: data?.message || "Failed to generate document access URL",
      });
    }

    res.json({ success: true, accessUrl: data?.accessUrl || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to access document" });
  }
});

module.exports = router;