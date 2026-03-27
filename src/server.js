require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.MANAGEMENT_PORT || 7008;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-memory data store (fallback data for frontend)
const defaultData = {
  kpis: [
    { name: "Total Revenue", value: "AED 2,45,67,890", change: "+12.5%", trend: "up", period: "vs last month", icon: "Coins", color: "text-green-600" },
    { name: "Active Policies", value: "8,547", change: "+8.2%", trend: "up", period: "vs last month", icon: "Target", color: "text-blue-600" },
    { name: "Total Employees", value: "1,247", change: "+23", trend: "up", period: "new hires this month", icon: "Users", color: "text-purple-600" },
    { name: "Claims Processing", value: "96.8%", change: "+2.1%", trend: "up", period: "efficiency rate", icon: "CheckCircle", color: "text-emerald-600" }
  ],
  departmentStatus: [
    { department: "Sales & Marketing", status: "Excellent", performance: 94, alerts: 0, statusColor: "bg-green-100 text-green-800" },
    { department: "Operations", status: "Good", performance: 87, alerts: 2, statusColor: "bg-blue-100 text-blue-800" },
    { department: "Business Relationship Management", status: "Excellent", performance: 92, alerts: 1, statusColor: "bg-green-100 text-green-800" },
    { department: "HR Management", status: "Good", performance: 91, alerts: 1, statusColor: "bg-blue-100 text-blue-800" },
    { department: "Finance & Accounting", status: "Warning", performance: 78, alerts: 3, statusColor: "bg-yellow-100 text-yellow-800" }
  ],
  pendingApprovals: [
    { id: "APV-001", type: "Variation Approval", department: "Sales & Marketing", requestor: "Sarah Johnson", amount: "AED 50,000", priority: "high", dueDate: "Today" },
    { id: "APV-002", type: "Pre-authorization", department: "Operations", requestor: "Michael Chen", amount: "AED 25,000", priority: "urgent", dueDate: "Today" },
    { id: "APV-003", type: "Budget Approval", department: "Finance & Accounting", requestor: "Lisa Rodriguez", amount: "AED 150,000", priority: "medium", dueDate: "Tomorrow" },
    { id: "APV-004", type: "Employee Hiring", department: "HR Management", requestor: "David Wilson", amount: "AED 8,500/month", priority: "medium", dueDate: "2024-01-22" },
    { id: "APV-005", type: "Investment Approval", department: "Business Relationship Management", requestor: "Emma Davis", amount: "AED 200,000", priority: "high", dueDate: "2024-01-19" }
  ],
  departments: [
    { name: "Sales & Marketing", metrics: { revenue: "AED 1,85,45,230", deals: 156, conversion: "18.5%", target: 89 }, trend: "+12.5%" },
    { name: "Operations", metrics: { claims: "1,234", processed: "96.8%", avgTime: "2.4 days", satisfaction: 92 }, trend: "+8.2%" },
    { name: "Business Relationship Management", metrics: { clients: 450, retention: "95.2%", satisfaction: "94%", meetings: 85 }, trend: "+15.3%" },
    { name: "HR Management", metrics: { employees: 1247, newHires: 23, retention: "94.2%", satisfaction: 87 }, trend: "+5.8%" },
    { name: "Finance & Accounting", metrics: { revenue: "AED 2,45,67,890", expenses: "AED 1,89,23,456", profit: "22.8%", growth: 15.6 }, trend: "+6.4%" }
  ],
  analytics: {
    revenue: [
      { month: "Jan", sales: 185000, operations: 125000, brm: 95000, hr: 45000, finance: 35000 },
      { month: "Feb", sales: 198000, operations: 135000, brm: 105000, hr: 48000, finance: 38000 },
      { month: "Mar", sales: 215000, operations: 145000, brm: 115000, hr: 52000, finance: 42000 },
      { month: "Apr", sales: 232000, operations: 155000, brm: 125000, hr: 55000, finance: 45000 },
      { month: "May", sales: 245000, operations: 165000, brm: 135000, hr: 58000, finance: 48000 },
      { month: "Jun", sales: 268000, operations: 175000, brm: 145000, hr: 62000, finance: 52000 }
    ],
    performance: [
      { department: "Sales", efficiency: 89, satisfaction: 94, growth: 12 },
      { department: "Operations", efficiency: 96, satisfaction: 92, growth: 15 },
      { department: "BRM", efficiency: 91, satisfaction: 95, growth: 18 },
      { department: "HR", efficiency: 91, satisfaction: 87, growth: 8 },
      { department: "Finance", efficiency: 78, satisfaction: 85, growth: 6 }
    ],
    distribution: [
      { name: "Sales & Marketing", value: 30, color: "#3b82f6" },
      { name: "Operations", value: 25, color: "#10b981" },
      { name: "BRM", value: 20, color: "#8b5cf6" },
      { name: "HR Management", value: 15, color: "#f59e0b" },
      { name: "Finance", value: 10, color: "#ef4444" }
    ]
  },
  alerts: [
    { id: 1, type: "Critical", title: "System Performance Warning", message: "Server response time exceeded threshold (5.2s avg)", department: "IT Operations", timestamp: "2 minutes ago", severity: "high", status: "active" },
    { id: 2, type: "Operational", title: "High Volume Claims Processing", message: "Claims backlog increased by 25% in last hour", department: "Operations", timestamp: "8 minutes ago", severity: "medium", status: "acknowledged" },
    { id: 3, type: "Financial", title: "Revenue Milestone Achieved", message: "Monthly revenue target reached 5 days early", department: "Sales", timestamp: "15 minutes ago", severity: "info", status: "resolved" },
    { id: 4, type: "HR Alert", title: "Employee Attendance Drop", message: "15% decrease in attendance compared to yesterday", department: "HR", timestamp: "22 minutes ago", severity: "medium", status: "active" },
    { id: 5, type: "Compliance", title: "Regulatory Filing Due", message: "Quarterly compliance report due in 24 hours", department: "Compliance", timestamp: "45 minutes ago", severity: "low", status: "active" }
  ],
  systemStatus: [
    { system: "Core Database", status: "operational", uptime: "99.8%", lastUpdate: "1 min ago" },
    { system: "Payment Gateway", status: "operational", uptime: "99.9%", lastUpdate: "2 min ago" },
    { system: "Claims Processing", status: "degraded", uptime: "97.2%", lastUpdate: "5 min ago" },
    { system: "Customer Portal", status: "operational", uptime: "99.5%", lastUpdate: "3 min ago" }
  ]
};

