/**
 * Management Ops / Booking / AML Insights — DB-backed lists + KPIs.
 * Premium = CasePremiumSummary."NetPremium" only (no TargetPremium fallback).
 */
const { prisma } = require("../lib/prisma");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function stageLabel(code, bookingStatus) {
  if (bookingStatus) return "Fully booked";
  const n = Number(code);
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "Fresh";
  if (n <= 4) return "AML stages";
  if (n < 12) return "Booking in progress";
  if (n === 12) return "Completed";
  return `Stage ${n}`;
}

const BASE_CASE = `
  COALESCE(qc."IsDeleted", false) = false
  AND COALESCE(qc."IsArchived", false) = false
`;

/** Latest version per DisplayID base + CPS net only */
function latestCte({ whereExtra = "", search = "", dateFrom, dateTo, params }) {
  const conds = [BASE_CASE, whereExtra].filter(Boolean);
  if (dateFrom) {
    params.push(dateFrom);
    conds.push(`qc."CreateDate"::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conds.push(`qc."CreateDate"::date <= $${params.length}::date`);
  }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    const p = params.length;
    conds.push(`(
      qc."DisplayID" ILIKE $${p}
      OR COALESCE(comp."Name", '') ILIKE $${p}
      OR COALESCE(crm."PolicyHolder", '') ILIKE $${p}
    )`);
  }

  return {
    sql: `
    WITH latest AS (
      SELECT DISTINCT ON (REGEXP_REPLACE(COALESCE(qc."DisplayID", qc."ID"::text), '-V[0-9]+$', ''))
        qc."ID",
        qc."DisplayID",
        qc."Status",
        qc."BookingStatus",
        qc."CaseProgressStatus",
        qc."CreateDate",
        qc."LastUpdateDate",
        qc."AssignedBrmExecutive",
        COALESCE(NULLIF(cps."NetPremium"::float, 0), 0)::float AS net_premium,
        COALESCE(NULLIF(TRIM(crm."PolicyHolder"), ''), NULLIF(TRIM(comp."Name"), ''), '—') AS client_name
      FROM public."HealthInsuranceQuotationCase" qc
      LEFT JOIN public."CasePremiumSummary" cps ON cps."CaseID" = qc."ID"
      LEFT JOIN public."Company" comp ON comp."ID" = qc."ClientID"
      LEFT JOIN LATERAL (
        SELECT c."PolicyHolder"
        FROM public."HealthInsurancePolicyCRM" c
        WHERE c."HealthInsuranceQuotationCaseID" = qc."ID"
        LIMIT 1
      ) crm ON true
      WHERE ${conds.join(" AND ")}
      ORDER BY
        REGEXP_REPLACE(COALESCE(qc."DisplayID", qc."ID"::text), '-V[0-9]+$', ''),
        COALESCE(cps."NetPremium", 0) DESC,
        qc."ID" DESC
    )
    `,
    params,
  };
}

async function getOpsBookedStats({ dateFrom, dateTo } = {}) {
  const params = [];
  const { sql } = latestCte({
    whereExtra: `COALESCE(qc."BookingStatus", false) = true`,
    dateFrom,
    dateTo,
    params,
  });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `${sql}
       SELECT COUNT(*)::int AS "bookedCount",
              COALESCE(SUM(net_premium), 0)::float AS "bookedPremium"
       FROM latest`,
      ...params,
    );
    return {
      bookedCount: toNum(rows?.[0]?.bookedCount),
      bookedPremium: toNum(rows?.[0]?.bookedPremium),
    };
  } catch (e) {
    console.warn("[opsInsights] ops booked failed:", e?.message || e);
    return { bookedCount: 0, bookedPremium: 0 };
  }
}

/**
 * Won / Confirmed = ALL Status=3 cases (Ops-booked + not booked).
 * Premium = CPS NetPremium only.
 */
async function getConfirmedNotBookedStats({ dateFrom, dateTo } = {}) {
  const params = [];
  const { sql } = latestCte({
    whereExtra: `
      qc."Status" = 3
      AND qc."DisplayID" ~ '-[BD][0-9]+'
    `,
    dateFrom,
    dateTo,
    params,
  });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `${sql}
       SELECT COUNT(*)::int AS "confirmedCount",
              COALESCE(SUM(net_premium), 0)::float AS "confirmedPremium"
       FROM latest`,
      ...params,
    );
    return {
      confirmedCount: toNum(rows?.[0]?.confirmedCount),
      confirmedPremium: toNum(rows?.[0]?.confirmedPremium),
    };
  } catch (e) {
    console.warn("[opsInsights] confirmed/won failed:", e?.message || e);
    return { confirmedCount: 0, confirmedPremium: 0 };
  }
}

/**
 * Aggregate KPIs for Operations / Booking / AML overviews.
 */
async function getDeptKpis({ dateFrom, dateTo } = {}) {
  const params = [];
  const { sql } = latestCte({
    whereExtra: `qc."Status" = 3`,
    dateFrom,
    dateTo,
    params,
  });

  try {
    const rows = await prisma.$queryRawUnsafe(
      `${sql}
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE COALESCE("BookingStatus", false) = true)::int AS ops_booked,
         COUNT(*) FILTER (WHERE COALESCE("BookingStatus", false) = false)::int AS not_booked,
         COUNT(*) FILTER (WHERE "CaseProgressStatus" = 0)::int AS fresh,
         COUNT(*) FILTER (WHERE "CaseProgressStatus" >= 1 AND "CaseProgressStatus" <= 4)::int AS pending_aml,
         COUNT(*) FILTER (WHERE "CaseProgressStatus" >= 5 AND "CaseProgressStatus" < 12)::int AS booking_progress,
         COUNT(*) FILTER (WHERE "CaseProgressStatus" = 12)::int AS stage_completed,
         COUNT(*) FILTER (
           WHERE "CaseProgressStatus" = 0
             AND "CreateDate" <= NOW() - INTERVAL '7 days'
         )::int AS sla_alerts,
         COALESCE(SUM(net_premium), 0)::float AS total_premium,
         COALESCE(SUM(net_premium) FILTER (WHERE COALESCE("BookingStatus", false) = true), 0)::float AS booked_premium,
         COALESCE(SUM(net_premium) FILTER (WHERE "CaseProgressStatus" >= 1 AND "CaseProgressStatus" <= 4), 0)::float AS aml_premium,
         COALESCE(SUM(net_premium) FILTER (WHERE "CaseProgressStatus" >= 5 AND "CaseProgressStatus" < 12), 0)::float AS booking_premium
       FROM latest`,
      ...params,
    );
    const r = rows?.[0] || {};
    return {
      total: toNum(r.total),
      opsBooked: toNum(r.ops_booked),
      notBooked: toNum(r.not_booked),
      fresh: toNum(r.fresh),
      pendingAml: toNum(r.pending_aml),
      bookingProgress: toNum(r.booking_progress),
      stageCompleted: toNum(r.stage_completed),
      slaAlerts: toNum(r.sla_alerts),
      totalPremium: toNum(r.total_premium),
      bookedPremium: toNum(r.booked_premium),
      amlPremium: toNum(r.aml_premium),
      bookingPremium: toNum(r.booking_premium),
    };
  } catch (e) {
    console.warn("[opsInsights] dept kpis failed:", e?.message || e);
    return {
      total: 0,
      opsBooked: 0,
      notBooked: 0,
      fresh: 0,
      pendingAml: 0,
      bookingProgress: 0,
      stageCompleted: 0,
      slaAlerts: 0,
      totalPremium: 0,
      bookedPremium: 0,
      amlPremium: 0,
      bookingPremium: 0,
    };
  }
}

/**
 * Paginated case list.
 * mode: operations | ops-sla | booking | booking-pipeline | booking-completed | aml | aml-cleared
 */
async function listCases({
  mode = "operations",
  page = 1,
  limit = 20,
  search = "",
  dateFrom,
  dateTo,
} = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (p - 1) * lim;

  let whereExtra = `qc."Status" = 3`;
  if (mode === "ops-sla") {
    whereExtra += ` AND qc."CaseProgressStatus" = 0 AND qc."CreateDate" <= NOW() - INTERVAL '7 days'`;
  } else if (mode === "booking" || mode === "booking-pipeline") {
    whereExtra += ` AND qc."CaseProgressStatus" >= 5 AND qc."CaseProgressStatus" < 12`;
  } else if (mode === "booking-completed") {
    whereExtra += ` AND COALESCE(qc."BookingStatus", false) = true`;
  } else if (mode === "aml") {
    whereExtra += ` AND qc."CaseProgressStatus" >= 1 AND qc."CaseProgressStatus" <= 4`;
  } else if (mode === "aml-cleared") {
    whereExtra += ` AND qc."CaseProgressStatus" >= 5`;
  }

  const params = [];
  const { sql } = latestCte({
    whereExtra,
    search,
    dateFrom,
    dateTo,
    params,
  });

  const countParams = [...params];
  const dataParams = [...params, lim, offset];
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;

  try {
    const [countRows, dataRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `${sql} SELECT COUNT(*)::int AS total FROM latest`,
        ...countParams,
      ),
      prisma.$queryRawUnsafe(
        `${sql}
         SELECT * FROM latest
         ORDER BY "LastUpdateDate" DESC NULLS LAST, "ID" DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        ...dataParams,
      ),
    ]);

    const total = toNum(countRows?.[0]?.total);
    const items = (dataRows || []).map((row) => ({
      id: row.ID,
      displayId: row.DisplayID || "—",
      clientName: row.client_name || "—",
      status: row.Status,
      bookingStatus: Boolean(row.BookingStatus),
      caseProgressStatus: row.CaseProgressStatus,
      premium: toNum(row.net_premium),
      createDate: row.CreateDate,
      lastUpdate: row.LastUpdateDate,
      assignedBrm: row.AssignedBrmExecutive,
      stageLabel: stageLabel(row.CaseProgressStatus, row.BookingStatus),
    }));

    return {
      items,
      total,
      page: p,
      limit: lim,
      available: true,
    };
  } catch (e) {
    console.warn("[opsInsights] list failed:", e?.message || e);
    return { items: [], total: 0, page: p, limit: lim, available: false, error: e?.message };
  }
}

module.exports = {
  getOpsBookedStats,
  getConfirmedNotBookedStats,
  getDeptKpis,
  listCases,
  stageLabel,
};
