const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

// Transform database fields to frontend format
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

router.get("/performance", async (req, res) => {
  try {
    const kpis = await prisma.managementKPI.findMany({ orderBy: { RecordedAt: 'desc' }, take: 100 });
    const latestByName = {};
    kpis.forEach(k => { if (!latestByName[k.Name]) latestByName[k.Name] = k; });

    const quarterlySnapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Type: 'quarterly' },
      orderBy: { RecordedAt: 'desc' },
      take: 4
    });

    const compSnapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Type: 'competitive' },
      orderBy: { RecordedAt: 'desc' },
      take: 1
    });

    res.json({ success: true, data: { 
      kpis: Object.values(latestByName).map(transformKPI), 
      quarterly: quarterlySnapshots.map(s => ({ id: s.Id, period: s.Period, data: s.Data, recordedAt: s.RecordedAt })),
      competitive: compSnapshots[0]?.Data ?? null 
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch performance data" });
  }
});

router.post("/performance/kpis", async (req, res) => {
  try {
    const body = Array.isArray(req.body) ? req.body : [req.body];
    // Transform camelCase to PascalCase for database
    const dbData = body.map(item => ({
      Name: item.name,
      Value: item.value,
      Change: item.change,
      Trend: item.trend,
      Period: item.period,
      Category: item.category,
      Department: item.department
    }));
    const inserted = await prisma.managementKPI.createMany({ data: dbData });
    res.status(201).json({ success: true, data: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to insert KPIs" });
  }
});

router.get("/performance/kpis", async (req, res) => {
  try {
    const kpis = await prisma.managementKPI.findMany({ orderBy: { RecordedAt: 'desc' } });
    const latestByName = {};
    kpis.forEach(k => { if (!latestByName[k.Name]) latestByName[k.Name] = k; });
    res.json({ success: true, data: Object.values(latestByName).map(transformKPI) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch KPIs" });
  }
});

module.exports = router;