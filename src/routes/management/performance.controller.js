const { Router } = require("express");
const live = require("../../services/liveInsights.service");

const router = Router();

/** GET /management/performance — live annual targets / quarterly / insights */
router.get("/performance", async (req, res) => {
  try {
    const data = await live.getPerformanceLive({
      dateFrom: req.query.dateFrom || req.query.from,
      dateTo: req.query.dateTo || req.query.to,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[performance]", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch performance" });
  }
});

router.get("/performance/kpis", async (req, res) => {
  try {
    const data = await live.getPerformanceLive({
      dateFrom: req.query.dateFrom || req.query.from,
      dateTo: req.query.dateTo || req.query.to,
    });
    res.json({ success: true, data: data.kpis || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch KPIs" });
  }
});

module.exports = router;
