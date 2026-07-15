const { Router } = require("express");
const live = require("../../services/liveInsights.service");

const router = Router();

/** GET /management/analytics — live trends / distribution / radar scores */
router.get("/analytics", async (req, res) => {
  try {
    const data = await live.getAnalyticsLive({
      dateFrom: req.query.dateFrom || req.query.from,
      dateTo: req.query.dateTo || req.query.to,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[analytics]", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch analytics" });
  }
});

router.get("/analytics/revenue", async (req, res) => {
  try {
    const data = await live.getAnalyticsLive(req.query);
    res.json({ success: true, data: data.revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch revenue analytics" });
  }
});

router.get("/analytics/performance", async (req, res) => {
  try {
    const data = await live.getAnalyticsLive(req.query);
    res.json({ success: true, data: data.performance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch performance analytics" });
  }
});

router.get("/analytics/distribution", async (req, res) => {
  try {
    const data = await live.getAnalyticsLive(req.query);
    res.json({ success: true, data: data.distribution });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch distribution" });
  }
});

router.get("/analytics/trends", async (req, res) => {
  try {
    const data = await live.getAnalyticsLive(req.query);
    res.json({ success: true, data: data.trends });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch trends" });
  }
});

module.exports = router;
