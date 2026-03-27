import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { managementApprovalsTable } from "@workspace/db/schema";
import { desc, eq, and, gte, lte, ilike, count, sql } from "drizzle-orm";
import { emitToManagement } from "../../lib/socket";
import { publishManagementEvent } from "../../lib/rabbitmq";

const router: IRouter = Router();

router.get("/approvals", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      status,
      priority,
      department,
      dateFrom,
      dateTo,
      search,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [
      ...(status ? [eq(managementApprovalsTable.status, status as any)] : []),
      ...(priority ? [eq(managementApprovalsTable.priority, priority as any)] : []),
      ...(department ? [eq(managementApprovalsTable.department, department)] : []),
      ...(dateFrom ? [gte(managementApprovalsTable.submittedDate, new Date(dateFrom))] : []),
      ...(dateTo ? [lte(managementApprovalsTable.submittedDate, new Date(dateTo))] : []),
      ...(search ? [ilike(managementApprovalsTable.description, `%${search}%`)] : []),
    ];

    const where = conditions.length ? and(...conditions) : undefined;

    const [totalResult] = await db
      .select({ count: count() })
      .from(managementApprovalsTable)
      .where(where);

    const approvals = await db
      .select()
      .from(managementApprovalsTable)
      .where(where)
      .orderBy(desc(managementApprovalsTable.submittedDate))
      .limit(limitNum)
      .offset(offset);

    res.json({
      success: true,
      data: approvals,
      meta: {
        total: totalResult.count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(Number(totalResult.count) / limitNum),
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching approvals");
    res.status(500).json({ success: false, message: "Failed to fetch approvals" });
  }
});

router.get("/approvals/stats", async (_req: Request, res: Response): Promise<void> => {
  try {
    const [stats] = await db
      .select({
        total: count(),
        pending: sql<number>`count(*) filter (where status = 'pending')`,
        approved: sql<number>`count(*) filter (where status = 'approved')`,
        rejected: sql<number>`count(*) filter (where status = 'rejected')`,
        urgent: sql<number>`count(*) filter (where priority = 'urgent' and status = 'pending')`,
        high: sql<number>`count(*) filter (where priority = 'high' and status = 'pending')`,
      })
      .from(managementApprovalsTable);

    res.json({ success: true, data: stats });
  } catch (err) {
    _req.log.error({ err }, "Error fetching approval stats");
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

router.get("/approvals/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const [approval] = await db
      .select()
      .from(managementApprovalsTable)
      .where(eq(managementApprovalsTable.id, id));

    if (!approval) {
      res.status(404).json({ success: false, message: "Approval not found" });
      return;
    }

    res.json({ success: true, data: approval });
  } catch (err) {
    req.log.error({ err }, "Error fetching approval");
    res.status(500).json({ success: false, message: "Failed to fetch approval" });
  }
});

router.post("/approvals", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      type,
      department,
      requestor,
      requestorId,
      description,
      details,
      amount,
      priority = "medium",
      dueDate,
      metadata,
    } = req.body;

    if (!type || !department || !requestor || !description) {
      res.status(400).json({
        success: false,
        message: "type, department, requestor, description are required",
      });
      return;
    }

    const approvalCode = `APV-${Date.now().toString(36).toUpperCase()}`;

    const [approval] = await db
      .insert(managementApprovalsTable)
      .values({
        approvalCode,
        type,
        department,
        requestor,
        requestorId,
        description,
        details,
        amount,
        priority,
        status: "pending",
        dueDate: dueDate ? new Date(dueDate) : undefined,
        metadata,
      })
      .returning();

    emitToManagement("management:approval:new", approval);
    publishManagementEvent("management.approval.created", approval);

    res.status(201).json({ success: true, data: approval });
  } catch (err) {
    req.log.error({ err }, "Error creating approval");
    res.status(500).json({ success: false, message: "Failed to create approval" });
  }
});

router.patch("/approvals/:id/approve", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { decidedBy = "management", notes } = req.body;

    const [existing] = await db
      .select()
      .from(managementApprovalsTable)
      .where(eq(managementApprovalsTable.id, id));

    if (!existing) {
      res.status(404).json({ success: false, message: "Approval not found" });
      return;
    }

    if (existing.status !== "pending") {
      res.status(400).json({ success: false, message: `Approval is already ${existing.status}` });
      return;
    }

    const [updated] = await db
      .update(managementApprovalsTable)
      .set({
        status: "approved",
        decidedBy,
        decidedAt: new Date(),
        updatedAt: new Date(),
        ...(notes ? { rejectionNotes: notes } : {}),
      })
      .where(eq(managementApprovalsTable.id, id))
      .returning();

    emitToManagement("management:approval:updated", { ...updated, action: "approved" });
    publishManagementEvent("management.approval.approved", updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    req.log.error({ err }, "Error approving request");
    res.status(500).json({ success: false, message: "Failed to approve request" });
  }
});

router.patch("/approvals/:id/reject", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { decidedBy = "management", notes } = req.body;

    const [existing] = await db
      .select()
      .from(managementApprovalsTable)
      .where(eq(managementApprovalsTable.id, id));

    if (!existing) {
      res.status(404).json({ success: false, message: "Approval not found" });
      return;
    }

    if (existing.status !== "pending") {
      res.status(400).json({ success: false, message: `Approval is already ${existing.status}` });
      return;
    }

    const [updated] = await db
      .update(managementApprovalsTable)
      .set({
        status: "rejected",
        decidedBy,
        decidedAt: new Date(),
        rejectionNotes: notes,
        updatedAt: new Date(),
      })
      .where(eq(managementApprovalsTable.id, id))
      .returning();

    emitToManagement("management:approval:updated", { ...updated, action: "rejected" });
    publishManagementEvent("management.approval.rejected", updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    req.log.error({ err }, "Error rejecting request");
    res.status(500).json({ success: false, message: "Failed to reject request" });
  }
});

export default router;
