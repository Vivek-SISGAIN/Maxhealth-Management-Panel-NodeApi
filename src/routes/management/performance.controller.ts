import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  managementKpisTable,
  managementAnalyticsSnapshotsTable,
  managementDepartmentMetricsTable,
} from "@workspace/db/schema";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/performance", async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>;

    const kpiConditions = [];
    if (dateFrom) kpiConditions.push(gte(managementKpisTable.recordedAt, new Date(dateFrom)));
    if (dateTo) kpiConditions.push(lte(managementKpisTable.recordedAt, new Date(dateTo)));

    const kpis = await db
      .select()
      .from(managementKpisTable)
      .where(kpiConditions.length ? and(...kpiConditions) : undefined)
      .orderBy(desc(managementKpisTable.recordedAt))
      .limit(100);

    const latestByName: Record<string, typeof kpis[0]> = {};
    for (const k of kpis) {
      if (!latestByName[k.name]) latestByName[k.name] = k;
    }

    const analyticsConditions = [
      eq(managementAnalyticsSnapshotsTable.type, "quarterly"),
      ...(dateFrom ? [gte(managementAnalyticsSnapshotsTable.recordedAt, new Date(dateFrom))] : []),
      ...(dateTo ? [lte(managementAnalyticsSnapshotsTable.recordedAt, new Date(dateTo))] : []),
    ];

    const quarterlySnapshots = await db
      .select()
      .from(managementAnalyticsSnapshotsTable)
      .where(and(...analyticsConditions))
      .orderBy(desc(managementAnalyticsSnapshotsTable.recordedAt))
      .limit(4);

    const compSnapshots = await db
      .select()
      .from(managementAnalyticsSnapshotsTable)
      .where(eq(managementAnalyticsSnapshotsTable.type, "competitive"))
      .orderBy(desc(managementAnalyticsSnapshotsTable.recordedAt))
      .limit(1);

    res.json({
      success: true,
      data: {
        kpis: Object.values(latestByName),
        quarterly: quarterlySnapshots,
        competitive: compSnapshots[0]?.data ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching company performance");
    res.status(500).json({ success: false, message: "Failed to fetch performance data" });
  }
});

router.post("/performance/kpis", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const rows = Array.isArray(body) ? body : [body];

    const inserted = await db
      .insert(managementKpisTable)
      .values(rows)
      .returning();

    res.status(201).json({ success: true, data: inserted });
  } catch (err) {
    req.log.error({ err }, "Error inserting KPIs");
    res.status(500).json({ success: false, message: "Failed to insert KPIs" });
  }
});

router.get("/performance/kpis", async (req: Request, res: Response) => {
  try {
    const { category, department } = req.query as Record<string, string>;

    const conditions = [];
    if (category) conditions.push(eq(managementKpisTable.category, category));
    if (department) conditions.push(eq(managementKpisTable.department, department));

    const kpis = await db
      .select()
      .from(managementKpisTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(managementKpisTable.recordedAt))
      .limit(50);

    res.json({ success: true, data: kpis });
  } catch (err) {
    req.log.error({ err }, "Error fetching KPIs");
    res.status(500).json({ success: false, message: "Failed to fetch KPIs" });
  }
});

export default router;
