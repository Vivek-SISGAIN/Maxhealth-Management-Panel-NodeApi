/**
 * Short-lived in-memory cache for GET /management/executive.
 * Redis (when configured) is preferred inside brmInsights; this covers the full payload.
 */
const TTL_MS = Math.max(
  parseInt(process.env.EXEC_OVERVIEW_CACHE_SEC || "45", 10) || 45,
  0,
) * 1000;

const store = new Map();

function cacheKey(dateFrom, dateTo) {
  return `v4|${dateFrom || ""}|${dateTo || ""}`;
}

function get(dateFrom, dateTo) {
  if (TTL_MS <= 0) return null;
  const key = cacheKey(dateFrom, dateTo);
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit.data;
}

function set(dateFrom, dateTo, data) {
  if (TTL_MS <= 0) return;
  const key = cacheKey(dateFrom, dateTo);
  store.set(key, { at: Date.now(), data });
  if (store.size > 24) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) store.delete(oldest[0]);
  }
}

function clear() {
  store.clear();
}

module.exports = { get, set, clear, TTL_MS };
