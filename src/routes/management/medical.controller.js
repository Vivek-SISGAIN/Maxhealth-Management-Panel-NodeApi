const { Router } = require("express");
const medical = require("../../services/medicalInsights.service");

const router = Router();

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, err, fallback = "Medical insights request failed") => {
  console.error("[management/medical]", err);
  return res.status(500).json({
    success: false,
    message: err?.message || fallback,
  });
};

/** GET /management/medical/overview */
router.get("/medical/overview", async (req, res) => {
  try {
    const data = await medical.getOverviewSnapshot({
      status: req.query.status,
      priority: req.query.priority,
      broker: req.query.broker,
      assignedDoctor: req.query.assignedDoctor || req.query.doctor,
      dateFrom: req.query.dateFrom || req.query.from,
      dateTo: req.query.dateTo || req.query.to,
    });
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/medical/filter-options */
router.get("/medical/filter-options", async (_req, res) => {
  try {
    const data = await medical.getFilterOptions();
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/medical/doctor-load */
router.get("/medical/doctor-load", async (_req, res) => {
  try {
    const data = await medical.getDoctorLoad();
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
