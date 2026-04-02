const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

// Helper function to transform database fields to frontend format
const transformKPI = (kpi) => ({
  id: kpi.Id,
  name: kpi.Name,
  value: kpi.Value,
  change: kpi.Change || "+0%",
  trend: kpi.Trend || "up",
  period: kpi.Period || "vs last month",
  category: kpi.Category,
  department: kpi.Department
});

const transformApproval = (approval) => ({
  id: approval.Id,
  type: approval.Type,
  department: approval.Department,
  requestor: approval.Requestor,
  requestorId: approval.RequestorId,
  amount: approval.Amount,
  priority: approval.Priority || "medium",
  status: approval.Status,
  description: approval.Description,
  details: approval.Details,
  dueDate: approval.DueDate ? new Date(approval.DueDate).toLocaleDateString() : "N/A",
  submittedDate: approval.SubmittedDate
});

const transformAlert = (alert) => ({
  id: alert.Id,
  type: alert.Type,
  title: alert.Title,
  message: alert.Message,
  department: alert.Department,
  severity: alert.Severity,
  status: alert.Status,
  actionRequired: alert.ActionRequired,
  source: alert.Source,
  createdAt: alert.CreatedAt
});

router.get("/overview", async (req, res) => {
  try {
    const kpis = await prisma.managementKPI.findMany({ orderBy: { RecordedAt: 'desc' }, take: 20 });
    const kpisByName = {};
    kpis.forEach(kpi => { if (!kpisByName[kpi.Name]) kpisByName[kpi.Name] = kpi; });

    const pendingApprovals = await prisma.managementApproval.findMany({
      where: { Status: 'pending' },
      orderBy: { SubmittedDate: 'desc' },
      take: 10
    });

    const activeAlerts = await prisma.managementAlert.findMany({
      where: { Status: 'active' },
      orderBy: { CreatedAt: 'desc' },
      take: 5
    });

    const departmentStatus = [
      { department: "Sales & Marketing", status: "Excellent", performance: 94, alerts: activeAlerts.filter(a => a.Department === "Sales & Marketing").length },
      { department: "Operations", status: "Good", performance: 87, alerts: activeAlerts.filter(a => a.Department === "Operations").length },
      { department: "Business Relationship Management", status: "Excellent", performance: 92, alerts: activeAlerts.filter(a => a.Department === "Business Relationship Management").length },
      { department: "HR Management", status: "Good", performance: 91, alerts: activeAlerts.filter(a => a.Department === "HR Management").length },
      { department: "Finance & Accounting", status: "Warning", performance: 78, alerts: activeAlerts.filter(a => a.Department === "Finance & Accounting").length }
    ];

    res.json({
      success: true,
      data: {
        kpis: Object.values(kpisByName).map(transformKPI),
        pendingApprovals: pendingApprovals.map(transformApproval),
        activeAlerts: activeAlerts.map(transformAlert),
        departmentStatus,
        stats: {
          approvals: { total: await prisma.managementApproval.count(), pending: pendingApprovals.length, approved: await prisma.managementApproval.count({ where: { Status: 'approved' } }), rejected: await prisma.managementApproval.count({ where: { Status: 'rejected' } }) },
          alerts: { total: await prisma.managementAlert.count(), active: activeAlerts.length, acknowledged: await prisma.managementAlert.count({ where: { Status: 'acknowledged' } }), resolved: await prisma.managementAlert.count({ where: { Status: 'resolved' } }) },
          medicalCases: { total: await prisma.underwritingCase.count(), new: await prisma.underwritingCase.count({ where: { Status: 'NEW' } }), inReview: await prisma.underwritingCase.count({ where: { Status: 'IN_REVIEW' } }), completed: await prisma.underwritingCase.count({ where: { Status: 'COMPLETED' } }), slaBreached: await prisma.medicalTask.count({ where: { SlaBreach: true } }) }
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch overview" });
  }
});

router.get("/system-status", async (req, res) => {
  res.json({
    success: true,
    data: [
      { system: "PostgreSQL Database", status: "operational", uptime: "99.8%", lastUpdate: new Date() },
      { system: "Redis Cache", status: "operational", uptime: "99.9%", lastUpdate: new Date() },
      { system: "RabbitMQ", status: "operational", uptime: "99.5%", lastUpdate: new Date() },
      { system: "API Server", status: "operational", uptime: "100%", lastUpdate: new Date() }
    ]
  });
});

module.exports = router;