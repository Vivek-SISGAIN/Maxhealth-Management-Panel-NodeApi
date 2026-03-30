-- =====================================================
-- MaxHealth Management Panel Database SQL Script
-- Run this in your PostgreSQL database to create tables
-- =====================================================

-- 1. Management KPI Table
CREATE TABLE IF NOT EXISTS "ManagementKPI" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "Name" TEXT NOT NULL,
    "Value" TEXT NOT NULL,
    "Change" TEXT,
    "Trend" TEXT,
    "Period" TEXT,
    "Category" TEXT,
    "Department" TEXT,
    "RecordedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Management Department Metrics Table
CREATE TABLE IF NOT EXISTS "ManagementDepartmentMetric" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "DepartmentName" TEXT NOT NULL,
    "MetricKey" TEXT NOT NULL,
    "MetricValue" TEXT NOT NULL,
    "RecordedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Management Analytics Snapshot Table
CREATE TABLE IF NOT EXISTS "ManagementAnalyticsSnapshot" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "Period" TEXT NOT NULL,
    "Type" TEXT NOT NULL,
    "Data" JSONB NOT NULL,
    "RecordedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Management Alert Table
CREATE TABLE IF NOT EXISTS "ManagementAlert" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "Type" TEXT NOT NULL,
    "Title" TEXT NOT NULL,
    "Message" TEXT NOT NULL,
    "Department" TEXT,
    "Severity" TEXT DEFAULT 'medium',
    "Status" TEXT DEFAULT 'active',
    "ActionRequired" BOOLEAN DEFAULT false,
    "Source" TEXT,
    "Metadata" JSONB,
    "ExpiresAt" TIMESTAMP WITH TIME ZONE,
    "AcknowledgedBy" TEXT,
    "AcknowledgedAt" TIMESTAMP WITH TIME ZONE,
    "ResolvedBy" TEXT,
    "ResolvedAt" TIMESTAMP WITH TIME ZONE,
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Management Approval Table
CREATE TABLE IF NOT EXISTS "ManagementApproval" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "ApprovalCode" TEXT UNIQUE NOT NULL,
    "Type" TEXT NOT NULL,
    "Department" TEXT NOT NULL,
    "Requestor" TEXT NOT NULL,
    "RequestorId" TEXT,
    "Description" TEXT NOT NULL,
    "Details" TEXT,
    "Amount" TEXT,
    "Priority" TEXT DEFAULT 'medium',
    "Status" TEXT DEFAULT 'pending',
    "DueDate" TIMESTAMP WITH TIME ZONE,
    "DecidedBy" TEXT,
    "DecidedAt" TIMESTAMP WITH TIME ZONE,
    "RejectionNotes" TEXT,
    "Metadata" JSONB,
    "SubmittedDate" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "UpdatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Management Chat Message Table
CREATE TABLE IF NOT EXISTS "ManagementChatMessage" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "SessionId" TEXT NOT NULL,
    "UserId" TEXT,
    "Role" TEXT NOT NULL,
    "Content" TEXT NOT NULL,
    "CreatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- Create Indexes for better query performance
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_management_kpi_name ON "ManagementKPI"("Name");
CREATE INDEX IF NOT EXISTS idx_management_kpi_department ON "ManagementKPI"("Department");
CREATE INDEX IF NOT EXISTS idx_management_kpi_recorded ON "ManagementKPI"("RecordedAt");

CREATE INDEX IF NOT EXISTS idx_dept_metric_department ON "ManagementDepartmentMetric"("DepartmentName");
CREATE INDEX IF NOT EXISTS idx_dept_metric_recorded ON "ManagementDepartmentMetric"("RecordedAt");

CREATE INDEX IF NOT EXISTS idx_analytics_period ON "ManagementAnalyticsSnapshot"("Period");
CREATE INDEX IF NOT EXISTS idx_analytics_type ON "ManagementAnalyticsSnapshot"("Type");
CREATE INDEX IF NOT EXISTS idx_analytics_recorded ON "ManagementAnalyticsSnapshot"("RecordedAt");

CREATE INDEX IF NOT EXISTS idx_alert_status ON "ManagementAlert"("Status");
CREATE INDEX IF NOT EXISTS idx_alert_severity ON "ManagementAlert"("Severity");
CREATE INDEX IF NOT EXISTS idx_alert_department ON "ManagementAlert"("Department");
CREATE INDEX IF NOT EXISTS idx_alert_created ON "ManagementAlert"("CreatedAt");

CREATE INDEX IF NOT EXISTS idx_approval_status ON "ManagementApproval"("Status");
CREATE INDEX IF NOT EXISTS idx_approval_priority ON "ManagementApproval"("Priority");
CREATE INDEX IF NOT EXISTS idx_approval_department ON "ManagementApproval"("Department");
CREATE INDEX IF NOT EXISTS idx_approval_submitted ON "ManagementApproval"("SubmittedDate");

