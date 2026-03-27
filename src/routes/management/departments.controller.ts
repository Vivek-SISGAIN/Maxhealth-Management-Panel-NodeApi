import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { managementDepartmentMetricsTable } from "@workspace/db/schema";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/departments", async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, department } = req.query as Record<string, string>;

    const conditions = [];
    if (dateFrom) conditions.push(gte(managementDepartmentMetricsTable.recordedAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(managementDepartmentMetricsTable.recordedAt, new Date(dateTo)));
    if (department) conditions.push(eq(managementDepartmentMetricsTable.departmentName, department));

    const metrics = await db
      .select()
      .from(managementDepartmentMetricsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        managementDepartmentMetricsTable.departmentName,
        desc(managementDepartmentMetricsTable.recordedAt)
      );

    // Fallback data for empty database
    const defaultDepartments = [
      {
        name: "Sales & Marketing",
        metrics: {
          revenue: "AED 1,85,45,230",
          deals: 156,
          conversion: "18.5%",
          target: 89
        },
        activities: [
          { task: "Follow-up pending deals", count: 23, priority: "high" },
          { task: "Proposals in review", count: 8, priority: "medium" },
          { task: "New leads generated", count: 45, priority: "low" }
        ],
        trend: "+12.5%"
      },
      {
        name: "Operations",
        metrics: {
          claims: "1,234",
          processed: "96.8%",
          avgTime: "2.4 days",
          satisfaction: 92
        },
        activities: [
          { task: "Claims pending review", count: 34, priority: "high" },
          { task: "Policy verifications", count: 67, priority: "medium" },
          { task: "Customer queries", count: 89, priority: "low" }
        ],
        trend: "+8.2%"
      },
      {
        name: "Business Relationship Management",
        metrics: {
          clients: 450,
          retention: "95.2%",
          satisfaction: "94%",
          meetings: 85
        },
        activities: [
          { task: "Client onboarding", count: 12, priority: "high" },
          { task: "Relationship reviews", count: 18, priority: "medium" },
          { task: "Account expansions", count: 7, priority: "low" }
        ],
        trend: "+15.3%"
      },
      {
        name: "HR Management",
        metrics: {
          employees: 1247,
          newHires: 23,
          retention: "94.2%",
          satisfaction: 87
        },
        activities: [
          { task: "Pending onboarding", count: 8, priority: "high" },
          { task: "Leave requests", count: 12, priority: "medium" },
          { task: "Performance reviews", count: 5, priority: "low" }
        ],
        trend: "+5.8%"
      },
      {
        name: "Finance & Accounting",
        metrics: {
          revenue: "AED 2,45,67,890",
          expenses: "AED 1,89,23,456",
          profit: "22.8%",
          growth: 15.6
        },
        activities: [
          { task: "Invoices pending", count: 15, priority: "high" },
          { task: "Budget reviews", count: 4, priority: "medium" },
          { task: "Financial reports", count: 7, priority: "low" }
        ],
        trend: "+6.4%"
      }
    ];

    if (metrics.length === 0) {
      res.json({ success: true, data: defaultDepartments });
      return;
    }

    const grouped: Record<string, typeof metrics> = {};
    for (const m of metrics) {
      if (!grouped[m.departmentName]) grouped[m.departmentName] = [];
      grouped[m.departmentName].push(m);
    }

    const departments = Object.entries(grouped).map(([name, rows]) => {
      const latestByKey: Record<string, typeof rows[0]> = {};
      for (const r of rows) {
        if (!latestByKey[r.metricKey]) latestByKey[r.metricKey] = r;
      }
      return {
        name,
        metrics: Object.values(latestByKey),
      };
    });

    res.json({ success: true, data: departments });
  } catch (err) {
    req.log.error({ err }, "Error fetching department metrics");
    res.status(500).json({ success: false, message: "Failed to fetch department metrics" });
  }
});

router.get("/departments/:name/metrics", async (req: Request, res: Response): Promise<void> => {
  try {
    const name = req.params.name as string;
    const { dateFrom, dateTo } = req.query as Record<string, string>;

    const conditions = [
      eq(managementDepartmentMetricsTable.departmentName, name),
      ...(dateFrom ? [gte(managementDepartmentMetricsTable.recordedAt, new Date(dateFrom))] : []),
      ...(dateTo ? [lte(managementDepartmentMetricsTable.recordedAt, new Date(dateTo))] : []),
    ];

    const metrics = await db
      .select()
      .from(managementDepartmentMetricsTable)
      .where(and(...conditions))
      .orderBy(desc(managementDepartmentMetricsTable.recordedAt));

    res.json({ success: true, data: metrics });
  } catch (err) {
    req.log.error({ err }, "Error fetching department metrics by name");
    res.status(500).json({ success: false, message: "Failed to fetch metrics" });
  }
});

router.post("/departments/metrics", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const rows = Array.isArray(body) ? body : [body];

    const inserted = await db
      .insert(managementDepartmentMetricsTable)
      .values(rows)
      .returning();

    res.status(201).json({ success: true, data: inserted });
  } catch (err) {
    req.log.error({ err }, "Error inserting department metrics");
    res.status(500).json({ success: false, message: "Failed to insert metrics" });
  }
});

export default router;