// In-memory storage
let approvals = [...defaultData.pendingApprovals];
let alerts = [...defaultData.alerts];
let chatHistory = [];

// ==================== Overview API ====================
app.get("/api/management/overview", (req, res) => {
  res.json({
    success: true,
    data: {
      kpis: defaultData.kpis,
      departmentStatus: defaultData.departmentStatus,
      pendingApprovals: approvals,
      activeAlerts: alerts.filter(a => a.status === "active"),
      stats: {
        approvals: {
          total: approvals.length,
          pending: approvals.filter(a => a.status !== "approved" && a.status !== "rejected").length,
          approved: approvals.filter(a => a.status === "approved").length,
          rejected: approvals.filter(a => a.status === "rejected").length
        },
        alerts: {
          total: alerts.length,
          active: alerts.filter(a => a.status === "active").length,
          acknowledged: alerts.filter(a => a.status === "acknowledged").length,
          resolved: alerts.filter(a => a.status === "resolved").length
        }
      }
    }
  });
});

app.get("/api/management/system-status", (req, res) => {
  res.json({ success: true, data: defaultData.systemStatus });
});

// ==================== Department APIs ====================
app.get("/api/management/departments", (req, res) => {
  res.json({
    success: true,
    data: defaultData.departments
  });
});

app.get("/api/management/departments/:name/metrics", (req, res) => {
  const dept = defaultData.departments.find(d => d.name.toLowerCase() === req.params.name.toLowerCase());
  if (dept) {
    res.json({ success: true, data: dept });
  } else {
    res.status(404).json({ success: false, message: "Department not found" });
  }
});

app.post("/api/management/departments/metrics", (req, res) => {
  // Store metrics (in production, save to database)
  res.status(201).json({ success: true, data: req.body });
});

// ==================== Analytics APIs ====================
app.get("/api/management/analytics", (req, res) => {
  const { type } = req.query;
  let data = defaultData.analytics;
  
  if (type === "revenue") {
    data = defaultData.analytics.revenue;
  } else if (type === "performance") {
    data = defaultData.analytics.performance;
  } else if (type === "distribution") {
    data = defaultData.analytics.distribution;
  }
  
  res.json({
    success: true,
    data: {
      period: "monthly",
      analytics: data
    }
  });
});

app.get("/api/management/analytics/revenue", (req, res) => {
  res.json({ success: true, data: defaultData.analytics.revenue });
});

app.get("/api/management/analytics/performance", (req, res) => {
  res.json({ success: true, data: defaultData.analytics.performance });
});

app.post("/api/management/analytics/snapshot", (req, res) => {
  res.status(201).json({ success: true, data: req.body });
});