CREATE INDEX IF NOT EXISTS idx_chat_session ON "ManagementChatMessage"("SessionId");
CREATE INDEX IF NOT EXISTS idx_chat_created ON "ManagementChatMessage"("CreatedAt");

-- =====================================================
-- Seed Data - KPIs
-- =====================================================
INSERT INTO "ManagementKPI" ("Name", "Value", "Change", "Trend", "Period", "Category", "Department") VALUES
('Total Revenue', 'AED 2,45,67,890', '+12.5%', 'up', 'monthly', 'Financial', NULL),
('Active Policies', '8,547', '+8.2%', 'up', 'monthly', 'Operations', NULL),
('Total Employees', '1,247', '+23', 'up', 'monthly', 'HR', NULL),
('Claims Processing', '96.8%', '+2.1%', 'up', 'monthly', 'Operations', NULL),
('Customer Satisfaction', '92%', '+1.5%', 'up', 'monthly', 'Service', NULL),
('Policy Renewals', '89%', '+3.2%', 'up', 'monthly', 'Operations', NULL),
('Employee Retention', '94.2%', '-0.8%', 'down', 'monthly', 'HR', NULL),
('Market Share', '18.5%', '+2.1%', 'up', 'monthly', 'Sales', NULL);

-- =====================================================
-- Seed Data - Department Metrics
-- =====================================================
INSERT INTO "ManagementDepartmentMetric" ("DepartmentName", "MetricKey", "MetricValue") VALUES
('Sales & Marketing', 'revenue', 'AED 1,85,45,230'),
('Sales & Marketing', 'deals', '156'),
('Sales & Marketing', 'conversion', '18.5%'),
('Sales & Marketing', 'target', '89'),
('Operations', 'claims', '1,234'),
('Operations', 'processed', '96.8%'),
('Operations', 'avgTime', '2.4 days'),
('Operations', 'satisfaction', '92'),
('Business Relationship Management', 'clients', '450'),
('Business Relationship Management', 'retention', '95.2%'),
('Business Relationship Management', 'satisfaction', '94%'),
('Business Relationship Management', 'meetings', '85'),
('HR Management', 'employees', '1247'),
('HR Management', 'newHires', '23'),
('HR Management', 'retention', '94.2%'),
('HR Management', 'satisfaction', '87'),
('Finance & Accounting', 'revenue', 'AED 2,45,67,890'),
('Finance & Accounting', 'expenses', 'AED 1,89,23,456'),
('Finance & Accounting', 'profit', '22.8%'),
('Finance & Accounting', 'growth', '15.6');

-- =====================================================
-- Seed Data - Analytics Snapshots
-- =====================================================
INSERT INTO "ManagementAnalyticsSnapshot" ("Period", "Type", "Data") VALUES
('monthly', 'revenue', '{"month": "Jan", "sales": 185000, "operations": 125000, "brm": 95000, "hr": 45000, "finance": 35000}'),
('monthly', 'revenue', '{"month": "Feb", "sales": 198000, "operations": 135000, "brm": 105000, "hr": 48000, "finance": 38000}'),
('monthly', 'revenue', '{"month": "Mar", "sales": 215000, "operations": 145000, "brm": 115000, "hr": 52000, "finance": 42000}'),
('monthly', 'revenue', '{"month": "Apr", "sales": 232000, "operations": 155000, "brm": 125000, "hr": 55000, "finance": 45000}'),
('monthly', 'revenue', '{"month": "May", "sales": 245000, "operations": 165000, "brm": 135000, "hr": 58000, "finance": 48000}'),
('monthly', 'revenue', '{"month": "Jun", "sales": 268000, "operations": 175000, "brm": 145000, "hr": 62000, "finance": 52000}'),
('monthly', 'performance', '{"department": "Sales", "efficiency": 89, "satisfaction": 94, "growth": 12}'),
('monthly', 'performance', '{"department": "Operations", "efficiency": 96, "satisfaction": 92, "growth": 15}'),
('monthly', 'performance', '{"department": "BRM", "efficiency": 91, "satisfaction": 95, "growth": 18}'),
('monthly', 'performance', '{"department": "HR", "efficiency": 91, "satisfaction": 87, "growth": 8}'),
('monthly', 'performance', '{"department": "Finance", "efficiency": 78, "satisfaction": 85, "growth": 6}'),
('quarterly', 'quarterly', '{"quarter": "Q1 2024", "revenue": "AED 5,85,45,230", "policies": 2150, "satisfaction": 91, "growth": "+15.2%"}'),
('quarterly', 'quarterly', '{"quarter": "Q2 2024", "revenue": "AED 6,25,78,450", "policies": 2280, "satisfaction": 93, "growth": "+18.8%"}'),
('quarterly', 'quarterly', '{"quarter": "Q3 2024", "revenue": "AED 6,89,32,180", "policies": 2395, "satisfaction": 92, "growth": "+22.1%"}'),
('quarterly', 'quarterly', '{"quarter": "Q4 2024", "revenue": "AED 7,45,67,890", "policies": 2567, "satisfaction": 94, "growth": "+25.6%"}'),
('monthly', 'distribution', '{"name": "Sales & Marketing", "value": 30, "color": "#3b82f6"}'),
('monthly', 'distribution', '{"name": "Operations", "value": 25, "color": "#10b981"}'),
('monthly', 'distribution', '{"name": "BRM", "value": 20, "color": "#8b5cf6"}'),
('monthly', 'distribution', '{"name": "HR Management", "value": 15, "color": "#f59e0b"}'),
('monthly', 'distribution', '{"name": "Finance", "value": 10, "color": "#ef4444"}'),
('monthly', 'trends', '{"month": "Jan", "policies": 7200, "claims": 890, "employees": 1180}'),
('monthly', 'trends', '{"month": "Feb", "policies": 7450, "claims": 920, "employees": 1195}'),
('monthly', 'trends', '{"month": "Mar", "policies": 7680, "claims": 875, "employees": 1210}'),
('monthly', 'trends', '{"month": "Apr", "policies": 7920, "claims": 945, "employees": 1225}'),
('monthly', 'trends', '{"month": "May", "policies": 8150, "claims": 980, "employees": 1235}'),
('monthly', 'trends', '{"month": "Jun", "policies": 8390, "claims": 1020, "employees": 1247}'),
('yearly', 'competitive', '{"metric": "Market Share", "ourValue": "18.5%", "industry": "12.3%", "performance": "excellent"}'),
('yearly', 'competitive', '{"metric": "Claims Processing Time", "ourValue": "2.4 days", "industry": "4.1 days", "performance": "excellent"}'),
('yearly', 'competitive', '{"metric": "Customer Retention", "ourValue": "94.2%", "industry": "87.8%", "performance": "excellent"}'),
('yearly', 'competitive', '{"metric": "Employee Satisfaction", "ourValue": "87%", "industry": "78%", "performance": "good"}');

