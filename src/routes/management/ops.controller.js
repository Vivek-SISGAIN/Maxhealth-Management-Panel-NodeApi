/**
 * Management Ops / Booking / AML Insights routes.
 * DB-backed (shared Postgres) — CPS NetPremium only, no TargetPremium.
 */
const { Router } = require("express");
const opsInsights = require("../../services/opsInsights.service");
const opsProxy = require("../../services/opsProxy.service");

const router = Router();

function aedHint(n) {
  return `AED ${Number(n || 0).toLocaleString("en-AE", { maximumFractionDigits: 0 })}`;
}

/** GET /management/ops/overview */
router.get("/ops/overview", async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || undefined;
    const dateTo = req.query.dateTo || undefined;
    const [kpis, live] = await Promise.all([
      opsInsights.getDeptKpis({ dateFrom, dateTo }),
      opsProxy.getOpsInsights(req.headers || {}).catch(() => ({ available: false })),
    ]);
    res.json({
      success: true,
      data: {
        available: true,
        liveAvailable: Boolean(live?.available),
        kpis: [
          { id: "total", label: "Confirmed (Ops)", value: kpis.total, hint: "Status=3 unique" },
          { id: "notBooked", label: "In Ops queue", value: kpis.notBooked, hint: "Not fully booked" },
          { id: "opsBooked", label: "Ops booked", value: kpis.opsBooked, hint: "BookingStatus" },
          { id: "pendingAml", label: "Pending AML", value: kpis.pendingAml, hint: "Stages 1–4" },
          { id: "booking", label: "Booking progress", value: kpis.bookingProgress, hint: "Stages 5–11" },
          { id: "completed", label: "Stage completed", value: kpis.stageCompleted },
          { id: "sla", label: "SLA alerts", value: kpis.slaAlerts, hint: "Fresh > 7 days" },
          {
            id: "premium",
            label: "CPS net premium",
            value: kpis.totalPremium,
            format: "aed",
            hint: "CasePremiumSummary only",
          },
        ],
        stats: kpis,
        live,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Ops overview failed" });
  }
});

/** GET /management/ops/cases?mode=operations|ops-sla */
router.get("/ops/cases", async (req, res) => {
  try {
    const mode = req.query.mode === "ops-sla" ? "ops-sla" : "operations";
    const data = await opsInsights.listCases({
      mode,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Ops cases failed" });
  }
});

/** GET /management/booking/overview */
router.get("/booking/overview", async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || undefined;
    const dateTo = req.query.dateTo || undefined;
    const kpis = await opsInsights.getDeptKpis({ dateFrom, dateTo });
    res.json({
      success: true,
      data: {
        available: true,
        kpis: [
          { id: "pipeline", label: "Booking pipeline", value: kpis.bookingProgress, hint: "Stages 5–11" },
          { id: "opsBooked", label: "Fully booked", value: kpis.opsBooked, hint: "BookingStatus" },
          { id: "completed", label: "Stage completed", value: kpis.stageCompleted },
          { id: "fresh", label: "Fresh", value: kpis.fresh },
          { id: "pendingAml", label: "Still in AML", value: kpis.pendingAml },
          { id: "sla", label: "SLA alerts", value: kpis.slaAlerts },
          {
            id: "bookingPrem",
            label: "Pipeline premium",
            value: kpis.bookingPremium,
            format: "aed",
            hint: "CPS net",
          },
          {
            id: "bookedPrem",
            label: "Booked premium",
            value: kpis.bookedPremium,
            format: "aed",
            hint: "CPS net",
          },
        ],
        stats: kpis,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Booking overview failed" });
  }
});

/** GET /management/booking/cases?mode=booking-pipeline|booking-completed|booking */
router.get("/booking/cases", async (req, res) => {
  try {
    const q = String(req.query.mode || "booking-pipeline");
    const mode =
      q === "booking-completed" || q === "completed"
        ? "booking-completed"
        : "booking-pipeline";
    const data = await opsInsights.listCases({
      mode,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Booking cases failed" });
  }
});

/** GET /management/aml/overview */
router.get("/aml/overview", async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || undefined;
    const dateTo = req.query.dateTo || undefined;
    const kpis = await opsInsights.getDeptKpis({ dateFrom, dateTo });
    res.json({
      success: true,
      data: {
        available: true,
        kpis: [
          { id: "queue", label: "AML queue", value: kpis.pendingAml, hint: "Stages 1–4 ⊂ Ops" },
          { id: "cleared", label: "Past AML", value: kpis.bookingProgress + kpis.stageCompleted + kpis.opsBooked },
          { id: "opsTotal", label: "Ops confirmed", value: kpis.total, hint: "Unique — do not add AML" },
          { id: "opsBooked", label: "Ops booked", value: kpis.opsBooked },
          {
            id: "amlPrem",
            label: "AML queue premium",
            value: kpis.amlPremium,
            format: "aed",
            hint: "CPS net",
          },
          { id: "note", label: "Rule", value: "AML ⊂ Operations", format: "text" },
        ],
        stats: kpis,
        note: aedHint(kpis.amlPremium),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "AML overview failed" });
  }
});

/** GET /management/aml/queue?mode=aml|aml-cleared */
router.get("/aml/queue", async (req, res) => {
  try {
    const mode = req.query.mode === "aml-cleared" ? "aml-cleared" : "aml";
    const data = await opsInsights.listCases({
      mode,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "AML queue failed" });
  }
});

module.exports = router;
