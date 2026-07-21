/**
 * Management BRM Dashboard — thin proxy to the real BRM workbasket APIs.
 * Do NOT reimplement SQL here; BRM NodeAPI owns master_data / my_renewal logic.
 */
const axios = require("axios");

const BRM_BASE = (
  process.env.BRM_SERVICE_URL ||
  process.env.BRM_CORE_BASE_URL ||
  "http://localhost:2805"
).replace(/\/$/, "");

const TIMEOUT_MS = Math.max(
  parseInt(process.env.BRM_DASHBOARD_PROXY_TIMEOUT_MS || "300000", 10) || 300000,
  60000,
);

async function proxyBrmWorkbasket(path, { query = {}, headers = {} } = {}) {
  const url = `${BRM_BASE}/workbasket/${String(path).replace(/^\//, "")}`;
  const gatewayUserId =
    headers["x-gateway-user-id"] ||
    headers["x-user-id"] ||
    "management-dashboard";

  const res = await axios.get(url, {
    params: query,
    headers: {
      "x-gateway-user-id": gatewayUserId,
      "x-gateway-role": headers["x-gateway-role"] || "Management",
      Accept: "application/json",
    },
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const msg =
      res.data?.message ||
      res.data?.error ||
      `BRM workbasket proxy failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = res.data;
    throw err;
  }

  // BRM returns { success, data } — pass through inner data
  return res.data?.data !== undefined ? res.data.data : res.data;
}

async function getDashboardExecutives(headers) {
  return proxyBrmWorkbasket("get_all_brm_executives", { headers });
}

async function getDashboardMasterData(query, headers) {
  return proxyBrmWorkbasket("master_data", {
    query: {
      all: "true",
      scope: query.scope || "all",
      brmUserIds: query.brmUserIds,
      includeUnassigned: query.includeUnassigned,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    },
    headers,
  });
}

async function getDashboardRenewals(query, headers) {
  return proxyBrmWorkbasket("my_renewal", {
    query: {
      scope: query.scope || "all",
      brmUserIds: query.brmUserIds,
      includeUnassigned: query.includeUnassigned,
      search: query.search,
      policyType: query.policyType || "Group",
      limit: query.limit,
      offset: query.offset,
    },
    headers,
  });
}

async function getDashboardExportColumns(dataset, headers) {
  return proxyBrmWorkbasket("export_columns", {
    query: { dataset: dataset || "combined" },
    headers,
  });
}

module.exports = {
  getDashboardExecutives,
  getDashboardMasterData,
  getDashboardRenewals,
  getDashboardExportColumns,
};
