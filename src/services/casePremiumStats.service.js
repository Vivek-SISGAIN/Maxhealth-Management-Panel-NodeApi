/**
 * Thin re-exports + CPS-only premium helpers used by executive overview.
 * Premium = CasePremiumSummary.NetPremium only (never TargetPremium).
 */
const opsInsights = require("./opsInsights.service");
const { prisma } = require("../lib/prisma");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getOpsBookedStats(opts) {
  return opsInsights.getOpsBookedStats(opts);
}

async function getConfirmedNotBookedStats(opts) {
  return opsInsights.getConfirmedNotBookedStats(opts);
}

/** Master production — GrossPremium + DISTINCT sheets (All Summary style). */
async function getMasterBookedStats({ dateFrom, dateTo } = {}) {
  const hasDates = Boolean(dateFrom && dateTo);
  const sql = hasDates
    ? `
      SELECT
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
        ), 0)::float AS "bookedPremium",
        COUNT(DISTINCT "TechnicalSheetNumber") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "bookedCount"
      FROM public."MasterDataLayer"
      WHERE "PolicyEffectiveDate" >= $1::date
        AND "PolicyEffectiveDate" <= $2::date
      `
    : `
      SELECT
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
        ), 0)::float AS "bookedPremium",
        COUNT(DISTINCT "TechnicalSheetNumber") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "bookedCount"
      FROM public."MasterDataLayer"
      `;
  try {
    const rows = hasDates
      ? await prisma.$queryRawUnsafe(sql, dateFrom, dateTo)
      : await prisma.$queryRawUnsafe(sql);
    return {
      bookedCount: toNum(rows?.[0]?.bookedCount),
      bookedPremium: toNum(rows?.[0]?.bookedPremium),
    };
  } catch (e) {
    console.warn("[casePremiumStats] master booked failed:", e?.message || e);
    return { bookedCount: 0, bookedPremium: 0 };
  }
}

module.exports = {
  getOpsBookedStats,
  getConfirmedNotBookedStats,
  getMasterBookedStats,
};