-- =====================================================
-- Seed Data - Alerts
-- =====================================================
INSERT INTO "ManagementAlert" ("Type", "Title", "Message", "Department", "Severity", "Status", "ActionRequired") VALUES
('System Alert', 'High Server Load', 'Server CPU usage exceeded 85% threshold', 'IT Operations', 'high', 'active', true),
('Operational Alert', 'Database Connection Timeout', 'Primary database experiencing intermittent timeouts', 'Database Admin', 'medium', 'active', true),
('Network Alert', 'API Response Time Degradation', 'API gateway response time increased by 40%', 'Network Team', 'medium', 'active', false),
('HR Alert', 'Employee Attendance Drop', 'Attendance rate dropped below 90% in Sales department', 'HR Management', 'low', 'resolved', false);

-- =====================================================
-- Seed Data - Approvals
-- =====================================================
INSERT INTO "ManagementApproval" ("ApprovalCode", "Type", "Department", "Requestor", "Description", "Details", "Amount", "Priority", "Status", "DueDate") VALUES
('APV-001', 'Variation Approval', 'Sales & Marketing', 'Sarah Johnson', 'Policy coverage increase for corporate client XYZ', 'Request to increase coverage limit from AED 500k to AED 550k', 'AED 50,000', 'high', 'pending', NOW() + INTERVAL '3 days'),
('APV-002', 'Pre-authorization', 'Operations', 'Michael Chen', 'Emergency medical treatment authorization', 'Emergency cardiac procedure for policy holder #MH-456789', 'AED 25,000', 'urgent', 'pending', NOW() + INTERVAL '1 day'),
('APV-003', 'Budget Approval', 'Finance & Accounting', 'Lisa Rodriguez', 'Q1 Marketing campaign budget allocation', 'Digital marketing and brand awareness campaign for Q1 2024', 'AED 150,000', 'medium', 'pending', NOW() + INTERVAL '5 days'),
('APV-004', 'Employee Hiring', 'HR Management', 'David Wilson', 'Senior Developer position approval', 'Hiring approval for Senior Full-Stack Developer - IT Department', 'AED 8,500/month', 'medium', 'pending', NOW() + INTERVAL '7 days'),
('APV-005', 'Investment Approval', 'Business Relationship Management', 'Emma Davis', 'Technology infrastructure upgrade', 'Server infrastructure and security system upgrade', 'AED 200,000', 'high', 'pending', NOW() + INTERVAL '4 days'),
('APV-006', 'Policy Exception', 'Operations', 'James Thompson', 'Coverage extension for high-risk client', 'Special coverage terms for client in high-risk industry', 'AED 75,000', 'medium', 'pending', NOW() + INTERVAL '6 days');

-- =====================================================
-- Seed Data - Chat Messages (Sample)
-- =====================================================
INSERT INTO "ManagementChatMessage" ("SessionId", "UserId", "Role", "Content") VALUES
('session_default', 'system', 'assistant', 'Hello! I am your AI assistant for MaxHealth Management Dashboard. How can I help you today?');

-- =====================================================
-- Grant Permissions (Optional - adjust as needed)
-- =====================================================
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "your-user";
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "your-user";