// ==================== Performance APIs ====================
app.get("/api/management/performance", (req, res) => {
  res.json({
    success: true,
    data: {
      kpis: defaultData.kpis,
      quarterly: [
        { quarter: "Q1 2024", revenue: "AED 5,85,45,230", policies: 2150, satisfaction: 91, growth: "+15.2%" },
        { quarter: "Q2 2024", revenue: "AED 6,25,78,450", policies: 2280, satisfaction: 93, growth: "+18.8%" },
        { quarter: "Q3 2024", revenue: "AED 6,89,32,180", policies: 2395, satisfaction: 92, growth: "+22.1%" },
        { quarter: "Q4 2024", revenue: "AED 7,45,67,890", policies: 2567, satisfaction: 94, growth: "+25.6%" }
      ],
      competitive: {
        marketShare: { ourValue: "18.5%", industry: "12.3%", performance: "excellent" },
        claimsProcessing: { ourValue: "2.4 days", industry: "4.1 days", performance: "excellent" },
        customerRetention: { ourValue: "94.2%", industry: "87.8%", performance: "excellent" },
        employeeSatisfaction: { ourValue: "87%", industry: "78%", performance: "good" }
      }
    }
  });
});

app.get("/api/management/performance/kpis", (req, res) => {
  res.json({ success: true, data: defaultData.kpis });
});

app.post("/api/management/performance/kpis", (req, res) => {
  res.status(201).json({ success: true, data: req.body });
});

// ==================== Alerts APIs ====================
app.get("/api/management/alerts", (req, res) => {
  const { status, severity, department } = req.query;
  let filtered = alerts;
  
  if (status) filtered = filtered.filter(a => a.status === status);
  if (severity) filtered = filtered.filter(a => a.severity === severity);
  if (department) filtered = filtered.filter(a => a.department === department);
  
  res.json({
    success: true,
    data: filtered,
    meta: { total: filtered.length, page: 1, limit: 20, totalPages: 1 }
  });
});

app.get("/api/management/alerts/stats", (req, res) => {
  res.json({
    success: true,
    data: {
      total: alerts.length,
      active: alerts.filter(a => a.status === "active").length,
      acknowledged: alerts.filter(a => a.status === "acknowledged").length,
      resolved: alerts.filter(a => a.status === "resolved").length,
      critical: alerts.filter(a => a.severity === "critical").length,
      high: alerts.filter(a => a.severity === "high").length
    }
  });
});

app.get("/api/management/alerts/:id", (req, res) => {
  const alert = alerts.find(a => a.id === parseInt(req.params.id));
  if (alert) {
    res.json({ success: true, data: alert });
  } else {
    res.status(404).json({ success: false, message: "Alert not found" });
  }
});

app.post("/api/management/alerts", (req, res) => {
  const newAlert = {
    id: alerts.length + 1,
    ...req.body,
    status: "active",
    timestamp: new Date().toISOString()
  };
  alerts.push(newAlert);
  io.emit("management:alert:new", newAlert);
  res.status(201).json({ success: true, data: newAlert });
});

app.patch("/api/management/alerts/:id/acknowledge", (req, res) => {
  const alert = alerts.find(a => a.id === parseInt(req.params.id));
  if (alert) {
    alert.status = "acknowledged";
    alert.acknowledgedAt = new Date();
    io.emit("management:alert:updated", alert);
    res.json({ success: true, data: alert });
  } else {
    res.status(404).json({ success: false, message: "Alert not found" });
  }
});

app.patch("/api/management/alerts/:id/resolve", (req, res) => {
  const alert = alerts.find(a => a.id === parseInt(req.params.id));
  if (alert) {
    alert.status = "resolved";
    alert.resolvedAt = new Date();
    io.emit("management:alert:updated", alert);
    res.json({ success: true, data: alert });
  } else {
    res.status(404).json({ success: false, message: "Alert not found" });
  }
});

// ==================== Approvals APIs ====================
app.get("/api/management/approvals", (req, res) => {
  const { status, priority, department } = req.query;
  let filtered = approvals;
  
  if (status) filtered = filtered.filter(a => a.status === status);
  if (priority) filtered = filtered.filter(a => a.priority === priority);
  if (department) filtered = filtered.filter(a => a.department === department);
  
  res.json({
    success: true,
    data: filtered,
    meta: { total: filtered.length, page: 1, limit: 20, totalPages: 1 }
  });
});

app.get("/api/management/approvals/stats", (req, res) => {
  res.json({
    success: true,
    data: {
      total: approvals.length,
      pending: approvals.filter(a => a.status === "pending").length,
      approved: approvals.filter(a => a.status === "approved").length,
      rejected: approvals.filter(a => a.status === "rejected").length,
      urgent: approvals.filter(a => a.priority === "urgent" && a.status === "pending").length,
      high: approvals.filter(a => a.priority === "high" && a.status === "pending").length
    }
  });
});

