/**
 * Management Ops / Booking / AML Insights — fast DB-backed lists + KPIs.
 * Premium = CasePremiumSummary."NetPremium" only (no TargetPremium).
 * Ops universe = Status=3 unique cases (AML stages are a subset, never added on top).
 */
const { prisma } = require("../lib/prisma");
const { policyStartConds, amlSentToSql } = require("./managementDatePolicy");

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

const BASE = `
  COALESCE(qc."IsDeleted", false) = false
  AND COALESCE(qc."IsArchived", false) = false
`;

function dateConds(dateFrom, dateTo, params) {
  return policyStartConds("qc", dateFrom, dateTo, params);
}

function modeWhere(mode) {
  // All modes sit inside Status=3 (confirmed / ops universe)
  let w = `qc."Status" = 3`;
  if (mode === "ops-sla") {
    w += ` AND qc."CaseProgressStatus" = 0 AND qc."CreateDate" <= NOW() - INTERVAL '7 days'`;
  } else if (mode === "booking" || mode === "booking-pipeline") {
    // Booking stages only — excludes AML subset (1–4)
    w += ` AND qc."CaseProgressStatus" >= 5 AND qc."CaseProgressStatus" < 12`;
  } else if (mode === "booking-completed") {
    w += ` AND COALESCE(qc."BookingStatus", false) = true`;
  } else if (mode === "aml") {
    w += ` AND (${amlSentToSql("qc")})`;
  } else if (mode === "aml-cleared") {
    w += ` AND qc."CaseProgressStatus" >= 5`;
  } else if (mode === "operations-active") {
    // Confirmed ops queue still in progress (not fully booked)
    w += ` AND COALESCE(qc."BookingStatus", false) = false`;
  }
  return w;
}

/**
 * Fast Ops / Booking / AML KPIs — live Status=3 cases, PolicyEffectiveDate filter.
 * AML sent-to resolved via one document CTE (not correlated EXISTS per aggregate).
 */
