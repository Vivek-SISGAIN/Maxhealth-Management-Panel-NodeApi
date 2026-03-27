import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  managementAnalyticsSnapshotsTable,
} from "@workspace/db/schema";
import { desc, eq, and, gte, lte } from "drizzle-orm";

const router: IRouter = Router();

router.get("/analytics", async (req: Request, res: Response): Promise<void> => {
  try {
    const { period = "monthly", dateFrom, dateTo, type } = req.query as Record<string, string>;

    const conditions = [
      eq(managementAnalyticsSnapshotsTable.period, period),
      ...(type ? [eq(managementAnalyticsSnapshotsTable.type, type)] : []),
      ...(dateFrom ? [gte(managementAnalyticsSnapshotsTable.recordedAt, new Date(dateFrom))] : []),
      ...(dateTo ? [lte(managementAnalyticsSnapshotsTable.recordedAt, new Date(dateTo))] : []),
    ];

    const snapshots = await db
      .select()
      .from(managementAnalyticsSnapshotsTable)
      .where(and(...conditions))
      .orderBy(desc(managementAnalyticsSnapshotsTable.recordedAt))
      .limit(50);

    const byType: Record<string, typeof snapshots[0]> = {};
    for (const s of snapshots) {
      if (!byType[s.type]) byType[s.type] = s;
    }

    res.json({
      success: true,
      data: {
        period,
        snapshots: Object.values(byType),
        all: snapshots,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching analytics");
    res.status(500).json({ success: false, message: "Failed to fetch analytics" });
  }
});

router.post("/analytics/snapshot", async (req: Request, res: Response): Promise<void> => {
  try {
    const { period, type, data } = req.body;
    if (!period || !type || !data) {
      res.status(400).json({ success: false, message: "period, type and data are required" });
      return;
    }

    const [inserted] = await db
      .insert(managementAnalyticsSnapshotsTable)
      .values({ period, type, data })
      .returning();

    res.status(201).json({ success: true, data: inserted });
  } catch (err) {
    req.log.error({ err }, "Error creating analytics snapshot");
    res.status(500).json({ success: false, message: "Failed to create snapshot" });
  }
});

router.get("/analytics/revenue", async (req: Request, res: Response): Promise<void> => {
  try {
    const { period = "monthly" } = req.query as Record<string, string>;

    const snapshots = await db
      .select()
      .from(managementAnalyticsSnapshotsTable)
      .where(
        and(
          eq(managementAnalyticsSnapshotsTable.period, period),
          eq(managementAnalyticsSnapshotsTable.type, "revenue")
        )
      )
      .orderBy(desc(managementAnalyticsSnapshotsTable.recordedAt))
      .limit(12);

    res.json({ success: true, data: snapshots });
  } catch (err) {
    req.log.error({ err }, "Error fetching revenue analytics");
    res.status(500).json({ success: false, message: "Failed to fetch revenue analytics" });
  }
});

router.get("/analytics/performance", async (req: Request, res: Response): Promise<void> => {
  try {
    const { period = "monthly" } = req.query as Record<string, string>;

    const snapshots = await db
      .select()
      .from(managementAnalyticsSnapshotsTable)
      .where(
        and(
          eq(managementAnalyticsSnapshotsTable.period, period),
          eq(managementAnalyticsSnapshotsTable.type, "performance")
        )
      )
      .orderBy(desc(managementAnalyticsSnapshotsTable.recordedAt))
      .limit(12);

    res.json({ success: true, data: snapshots });
  } catch (err) {
    req.log.error({ err }, "Error fetching performance analytics");
    res.status(500).json({ success: false, message: "Failed to fetch performance analytics" });
  }
});

export default router;