app.get("/api/management/approvals/:id", (req, res) => {
  const approval = approvals.find(a => a.id === req.params.id);
  if (approval) {
    res.json({ success: true, data: approval });
  } else {
    res.status(404).json({ success: false, message: "Approval not found" });
  }
});

app.post("/api/management/approvals", (req, res) => {
  const newApproval = {
    id: `APV-${Date.now().toString(36).toUpperCase()}`,
    ...req.body,
    status: "pending",
    submittedDate: new Date().toISOString()
  };
  approvals.push(newApproval);
  io.emit("management:approval:new", newApproval);
  res.status(201).json({ success: true, data: newApproval });
});

app.patch("/api/management/approvals/:id/approve", (req, res) => {
  const approval = approvals.find(a => a.id === req.params.id);
  if (approval) {
    approval.status = "approved";
    approval.decidedAt = new Date();
    approval.decidedBy = req.body.decidedBy || "management";
    io.emit("management:approval:updated", { ...approval, action: "approved" });
    res.json({ success: true, data: approval });
  } else {
    res.status(404).json({ success: false, message: "Approval not found" });
  }
});

app.patch("/api/management/approvals/:id/reject", (req, res) => {
  const approval = approvals.find(a => a.id === req.params.id);
  if (approval) {
    approval.status = "rejected";
    approval.decidedAt = new Date();
    approval.decidedBy = req.body.decidedBy || "management";
    approval.rejectionNotes = req.body.notes;
    io.emit("management:approval:updated", { ...approval, action: "rejected" });
    res.json({ success: true, data: approval });
  } else {
    res.status(404).json({ success: false, message: "Approval not found" });
  }
});

// ==================== AI Chat APIs ====================
const AI_RESPONSES = [
  "Based on the current dashboard data, revenue is trending upward at +12.5% compared to last month. The operations department is performing at 96.8% efficiency.",
  "The pending approvals queue has several high-priority items that require your attention today. I recommend reviewing the pre-authorization requests first.",
  "Department metrics show that Finance & Accounting has 3 active alerts. Would you like me to summarize the key issues?",
  "The current policy sales are tracking at 85% of annual target. At this rate, you are on track to exceed the target by Q4.",
  "Based on your question, I recommend reviewing the consolidated analytics section for a comprehensive view of cross-department performance.",
  "Real-time alerts indicate a high-volume claims processing situation in Operations. This may require immediate attention.",
  "Employee retention is at 94.2%, which is 0.8% below the 95% annual target. HR department is monitoring this closely.",
  "The company's market share is at 18.5%, outperforming the industry average of 12.3%. This is a strong competitive position."
];

function generateAIResponse(userMessage) {
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg.includes("revenue") || lowerMsg.includes("sales")) return AI_RESPONSES[0];
  if (lowerMsg.includes("approval") || lowerMsg.includes("pending")) return AI_RESPONSES[1];
  if (lowerMsg.includes("alert") || lowerMsg.includes("warning")) return AI_RESPONSES[5];
  if (lowerMsg.includes("employee") || lowerMsg.includes("hr")) return AI_RESPONSES[6];
  if (lowerMsg.includes("policy") || lowerMsg.includes("insurance")) return AI_RESPONSES[3];
  if (lowerMsg.includes("market") || lowerMsg.includes("performance")) return AI_RESPONSES[7];
  if (lowerMsg.includes("department") || lowerMsg.includes("finance")) return AI_RESPONSES[2];
  return AI_RESPONSES[Math.floor(Math.random() * AI_RESPONSES.length)];
}

app.post("/api/management/chat", (req, res) => {
  const { message, sessionId, userId } = req.body;
  
  if (!message || !sessionId) {
    return res.status(400).json({ success: false, message: "message and sessionId are required" });
  }
  
  const userMessage = { sessionId, userId, role: "user", content: message, createdAt: new Date() };
  const aiText = generateAIResponse(message);
  const aiMessage = { sessionId, userId, role: "assistant", content: aiText, createdAt: new Date() };
  
  chatHistory.push(userMessage, aiMessage);
  io.emit("management:chat:message", { sessionId, userMessage, aiResponse: aiMessage });
  
  res.json({ success: true, data: { userMessage, aiResponse: aiMessage } });
});

app.get("/api/management/chat/:sessionId/history", (req, res) => {
  const sessionMessages = chatHistory.filter(m => m.sessionId === req.params.sessionId);
  res.json({ success: true, data: sessionMessages });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Management client connected:", socket.id);
  
  socket.on("join-management", () => {
    socket.join("management-room");
  });
  
  socket.on("disconnect", () => {
    console.log("Management client disconnected:", socket.id);
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Management Panel API" });
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Management Panel API running on port ${PORT}`);
  console.log(`Endpoints available at /api/management/*`);
});