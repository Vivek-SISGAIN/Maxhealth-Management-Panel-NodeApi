const { Router } = require("express");
const live = require("../../services/liveInsights.service");

const router = Router();

/** GET /management/departments — live BRM / Medical / HR / Ops cards */
router.get("/departments", async (req, res) => {
  try {
    const data = await live.getDepartmentsLive({
      dateFrom: req.query.dateFrom || req.query.from,
      dateTo: req.query.dateTo || req.query.to,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[departments]", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch departments" });
  }
});

router.get("/departments/:name/metrics", async (req, res) => {
  try {
    const all = await live.getDepartmentsLive();
    const dept = all.departments.find(
      (d) => d.name.toLowerCase() === decodeURIComponent(req.params.name).toLowerCase() || d.id === req.params.name,
    );
    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });
    res.json({ success: true, data: dept });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch metrics" });
  }
});

module.exports = router;
