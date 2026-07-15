const { Router } = require("express");
const brm = require("../../services/brmInsights.service");

const router = Router();

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, err, fallback = "BRM insights request failed") => {
  console.error("[management/brm]", err);
  return res.status(500).json({
    success: false,
    message: err?.message || fallback,
  });
};

const q = (req) => ({
  dateFrom: req.query.dateFrom || req.query.from || undefined,
  dateTo: req.query.dateTo || req.query.to || undefined,
  executiveId: req.query.executiveId || undefined,
  brmName: req.query.brmName || undefined,
  search: req.query.search || undefined,
  type: req.query.type || "new",
  status: req.query.status || undefined,
  dealStatus: req.query.dealStatus,
  policyType: req.query.policyType || "Group",
  period: req.query.period === "yearly" ? "yearly" : "monthly",
  limit: req.query.limit,
  offset: req.query.offset,
  executiveIds: req.query.executiveIds,
  compareFrom: req.query.compareFrom,
  compareTo: req.query.compareTo,
});

/** GET /management/brm/overview */
router.get("/brm/overview", async (req, res) => {
  try {
    const data = await brm.getOverviewSnapshot(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/executives */
router.get("/brm/executives", async (_req, res) => {
  try {
    const data = await brm.getExecutives();
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/summary/cards */
router.get("/brm/summary/cards", async (req, res) => {
  try {
    const data = await brm.getSummaryCards(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/summary/list */
router.get("/brm/summary/list", async (req, res) => {
  try {
    const data = await brm.getSummaryList(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/cases */
router.get("/brm/cases", async (req, res) => {
  try {
    const data = await brm.getCases(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/by-executive */
router.get("/brm/by-executive", async (req, res) => {
  try {
    const data = await brm.getByExecutive(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/trends */
router.get("/brm/trends", async (req, res) => {
  try {
    const data = await brm.getTrends(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/renewals */
router.get("/brm/renewals", async (req, res) => {
  try {
    const data = await brm.getRenewals(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/brm/compare */
router.get("/brm/compare", async (req, res) => {
  try {
    const data = await brm.getCompare(q(req));
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
