import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { managementAlertsTable } from "@workspace/db/schema";
import { desc, eq, and, gte, lte, count, sql } from "drizzle-orm";
import { emitToManagement } from "../../lib/socket";
import { publishManagementEvent } from "../../lib/rabbitmq";

const router: IRouter = Router();

router.get("/alerts", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      status,
      severity,
      department,
      actionRequired,
      dateFrom,
      dateTo,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [
      ...(status ? [eq(managementAlertsTable.status, status as any)] : []),
      ...(severity ? [eq(managementAlertsTable.severity, severity as any)] : []),
      ...(department ? [eq(managementAlertsTable.department, department)] : []),
      ...(actionRequired !== undefined ? [eq(managementAlertsTable.actionRequired, actionRequired === "true")] : []),
      ...(dateFrom ? [gte(managementAlertsTable.createdAt, new Date(dateFrom))] : []),
      ...(dateTo ? [lte(managementAlertsTable.createdAt, new Date(dateTo))] : []),
    ];

    const where = conditions.length ? and(...conditions) : undefined;

    const [totalResult] = await db
      .select({ count: count() })
      .from(managementAlertsTable)
      .where(where);

    const alerts = await db
      .select()
      .from(managementAlertsTable)
      .where(where)
      .orderBy(desc(managementAlertsTable.createdAt))
      .limit(limitNum)
      .offset(offset);

    res.json({
      success: true,
      data: alerts,
      meta: {
        total: totalResult.count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(Number(totalResult.count) / limitNum),
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching alerts");
    res.status(500).json({ success: false, message: "Failed to fetch alerts" });
  }
});

router.get("/alerts/stats", async (_req: Request, res: Response): Promise<void> => {
  try {
    const [stats] = await db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where status = 'active')`,
        acknowledged: sql<number>`count(*) filter (where status = 'acknowledged')`,
        resolved: sql<number>`count(*) filter (where status = 'resolved')`,
        critical: sql<number>`count(*) filter (where severity = 'critical')`,
        high: sql<number>`count(*) filter (where severity = 'high')`,
        actionRequired: sql<number>`count(*) filter (where action_required = true and status = 'active')`,
      })
      .from(managementAlertsTable);

    res.json({ success: true, data: stats });
  } catch (err) {
    _req.log.error({ err }, "Error fetching alert stats");
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

router.get("/alerts/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const [alert] = await db
      .select()
      .from(managementAlertsTable)
      .where(eq(managementAlertsTable.id, id));

    if (!alert) {
      res.status(404).json({ success: false, message: "Alert not found" });
      return;
    }

    res.json({ success: true, data: alert });
  } catch (err) {
    req.log.error({ err }, "Error fetching alert");
    res.status(500).json({ success: false, message: "Failed to fetch alert" });
  }
});

router.post("/alerts", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      type,
      title,
      message,
      department,
      severity = "medium",
      actionRequired = false,
      source,
      metadata,
      expiresAt,
    } = req.body;

    if (!type || !title || !message) {
      res.status(400).json({ success: false, message: "type, title and message are required" });
      return;
    }

    const [alert] = await db
      .insert(managementAlertsTable)
      .values({
        type,
        title,
        message,
        department,
        severity,
        status: "active",
        actionRequired,
        source,
        metadata,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      })
      .returning();

    emitToManagement("management:alert:new", alert);
    publishManagementEvent("management.alert.created", alert);

    res.status(201).json({ success: true, data: alert });
  } catch (err) {
    req.log.error({ err }, "Error creating alert");
    res.status(500).json({ success: false, message: "Failed to create alert" });
  }
});

router.patch("/alerts/:id/acknowledge", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { acknowledgedBy = "management" } = req.body;

    const [existing] = await db
      .select()
      .from(managementAlertsTable)
      .where(eq(managementAlertsTable.id, id));

    if (!existing) {
      res.status(404).json({ success: false, message: "Alert not found" });
      return;
    }

    if (existing.status === "resolved") {
      res.status(400).json({ success: false, message: "Alert is already resolved" });
      return;
    }

    const [updated] = await db
      .update(managementAlertsTable)
      .set({
        status: "acknowledged",
        acknowledgedBy,
        acknowledgedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(managementAlertsTable.id, id))
      .returning();

    emitToManagement("management:alert:updated", { ...updated, action: "acknowledged" });
    publishManagementEvent("management.alert.acknowledged", updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    req.log.error({ err }, "Error acknowledging alert");
    res.status(500).json({ success: false, message: "Failed to acknowledge alert" });
  }
});

router.patch("/alerts/:id/resolve", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { resolvedBy = "management" } = req.body;

    const [existing] = await db
      .select()
      .from(managementAlertsTable)
      .where(eq(managementAlertsTable.id, id));

    if (!existing) {
      res.status(404).json({ success: false, message: "Alert not found" });
      return;
    }

    const [updated] = await db
      .update(managementAlertsTable)
      .set({
        status: "resolved",
        resolvedBy,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(managementAlertsTable.id, id))
      .returning();

    emitToManagement("management:alert:updated", { ...updated, action: "resolved" });
    publishManagementEvent("management.alert.resolved", updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    req.log.error({ err }, "Error resolving alert");
    res.status(500).json({ success: false, message: "Failed to resolve alert" });
  }
});

export default router;
