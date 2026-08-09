/**
 * Management → Operations / AML proxy.
 * Soft-fails so executive dashboard still renders if Ops is down.
 */
const axios = require("axios");

const OPS_BASE = (
  process.env.OPERATION_SERVICE_URL ||
  process.env.OPERATION_CORE_BASE_URL ||
  "http://localhost:2807"
).replace(/\/$/, "");

const TIMEOUT_MS = Math.max(
  parseInt(process.env.OPS_PROXY_TIMEOUT_MS || "60000", 10) || 60000,
  15000,
);

function authHeaders(headers = {}) {
  const auth = headers.authorization || headers.Authorization || "";
  return {
    ...(auth ? { Authorization: auth } : {}),
    "x-gateway-user-id":
      headers["x-gateway-user-id"] || headers["x-user-id"] || "management-dashboard",
    "x-gateway-role": headers["x-gateway-role"] || "Management",
    Accept: "application/json",
  };
}

async function getJson(path, { query, headers } = {}) {
  const url = `${OPS_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await axios.get(url, {
    params: query,
    headers: authHeaders(headers),
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const err = new Error(
      res.data?.message || res.data?.error || `Ops proxy failed (${res.status})`,
    );
    err.status = res.status;
    throw err;
  }
  return res.data;
}

/** Booking / operations pipeline aggregates (counts only — no premium on list API). */
async function getOperationsSnapshot(headers = {}) {
  const raw = await getJson("/api/operations", {
    query: { page: 1, limit: 1 },
    headers,
  });
  return {
    total: Number(raw?.pagination?.total ?? raw?.total ?? 0),
    caseProgress: Number(raw?.caseProgress ?? 0),
    caseCompleted: Number(raw?.caseCompleted ?? 0),
    pendingAml: Number(raw?.pendingAml ?? 0),
    freshcase: Number(raw?.freshcase ?? 0),
    activeCase: Number(raw?.activeCase ?? 0),
    slaalert: Number(raw?.slaalert ?? 0),
  };
}

/** AML new-booking queue size. */
async function getAmlSnapshot(headers = {}) {
  const raw = await getJson("/api/aml/new-bookings", {
    query: { page: 1, limit: 1 },
    headers,
  });
  return {
    total: Number(raw?.total ?? raw?.pagination?.total ?? 0),
  };
}

/** Combined ops insights for executive dashboard. */
async function getOpsInsights(headers = {}) {
  const [ops, aml] = await Promise.all([
    getOperationsSnapshot(headers).catch(() => null),
    getAmlSnapshot(headers).catch(() => null),
  ]);
  return {
    booking: ops,
    aml,
    available: Boolean(ops || aml),
  };
}

/** Paginated Operations / Booking cases (Status=3 universe). */
async function listOperations(headers = {}, query = {}) {
  const raw = await getJson("/api/operations", {
    query: {
      page: query.page || 1,
      limit: query.limit || 20,
      search: query.search || undefined,
      stage: query.stage || undefined,
      status: query.status || undefined,
      onlyFresh: query.onlyFresh || undefined,
    },
    headers,
  });
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  return {
    items: rows.map(normalizeOpsRow),
    total: Number(raw?.pagination?.total ?? raw?.total ?? rows.length),
    page: Number(raw?.pagination?.page ?? query.page ?? 1),
    limit: Number(raw?.pagination?.limit ?? query.limit ?? 20),
    caseProgress: Number(raw?.caseProgress ?? 0),
    caseCompleted: Number(raw?.caseCompleted ?? 0),
    pendingAml: Number(raw?.pendingAml ?? 0),
    freshcase: Number(raw?.freshcase ?? 0),
    activeCase: Number(raw?.activeCase ?? 0),
    slaalert: Number(raw?.slaalert ?? 0),
  };
}

/** Paginated AML new-bookings queue. */
async function listAml(headers = {}, query = {}) {
  const raw = await getJson("/api/aml/new-bookings", {
    query: {
      page: query.page || 1,
      limit: query.limit || 20,
      search: query.search || undefined,
    },
    headers,
  });
  const rows = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw)
        ? raw
        : [];
  return {
    items: rows.map(normalizeAmlRow),
    total: Number(raw?.total ?? raw?.pagination?.total ?? rows.length),
    page: Number(raw?.pagination?.page ?? query.page ?? 1),
    limit: Number(raw?.pagination?.limit ?? query.limit ?? 20),
  };
}

function normalizeOpsRow(row) {
  const c = row?.case || row || {};
  return {
    id: c.ID || c.id || row?.id,
    displayId: c.DisplayID || c.displayId || c.DisplayId || "—",
    clientName:
      c.ClientName ||
      c.PolicyHolder ||
      c.clientName ||
      row?.ClientName ||
      "—",
    status: c.Status ?? c.status ?? null,
    bookingStatus: Boolean(c.BookingStatus ?? c.bookingStatus),
    caseProgressStatus: c.CaseProgressStatus ?? c.caseProgressStatus ?? null,
    premium: Number(c.TargetPremium ?? c.NetPremium ?? c.premium ?? 0),
    createDate: c.CreateDate || c.createDate || null,
    lastUpdate: c.LastUpdateDate || c.lastUpdateDate || null,
    assignedBrm: c.AssignedBrmExecutive || c.assignedBrm || null,
    stageLabel: stageLabel(c.CaseProgressStatus ?? c.caseProgressStatus),
  };
}

function normalizeAmlRow(row) {
  const c = row?.case || row || {};
  return {
    id: c.ID || c.id || row?.id || row?.caseId,
    displayId: c.DisplayID || row?.displayId || row?.DisplayID || "—",
    clientName:
      c.ClientName ||
      row?.clientName ||
      row?.ClientName ||
      row?.companyName ||
      "—",
    status: c.Status ?? row?.status ?? null,
    bookingStatus: Boolean(c.BookingStatus ?? row?.bookingStatus),
    caseProgressStatus: c.CaseProgressStatus ?? row?.caseProgressStatus ?? null,
    premium: Number(c.TargetPremium ?? row?.premium ?? 0),
    createDate: c.CreateDate || row?.createDate || null,
    lastUpdate: c.LastUpdateDate || row?.lastUpdate || null,
    assignedBrm: c.AssignedBrmExecutive || row?.assignedBrm || null,
    stageLabel: "AML review",
    amlStatus: row?.amlStatus || row?.AmlStatus || row?.status || "Pending",
  };
}

function stageLabel(code) {
  const n = Number(code);
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "Fresh";
  if (n <= 4) return "AML stages";
  if (n < 12) return "Booking in progress";
  if (n === 12) return "Completed";
  return `Stage ${n}`;
}

module.exports = {
  getOperationsSnapshot,
  getAmlSnapshot,
  getOpsInsights,
  listOperations,
  listAml,
};
