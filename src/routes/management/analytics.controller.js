const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

// Transform database fields to frontend format
const transformSnapshot = (snapshot) => ({
  id: snapshot.Id,
  period: snapshot.Period,
  type: snapshot.Type,
  data: snapshot.Data,
  recordedAt: snapshot.RecordedAt
});

router.get("/analytics", async (req, res) => {
  try {
    const { period = "monthly", type } = req.query;
    const where = { Period: period };
    if (type) where.Type = type;

    const snapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where,
      orderBy: { RecordedAt: 'desc' },
      take: 50
    });

    const byType = {};
    snapshots.forEach(s => { if (!byType[s.Type]) byType[s.Type] = s; });

    // Transform snapshots for frontend
    const transformed = {
      revenue: snapshots.filter(s => s.Type === 'revenue').map(transformSnapshot),
      performance: snapshots.filter(s => s.Type === 'performance').map(transformSnapshot),
      distribution: snapshots.filter(s => s.Type === 'distribution').map(transformSnapshot),
      trends: snapshots.filter(s => s.Type === 'trends').map(transformSnapshot)
    };

    res.json({ success: true, data: { period, ...transformed } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch analytics" });
  }
});

router.post("/analytics/snapshot", async (req, res) => {
  try {
    const { period, type, data } = req.body;
    if (!period || !type || !data) {
      res.status(400).json({ success: false, message: "period, type and data are required" });
      return;
    }
    const inserted = await prisma.managementAnalyticsSnapshot.create({
      data: { Period: period, Type: type, Data: data }
    });
    res.status(201).json({ success: true, data: transformSnapshot(inserted) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to create snapshot" });
  }
});

router.get("/analytics/revenue", async (req, res) => {
  try {
    const { period = "monthly" } = req.query;
    const snapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Period: period, Type: 'revenue' },
      orderBy: { RecordedAt: 'asc' }
    });
    res.json({ success: true, data: snapshots.map(transformSnapshot) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch revenue analytics" });
  }
});

router.get("/analytics/performance", async (req, res) => {
  try {
    const snapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Type: 'performance' },
      orderBy: { RecordedAt: 'asc' }
    });
    res.json({ success: true, data: snapshots.map(transformSnapshot) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch performance analytics" });
  }
});

router.get("/analytics/distribution", async (req, res) => {
  try {
    const snapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Type: 'distribution' },
      orderBy: { RecordedAt: 'desc' }
    });
    res.json({ success: true, data: snapshots.map(transformSnapshot) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch distribution analytics" });
  }
});

router.get("/analytics/trends", async (req, res) => {
  try {
    const snapshots = await prisma.managementAnalyticsSnapshot.findMany({
      where: { Type: 'trends' },
      orderBy: { RecordedAt: 'asc' }
    });
    res.json({ success: true, data: snapshots.map(transformSnapshot) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch trends analytics" });
  }
});

module.exports = router;