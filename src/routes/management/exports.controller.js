const { Router } = require("express");
const {
  runCasesExport,
  upsertSchedule,
  listSchedules,
} = require("../../services/scheduledExport.service");
const { insertMgmtAudit } = require("../../services/mgmtAudit.service");

const router = Router();

const actor = (req) =>
  String(req.headers["x-gateway-user-id"] || "").trim() || null;

/** POST /management/exports/cases — run now (returns CSV + optional email) */
router.post("/exports/cases", async (req, res) => {
  try {
    const {
      email,
      filters,
      maskPii: maskPiiFlag,
      downloadOnly,
    } = req.body || {};
    const result = await runCasesExport({
      email: downloadOnly ? null : email,
      filters: filters || {},
      changedBy: actor(req),
      maskPiiFlag: maskPiiFlag !== false,
    });
    return res.json({
      success: true,
      data: {
        filename: result.filename,
        rowCount: result.rowCount,
        mail: result.mail,
        csv: result.csv,
      },
    });
  } catch (err) {
    console.error("[exports/cases]", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Export failed",
    });
  }
});

/** GET /management/exports/schedules */
router.get("/exports/schedules", (_req, res) => {
  return res.json({ success: true, data: listSchedules() });
});

/** POST /management/exports/schedules — light schedule (in-memory) */
router.post("/exports/schedules", async (req, res) => {
  try {
    const { email, cadenceHours, filters, id } = req.body || {};
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "email required",
      });
    }
    const row = upsertSchedule({ id, email, cadenceHours, filters });
    await insertMgmtAudit({
      eventType: "EXPORT",
      entityType: "SCHEDULE",
      caseKey: `schedule:${row.id}`,
      changedBy: actor(req),
      newValues: row,
      module: "scheduled-export",
    });
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Schedule failed",
    });
  }
});

/** POST /management/audits/log — EXPORT / PII_VIEW from FE */
router.post("/audits/log", async (req, res) => {
  try {
    const { eventType, caseKey, entityType, newValues, module } =
      req.body || {};
    const et = String(eventType || "EXPORT").toUpperCase();
    if (!["EXPORT", "PII_VIEW"].includes(et)) {
      return res.status(400).json({
        success: false,
        message: "eventType must be EXPORT or PII_VIEW",
      });
    }
    await insertMgmtAudit({
      eventType: et,
      entityType: entityType || "AUDIT",
      caseKey: caseKey || "mgmt",
      changedBy: actor(req),
      newValues: newValues || {},
      module: module || "ui",
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Audit log failed",
    });
  }
});

module.exports = router;
