/**
 * Management → HRMS proxy service.
 * Forwards Authorization so HRMS verifies the Management JWT (role mapped to HR).
 */
const axios = require("axios");

const HRMS_BASE = (
  process.env.HRMS_SERVICE_URL ||
  process.env.HRMS_CORE_BASE_URL ||
  "http://localhost:2811"
).replace(/\/$/, "");

const TIMEOUT_MS = Math.max(
  parseInt(process.env.HRMS_PROXY_TIMEOUT_MS || "120000", 10) || 120000,
  30000,
);

function authHeader(headers = {}) {
  const auth =
    headers.authorization ||
    headers.Authorization ||
    "";
  return auth ? { Authorization: auth } : {};
}

async function proxyHrms(method, path, { query, body, headers } = {}) {
  const url = `${HRMS_BASE}/${String(path).replace(/^\//, "")}`;
  const res = await axios({
    method,
    url,
    params: query,
    data: body,
    headers: {
      ...authHeader(headers),
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-gateway-role": headers["x-gateway-role"] || "Management",
    },
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const msg =
      res.data?.message ||
      res.data?.error ||
      `HRMS proxy failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = res.data;
    throw err;
  }

  return res.data?.data !== undefined ? res.data : res.data;
}

module.exports = {
  listLeave: (query, headers) =>
    proxyHrms("get", "leave", { query, headers }),
  actionLeave: (id, body, headers) =>
    proxyHrms("patch", `leave/${id}/action`, { body, headers }),
  listApprovals: (query, headers) =>
    proxyHrms("get", "approvals", { query, headers }),
  approvalStats: (headers) =>
    proxyHrms("get", "approvals/stats", { headers }),
  actionApproval: (id, body, headers) =>
    proxyHrms("patch", `approvals/${id}/action`, { body, headers }),
  escalateApprovals: (body, headers) =>
    proxyHrms("post", "approvals/escalate", { body, headers }),
  hrOpsDashboard: (headers) =>
    proxyHrms("get", "hr-ops/dashboard", { headers }),
  listEmployees: (query, headers) =>
    proxyHrms("get", "employees", { query, headers }),
  listOnboarding: (query, headers) =>
    proxyHrms("get", "hr-ops/onboarding", { query, headers }),
  listAttendance: (query, headers) =>
    proxyHrms("get", "attendance", { query, headers }),
  attendanceReport: (query, headers) =>
    proxyHrms("get", "reports/attendance", { query, headers }),
  listAppraisals: (query, headers) =>
    proxyHrms("get", "performance/appraisals", { query, headers }),
  headcountReport: (headers) =>
    proxyHrms("get", "reports/headcount", { headers }),
  leaveReport: (query, headers) =>
    proxyHrms("get", "reports/leave", { query, headers }),
  departmentAnalytics: (headers) =>
    proxyHrms("get", "reports/department-analytics", { headers }),
};
