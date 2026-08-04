const { Router } = require("express");
const hrms = require("../../services/hrmsProxy.service");

const router = Router();

const ok = (res, data) => {
  // If proxied payload already has { success, data }, unwrap once
  if (data && typeof data === "object" && data.success !== undefined && data.data !== undefined) {
    return res.json({ success: true, data: data.data, meta: data.meta });
  }
  return res.json({ success: true, data });
};

const fail = (res, err, fallback = "HRMS request failed") => {
  console.error("[management/hrms]", err?.message || err);
  const status = err?.status && Number.isFinite(err.status) ? err.status : 500;
  return res.status(status).json({
    success: false,
    message: err?.message || fallback,
    payload: err?.payload,
  });
};

const hdr = (req) => req.headers || {};

/** GET /management/hrms/leave */
router.get("/hrms/leave", async (req, res) => {
  try {
    return ok(res, await hrms.listLeave(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** PATCH /management/hrms/leave/:id/action */
router.patch("/hrms/leave/:id/action", async (req, res) => {
  try {
    return ok(res, await hrms.actionLeave(req.params.id, req.body, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/approvals */
router.get("/hrms/approvals", async (req, res) => {
  try {
    return ok(res, await hrms.listApprovals(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/approvals/stats */
router.get("/hrms/approvals/stats", async (req, res) => {
  try {
    return ok(res, await hrms.approvalStats(hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** PATCH /management/hrms/approvals/:id/action */
router.patch("/hrms/approvals/:id/action", async (req, res) => {
  try {
    return ok(res, await hrms.actionApproval(req.params.id, req.body, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** POST /management/hrms/approvals/escalate */
router.post("/hrms/approvals/escalate", async (req, res) => {
  try {
    return ok(res, await hrms.escalateApprovals(req.body, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/overview */
router.get("/hrms/overview", async (req, res) => {
  try {
    const [dashboard, approvalStats] = await Promise.all([
      hrms.hrOpsDashboard(hdr(req)).catch(() => null),
      hrms.approvalStats(hdr(req)).catch(() => null),
    ]);
    return ok(res, { dashboard, approvalStats });
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/employees */
router.get("/hrms/employees", async (req, res) => {
  try {
    return ok(res, await hrms.listEmployees(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/onboarding */
router.get("/hrms/onboarding", async (req, res) => {
  try {
    return ok(res, await hrms.listOnboarding(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/attendance */
router.get("/hrms/attendance", async (req, res) => {
  try {
    return ok(res, await hrms.listAttendance(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/reports/attendance */
router.get("/hrms/reports/attendance", async (req, res) => {
  try {
    return ok(res, await hrms.attendanceReport(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/performance/appraisals */
router.get("/hrms/performance/appraisals", async (req, res) => {
  try {
    return ok(res, await hrms.listAppraisals(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/reports/headcount */
router.get("/hrms/reports/headcount", async (req, res) => {
  try {
    return ok(res, await hrms.headcountReport(hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/reports/leave */
router.get("/hrms/reports/leave", async (req, res) => {
  try {
    return ok(res, await hrms.leaveReport(req.query, hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /management/hrms/reports/departments */
router.get("/hrms/reports/departments", async (req, res) => {
  try {
    return ok(res, await hrms.departmentAnalytics(hdr(req)));
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
