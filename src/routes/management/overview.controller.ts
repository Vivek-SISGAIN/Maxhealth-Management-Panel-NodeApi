import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  managementKpisTable,
  managementApprovalsTable,
  managementAlertsTable,
} from "@workspace/db/schema";
import { desc, eq, and, gte, lte, count, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/overview", async (req: Request, res: Response) => {
  try {
    const latestKpis = await db
      .select()
      .from(managementKpisTable)
      .orderBy(desc(managementKpisTable.recordedAt))
      .limit(20);

    const kpisByName: Record<string, typeof latestKpis[0]> = {};
    for (const kpi of latestKpis) {
      if (!kpisByName[kpi.name]) kpisByName[kpi.name] = kpi;
    }

    const pendingApprovals = await db
      .select()
      .from(managementApprovalsTable)
      .where(eq(managementApprovalsTable.status, "pending"))
      .orderBy(desc(managementApprovalsTable.submittedDate))
      .limit(10);

    const activeAlerts = await db
      .select()
      .from(managementAlertsTable)
      .where(eq(managementAlertsTable.status, "active"))
      .orderBy(desc(managementAlertsTable.createdAt))
      .limit(5);

    const [approvalStats] = await db
      .select({
        total: count(),
        pending: sql<number>`count(*) filter (where status = 'pending')`,
        approved: sql<number>`count(*) filter (where status = 'approved')`,
        rejected: sql<number>`count(*) filter (where status = 'rejected')`,
      })
      .from(managementApprovalsTable);

    const [alertStats] = await db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where status = 'active')`,
        acknowledged: sql<number>`count(*) filter (where status = 'acknowledged')`,
        high: sql<number>`count(*) filter (where severity = 'high')`,
        critical: sql<number>`count(*) filter (where severity = 'critical')`,
      })
      .from(managementAlertsTable);

    // Fallback data for empty database
    const defaultKPIs = [
      { name: "Total Revenue", value: "AED 2,45,67,890", change: "+12.5%", trend: "up", period: "vs last month", icon: "Coins", color: "text-green-600" },
      { name: "Active Policies", value: "8,547", change: "+8.2%", trend: "up", period: "vs last month", icon: "Target", color: "text-blue-600" },
      { name: "Total Employees", value: "1,247", change: "+23", trend: "up", period: "new hires this month", icon: "Users", color: "text-purple-600" },
      { name: "Claims Processing", value: "96.8%", change: "+2.1%", trend: "up", period: "efficiency rate", icon: "CheckCircle", color: "text-emerald-600" }
    ];

    const defaultDepartmentStatus = [
      { department: "Sales & Marketing", status: "Excellent", performance: 94, alerts: 0 },
      { department: "Operations", status: "Good", performance: 87, alerts: 2 },
      { department: "Business Relationship Management", status: "Excellent", performance: 92, alerts: 1 },
      { department: "HR Management", status: "Good", performance: 91, alerts: 1 },
      { department: "Finance & Accounting", status: "Warning", performance: 78, alerts: 3 }
    ];

    const defaultPendingApprovals = [
      { id: "APV-001", type: "Variation Approval", department: "Sales & Marketing", requestor: "Sarah Johnson", amount: "AED 50,000", priority: "high", dueDate: "Today" },
      { id: "APV-002", type: "Pre-authorization", department: "Operations", requestor: "Michael Chen", amount: "AED 25,000", priority: "urgent", dueDate: "Today" },
      { id: "APV-003", type: "Budget Approval", department: "Finance & Accounting", requestor: "Lisa Rodriguez", amount: "AED 150,000", priority: "medium", dueDate: "Tomorrow" }
    ];

    res.json({
      success: true,
      data: {
        kpis: latestKpis.length > 0 ? Object.values(kpisByName) : defaultKPIs,
        pendingApprovals: pendingApprovals.length > 0 ? pendingApprovals : defaultPendingApprovals,
        activeAlerts,
        departmentStatus: defaultDepartmentStatus,
        stats: {
          approvals: approvalStats,
          alerts: alertStats,
        },
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching management overview");
    res.status(500).json({ success: false, message: "Failed to fetch overview" });
  }
});

router.get("/system-status", async (_req: Request, res: Response) => {
  const systems = [
    { system: "Core Database", status: "operational", uptime: "99.8%", lastUpdate: new Date() },
    { system: "Payment Gateway", status: "operational", uptime: "99.9%", lastUpdate: new Date() },
    { system: "Claims Processing", status: "operational", uptime: "97.2%", lastUpdate: new Date() },
    { system: "Customer Portal", status: "operational", uptime: "99.5%", lastUpdate: new Date() },
  ];

  res.json({ success: true, data: systems });
});

export default router;