async function getDeptKpis({ dateFrom, dateTo } = {}) {
  const params = [];
  const extras = dateConds(dateFrom, dateTo, params);
  const where = [BASE, `qc."Status" = 3`, ...extras].join(" AND ");

  const sql = `
    WITH scoped AS (
      SELECT
        qc."ID",
        qc."DisplayID",
        qc."BookingStatus",
        qc."CaseProgressStatus",
        qc."CaseStatusByAmlDin",
        qc."CreateDate",
        REGEXP_REPLACE(COALESCE(qc."DisplayID", qc."ID"::text), '-V[0-9]+$', '') AS base_id,
        CAST(
          NULLIF(REGEXP_REPLACE(COALESCE(qc."DisplayID", ''), '^.*-V([0-9]+)$', '\\1'), COALESCE(qc."DisplayID", ''))
          AS INT
        ) AS version_num
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE ${where}
    ),
    latest AS (
      SELECT DISTINCT ON (base_id)
        s."ID", s."DisplayID", s."BookingStatus", s."CaseProgressStatus", s."CaseStatusByAmlDin", s."CreateDate"
      FROM scoped s
      ORDER BY base_id, version_num DESC NULLS LAST, s."ID" DESC
    ),
    aml_case_ids AS (
      SELECT DISTINCT d."HealthInsuranceQuotationCaseID" AS case_id
      FROM public."HealthInsuranceQuotationDocument" d
      WHERE d."HealthInsuranceQuotationCaseID" IS NOT NULL
        AND COALESCE(d."IsArchived", false) = false
        AND COALESCE(d."SentToAML", false) = true
        AND (
          LOWER(COALESCE(d."DocumentScope"::text, '')) = 'kyc'
          OR LOWER(COALESCE(d."DocumentScope"::text, '')) LIKE '%kyc%'
        )
      UNION
      SELECT DISTINCT l."ID" AS case_id
      FROM latest l
      INNER JOIN public."HealthInsuranceQuotationDocument" d
        ON d."DisplayID" = l."DisplayID"
      WHERE COALESCE(d."IsArchived", false) = false
        AND COALESCE(d."SentToAML", false) = true
        AND (
          LOWER(COALESCE(d."DocumentScope"::text, '')) = 'kyc'
          OR LOWER(COALESCE(d."DocumentScope"::text, '')) LIKE '%kyc%'
        )
    ),
    priced AS (
      SELECT
        l.*,
        COALESCE(NULLIF(cps."NetPremium"::float, 0), 0)::float AS net_premium,
        (a.case_id IS NOT NULL) AS aml_sent
      FROM latest l
      LEFT JOIN public."CasePremiumSummary" cps ON cps."CaseID" = l."ID"
      LEFT JOIN aml_case_ids a ON a.case_id = l."ID"
    )
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
      COUNT(*) FILTER (WHERE aml_sent)::int AS aml_sent_total,
      COUNT(*) FILTER (WHERE aml_sent AND COALESCE("CaseStatusByAmlDin", 0) = 0)::int AS aml_pending,
      COUNT(*) FILTER (WHERE aml_sent AND COALESCE("CaseStatusByAmlDin", 0) = 1)::int AS aml_approved,
      COUNT(*) FILTER (WHERE aml_sent AND COALESCE("CaseStatusByAmlDin", 0) = 2)::int AS aml_partial,
      COUNT(*) FILTER (WHERE aml_sent AND COALESCE("CaseStatusByAmlDin", 0) = 3)::int AS aml_rejected,
      COUNT(*) FILTER (
        WHERE COALESCE("BookingStatus", false) = false
          AND "CaseProgressStatus" >= 5
          AND "CaseProgressStatus" < 12
      )::int AS booking_in_progress,
      COALESCE(SUM(net_premium), 0)::float AS total_premium,
      COALESCE(SUM(net_premium) FILTER (WHERE COALESCE("BookingStatus", false) = true), 0)::float AS booked_premium,
      COALESCE(SUM(net_premium) FILTER (WHERE "CaseProgressStatus" >= 1 AND "CaseProgressStatus" <= 4), 0)::float AS aml_premium,
      COALESCE(SUM(net_premium) FILTER (WHERE "CaseProgressStatus" >= 5 AND "CaseProgressStatus" < 12), 0)::float AS booking_premium
    FROM priced
  `;

  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
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
      amlSentTotal: toNum(r.aml_sent_total),
      amlPending: toNum(r.aml_pending),
      amlApproved: toNum(r.aml_approved),
      amlPartial: toNum(r.aml_partial),
      amlRejected: toNum(r.aml_rejected),
      bookingInProgress: toNum(r.booking_in_progress),
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
      amlSentTotal: 0,
      amlPending: 0,
      amlApproved: 0,
      amlPartial: 0,
      amlRejected: 0,
      bookingInProgress: 0,
      totalPremium: 0,
      bookedPremium: 0,
      amlPremium: 0,
      bookingPremium: 0,
    };
  }
}

async function getOpsBookedStats(opts) {
  const k = await getDeptKpis(opts);
  return { bookedCount: k.opsBooked, bookedPremium: k.bookedPremium };
}

async function getConfirmedNotBookedStats({ dateFrom, dateTo } = {}) {
  // Won = ALL Status=3 (booked + not booked)
  const k = await getDeptKpis({ dateFrom, dateTo });
  return { confirmedCount: k.total, confirmedPremium: k.totalPremium };
}

/**
 * Paginated list — filter early, distinct latest, page, then enrich client/CPS.
 */
