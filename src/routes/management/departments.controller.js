const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

// Transform database fields to frontend format
const transformMetric = (metric) => ({
  id: metric.Id,
  departmentName: metric.DepartmentName,
  metricKey: metric.MetricKey,
  metricValue: metric.MetricValue,
  recordedAt: metric.RecordedAt,
  createdAt: metric.CreatedAt
});

router.get("/departments", async (req, res) => {
  try {
    const { department } = req.query;
    const where = department ? { DepartmentName: department } : {};
    const metrics = await prisma.managementDepartmentMetric.findMany({
      where,
      orderBy: [{ DepartmentName: 'asc' }, { RecordedAt: 'desc' }]
    });

    const grouped = {};
    metrics.forEach(m => {
      if (!grouped[m.DepartmentName]) grouped[m.DepartmentName] = [];
      grouped[m.DepartmentName].push(m);
    });

    const departments = Object.keys(grouped).map(name => {
      const rows = grouped[name];
      const latestByKey = {};
      rows.forEach(r => { if (!latestByKey[r.MetricKey]) latestByKey[r.MetricKey] = r; });
      const metricsObj = {};
      Object.keys(latestByKey).forEach(key => { metricsObj[key] = latestByKey[key].MetricValue; });
      return { name, metrics: metricsObj };
    });

    res.json({ success: true, data: departments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch department metrics" });
  }
});

router.get("/departments/:name/metrics", async (req, res) => {
  try {
    const metrics = await prisma.managementDepartmentMetric.findMany({
      where: { DepartmentName: req.params.name },
      orderBy: { RecordedAt: 'desc' }
    });
    res.json({ success: true, data: metrics.map(transformMetric) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch metrics" });
  }
});

router.post("/departments/metrics", async (req, res) => {
  try {
    const body = Array.isArray(req.body) ? req.body : [req.body];
    // Transform camelCase to PascalCase for database
    const dbData = body.map(item => ({
      DepartmentName: item.departmentName,
      MetricKey: item.metricKey,
      MetricValue: item.metricValue
    }));
    await prisma.managementDepartmentMetric.createMany({ data: dbData });
    res.status(201).json({ success: true, data: body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to insert metrics" });
  }
});

module.exports = router;