async function listCases({
  mode = "operations",
  page = 1,
  limit = 20,
  search = "",
  dateFrom,
  dateTo,
  booked, // all | yes | no
  stage, // fresh | aml | booking | completed | all
  amlStatus, // pending | partial | approved | rejected
} = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (p - 1) * lim;

  const params = [];
  const extras = [modeWhere(mode), ...dateConds(dateFrom, dateTo, params)];

  if (booked === "yes") extras.push(`COALESCE(qc."BookingStatus", false) = true`);
  if (booked === "no") extras.push(`COALESCE(qc."BookingStatus", false) = false`);

  if (stage === "fresh") extras.push(`qc."CaseProgressStatus" = 0`);
  else if (stage === "aml") extras.push(`qc."CaseProgressStatus" BETWEEN 1 AND 4`);
  else if (stage === "booking") extras.push(`qc."CaseProgressStatus" BETWEEN 5 AND 11`);
  else if (stage === "completed") extras.push(`qc."CaseProgressStatus" = 12`);

  if (amlStatus === "pending") {
    extras.push(`(${amlSentToSql("qc")}) AND COALESCE(qc."CaseStatusByAmlDin", 0) = 0`);
  } else if (amlStatus === "partial") {
    extras.push(`(${amlSentToSql("qc")}) AND COALESCE(qc."CaseStatusByAmlDin", 0) = 2`);
  } else if (amlStatus === "approved") {
    extras.push(`(${amlSentToSql("qc")}) AND COALESCE(qc."CaseStatusByAmlDin", 0) = 1`);
  } else if (amlStatus === "rejected") {
    extras.push(`(${amlSentToSql("qc")}) AND COALESCE(qc."CaseStatusByAmlDin", 0) = 3`);
  }

  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    const i = params.length;
    extras.push(`(
      qc."DisplayID" ILIKE $${i}
      OR EXISTS (
        SELECT 1 FROM public."Company" c
        WHERE c."ID" = qc."ClientID" AND c."Name" ILIKE $${i}
      )
    )`);
  }

  const where = [BASE, ...extras].join(" AND ");

  const cte = `
    WITH scoped AS (
      SELECT
        qc."ID",
        qc."DisplayID",
        qc."Status",
        qc."BookingStatus",
        qc."CaseProgressStatus",
        qc."CaseStatusByAmlDin",
        qc."CreateDate",
        qc."LastUpdateDate",
        qc."AssignedBrmExecutive",
        qc."ClientID",
        REGEXP_REPLACE(COALESCE(qc."DisplayID", qc."ID"::text), '-V[0-9]+$', '') AS base_id,
        CAST(
          NULLIF(REGEXP_REPLACE(COALESCE(qc."DisplayID", ''), '^.*-V([0-9]+)$', '\\1'), COALESCE(qc."DisplayID", ''))
          AS INT
        ) AS version_num
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE ${where}
    ),
    latest AS (
      SELECT DISTINCT ON (base_id) *
      FROM scoped
      ORDER BY base_id, version_num DESC NULLS LAST, "ID" DESC
    )
  `;

  try {
    const [countRows, idRows] = await Promise.all([
      prisma.$queryRawUnsafe(`${cte} SELECT COUNT(*)::int AS total FROM latest`, ...params),
      prisma.$queryRawUnsafe(
        `${cte}
         SELECT "ID" FROM latest
         ORDER BY "LastUpdateDate" DESC NULLS LAST, "ID" DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params,
        lim,
        offset,
      ),
    ]);

    const total = toNum(countRows?.[0]?.total);
    const ids = (idRows || []).map((r) => r.ID).filter(Boolean);
    if (!ids.length) {
      return { items: [], total, page: p, limit: lim, available: true };
    }

    const detailSql = `
      SELECT
        qc."ID",
        qc."DisplayID",
        qc."Status",
        qc."BookingStatus",
        qc."CaseProgressStatus",
        qc."CaseStatusByAmlDin",
        qc."CreateDate",
        qc."LastUpdateDate",
        qc."AssignedBrmExecutive",
        COALESCE(NULLIF(cps."NetPremium"::float, 0), 0)::float AS net_premium,
        COALESCE(NULLIF(TRIM(comp."Name"), ''), '—') AS client_name
      FROM public."HealthInsuranceQuotationCase" qc
      LEFT JOIN public."CasePremiumSummary" cps ON cps."CaseID" = qc."ID"
      LEFT JOIN public."Company" comp ON comp."ID" = qc."ClientID"
      WHERE qc."ID"::text = ANY($1::text[])
    `;
    const details = await prisma.$queryRawUnsafe(
      detailSql,
      ids.map((x) => String(x)),
    );

    const byId = new Map((details || []).map((r) => [String(r.ID), r]));
    const items = ids.map((id) => {
      const row = byId.get(String(id)) || {};
      return {
        id: row.ID || id,
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
      };
    });

    return { items, total, page: p, limit: lim, available: true };
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
