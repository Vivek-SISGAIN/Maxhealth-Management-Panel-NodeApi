/**
 * Management BRM Insights — executive read aggregations against shared Postgres.
 * BRM list: AspNetRoles.Name IN ('BRM','Admin') — not hardcoded RoleId (BRM backend GUID is stale).
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/** Match BRM Assign form intent + include Admin as management asked */
const BRM_ROLE_NAMES = ["BRM", "Admin"];

const toNumber = (v) => {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && v !== null) {
    // Prisma Decimal / decimal.js → { s, e, d }
    if (typeof v.toNumber === "function") return v.toNumber();
    if (typeof v.toString === "function" && "s" in v && "e" in v && "d" in v) {
      const n = Number(v.toString());
      return Number.isFinite(n) ? n : 0;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isDecimalLike = (v) =>
  v != null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  (typeof v.toNumber === "function" || ("s" in v && "e" in v && "d" in v));

const serialize = (row) => {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map(serialize);
  if (typeof row !== "object") return row;
  if (row instanceof Date) return row.toISOString();
  if (isDecimalLike(row)) return toNumber(row);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (isDecimalLike(v)) out[k] = toNumber(v);
    else if (Array.isArray(v)) out[k] = v.map(serialize);
    else if (v && typeof v === "object") out[k] = serialize(v);
    else out[k] = v;
  }
  return out;
};

const query = async (sql, params = []) => {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  return serialize(rows);
};

/** Soft default for MasterDataLayer-heavy queries only (All Summary cards) */
const withDefaultDates = ({ dateFrom, dateTo } = {}) => {
  const to = dateTo || new Date().toISOString().slice(0, 10);
  let from = dateFrom;
  if (!from) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    from = d.toISOString().slice(0, 10);
  }
  return { dateFrom: from, dateTo: to };
};

/** Optional dates — empty means no date filter (BRM master_data parity) */
const optionalDates = ({ dateFrom, dateTo } = {}) => ({
  dateFrom: dateFrom && String(dateFrom).trim() ? String(dateFrom).trim() : null,
  dateTo: dateTo && String(dateTo).trim() ? String(dateTo).trim() : null,
});

/**
 * Same broker user set as BRM caseDetailsList:
 * UserBrokerMapping.UserId = AspNet BRM id → CompanyId → User.ID at those companies.
 */
const brokerUsersCteSql = (userIdParam) => `
  broker_users AS (
    SELECT u."ID"
    FROM public."User" u
    WHERE u."CompanyID" IN (
      SELECT ubm."CompanyId"
      FROM public."UserBrokerMapping" ubm
      WHERE ubm."UserId" = ${userIdParam}
    )
  )
`;

/** Core open NB filters matching BRM master_data */
const MASTER_DATA_CASE_FILTER = `
  qc."CreatedByUserID" = ANY(SELECT "ID" FROM broker_users)
  AND qc."DisplayID" ~ '-B[0-9]+'
  AND qc."BookingStatus" IS false
`;


const buildMasterDateConditions = (dateFrom, dateTo, params) => {
  const conditions = [];
  if (dateFrom) {
    params.push(dateFrom);
    const i = params.length;
    conditions.push(`(
      (UPPER(TRIM("NewOrRenewal")) = 'NEW' AND "PolicyEffectiveDate" >= $${i}::date)
      OR (UPPER(TRIM("NewOrRenewal")) = 'RENEWAL' AND "PolicyExpiryDate" >= $${i}::date)
      OR (COALESCE("EventNbr"::int, 1) <> 1 AND "PolicyEffectiveDate" >= $${i}::date)
    )`);
  }
  if (dateTo) {
    params.push(dateTo);
    const i = params.length;
    conditions.push(`(
      (UPPER(TRIM("NewOrRenewal")) = 'NEW' AND "PolicyEffectiveDate" <= $${i}::date)
      OR (UPPER(TRIM("NewOrRenewal")) = 'RENEWAL' AND "PolicyExpiryDate" <= $${i}::date)
      OR (COALESCE("EventNbr"::int, 1) <> 1 AND "PolicyEffectiveDate" <= $${i}::date)
    )`);
  }
  return conditions;
};

let executivesCache = { at: 0, rows: null };
const EXEC_TTL_MS = 5 * 60 * 1000;

/**
 * List real BRM (+ Admin) users by role NAME — same intent as BRM workbasket,
 * but GUID 05be3be5-… is wrong/stale in this DB (actual BRM role Id differs).
 */
async function getExecutives({ includeAdmin = true } = {}) {
  const now = Date.now();
  if (executivesCache.rows && now - executivesCache.at < EXEC_TTL_MS) {
    return executivesCache.rows;
  }

  const names = includeAdmin ? BRM_ROLE_NAMES : ["BRM"];
  const params = names;
  const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");

  const rows = await query(
    `
    SELECT DISTINCT ON (an."Id")
           an."Id" AS id,
           COALESCE(
             NULLIF(TRIM(an."UserName"), ''),
             NULLIF(TRIM(an."Email"), ''),
             an."Id"
           ) AS name,
           an."Email" AS email,
           r."Name" AS role
    FROM public."AspNetUserRoles" aur
    JOIN public."AspNetUsers" an ON an."Id" = aur."UserId"
    JOIN public."AspNetRoles" r ON r."Id" = aur."RoleId"
    WHERE UPPER(TRIM(r."Name")) IN (${placeholders.split(", ").map((_, i) => `UPPER($${i + 1})`).join(", ")})
    ORDER BY an."Id", r."Name" ASC
    `,
    params,
  );

  // Distinct ON needs outer sort for display
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  executivesCache = { at: now, rows };
  return rows;
}

async function getSummaryCards({ dateFrom, dateTo, brmName } = {}) {
  const dates = withDefaultDates({ dateFrom, dateTo });
  const params = [];
  const conditions = buildMasterDateConditions(dates.dateFrom, dates.dateTo, params);

  if (brmName) {
    params.push(`%${brmName.trim()}%`);
    conditions.push(`"BusinessRelationManager" ILIKE $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [bookedRows, pipelineRows, renRows] = await Promise.all([
    query(
      `
      SELECT
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
            AND LOWER(TRIM("PolicyType")) = 'group'
        ), 0)::float AS "nbGroupPremium",
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
            AND COALESCE("EventNbr"::int, 1) = 1
            AND LOWER(TRIM("PolicyType")) = 'individual'
        ), 0)::float AS "nbIndividualPremium",
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'RENEWAL'
            AND COALESCE("EventNbr"::int, 1) = 1
            AND LOWER(TRIM("PolicyType")) = 'group'
        ), 0)::float AS "renGroupPremium",
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'RENEWAL'
            AND COALESCE("EventNbr"::int, 1) = 1
            AND LOWER(TRIM("PolicyType")) = 'individual'
        ), 0)::float AS "renIndividualPremium",
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE COALESCE("EventNbr"::int, 1) <> 1 AND LOWER(TRIM("PolicyType")) = 'group'
        ), 0)::float AS "endGroupPremium",
        COALESCE(SUM("GrossPremium") FILTER (
          WHERE COALESCE("EventNbr"::int, 1) <> 1 AND LOWER(TRIM("PolicyType")) = 'individual'
        ), 0)::float AS "endIndividualPremium",
        COUNT(*) FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW' AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "nbCount",
        COUNT(*) FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'RENEWAL' AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "renCount",
        COUNT(*) FILTER (WHERE COALESCE("EventNbr"::int, 1) <> 1)::int AS "endCount",
        COUNT(*)::int AS "totalCount",
        COALESCE(SUM("GrossPremium"), 0)::float AS "totalPremium"
      FROM public."MasterDataLayer"
      ${whereClause}
      `,
      params,
    ),
    query(
      `
      SELECT
        COUNT(*) FILTER (WHERE qc."DealStatus" = 2 AND qc."BookingStatus" IS NOT TRUE)::int AS "confirmedNewCount",
        COUNT(*) FILTER (WHERE qc."DealStatus" = 1 AND qc."BookingStatus" IS NOT TRUE)::int AS "confirmedRenewalCount",
        COUNT(*) FILTER (WHERE qc."BookingStatus" IS TRUE AND qc."RenewalFromCaseID" IS NULL)::int AS "achievedNewCount",
        COUNT(*) FILTER (WHERE qc."BookingStatus" IS TRUE AND qc."RenewalFromCaseID" > 0)::int AS "achievedRenCount",
        COUNT(*) FILTER (WHERE qc."BookingStatus" IS TRUE)::int AS "bookedCaseCount",
        COUNT(*) FILTER (WHERE qc."BookingStatus" IS NOT TRUE)::int AS "openPipelineCount",
        COUNT(*)::int AS "totalPipelineCases",
        COALESCE(SUM(CASE WHEN qc."BookingStatus" IS TRUE THEN COALESCE(qc."TargetPremium", 0) ELSE 0 END), 0)::float AS "achievedTargetPremium",
        COALESCE(SUM(CASE WHEN qc."DealStatus" = 2 AND qc."BookingStatus" IS NOT TRUE THEN COALESCE(qc."TargetPremium", 0) ELSE 0 END), 0)::float AS "confirmedNewPremium",
        COALESCE(SUM(CASE WHEN qc."BookingStatus" IS TRUE AND qc."RenewalFromCaseID" IS NULL THEN COALESCE(qc."TargetPremium", 0) ELSE 0 END), 0)::float AS "AchievedBookedConfirmedNewPremium",
        COALESCE(SUM(CASE WHEN qc."BookingStatus" IS TRUE AND qc."RenewalFromCaseID" > 0 THEN COALESCE(qc."TargetPremium", 0) ELSE 0 END), 0)::float AS "AchievedBookedConfirmedRenewalPremium"
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE qc."CreateDate"::date BETWEEN $1::date AND $2::date
      `,
      [dates.dateFrom, dates.dateTo],
    ),
    query(
      `SELECT COALESCE(SUM("ExpiringPremium") FILTER (WHERE "BrmActionStatus" = 2), 0)::float AS "confirmedRenewalPremium",
              COUNT(*) FILTER (WHERE "BatchStatus" = 'Distributed')::int AS "renewalBatchCount",
              COUNT(*) FILTER (WHERE "BrmActionStatus" = 2)::int AS "renewalConfirmedCount"
       FROM public."BrmRenewalData"
       WHERE ("EffectiveDate" IS NULL OR "EffectiveDate"::date BETWEEN $1::date AND $2::date)`,
      [dates.dateFrom, dates.dateTo],
    ),
  ]);

  const booked = bookedRows[0] || {};
  const p = pipelineRows[0] || {};
  const r = renRows[0] || {};

  const achievedNew = toNumber(p.AchievedBookedConfirmedNewPremium);
  const achievedRen = toNumber(p.AchievedBookedConfirmedRenewalPremium);
  const confirmedNew = toNumber(p.confirmedNewPremium);
  const confirmedRen = toNumber(r.confirmedRenewalPremium);
  const achievedTotal = achievedNew + achievedRen;
  const forecastTotal = achievedTotal + 0.6 * confirmedRen;

  return {
    ...booked,
    confirmedNewCount: toNumber(p.confirmedNewCount),
    confirmedRenewalCount: toNumber(p.confirmedRenewalCount),
    confirmedNewPremium: confirmedNew,
    confirmedRenewalPremium: confirmedRen,
    AchievedBookedConfirmedNewPremium: achievedNew,
    AchievedBookedConfirmedRenewalPremium: achievedRen,
    bookedCaseCount: toNumber(p.bookedCaseCount),
    openPipelineCount: toNumber(p.openPipelineCount),
    totalPipelineCases: toNumber(p.totalPipelineCases),
    renewalBatchCount: toNumber(r.renewalBatchCount),
    renewalConfirmedCount: toNumber(r.renewalConfirmedCount),
    achievedTotal,
    forecastTotal,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  };
}

async function getSummaryList({
  type = "new",
  status,
  search,
  dateFrom,
  dateTo,
  brmName,
  limit = 25,
  offset = 0,
} = {}) {
  const dates = withDefaultDates({ dateFrom, dateTo });
  const params = [];
  const conditions = [];
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  if (type === "new") conditions.push(`UPPER(TRIM("NewOrRenewal")) = 'NEW'`);
  else if (type === "renewal") conditions.push(`UPPER(TRIM("NewOrRenewal")) = 'RENEWAL'`);
  else if (type === "endorsement") {
    conditions.push(`"EndorsementTypeCode" IS NOT NULL AND TRIM("EndorsementTypeCode") <> ''`);
  }

  params.push(dates.dateFrom);
  if (type === "new" || type === "endorsement") {
    conditions.push(`"PolicyEffectiveDate" >= $${params.length}::date`);
  } else {
    conditions.push(`"PolicyExpiryDate" >= $${params.length}::date`);
  }
  params.push(dates.dateTo);
  if (type === "new" || type === "endorsement") {
    conditions.push(`"PolicyEffectiveDate" <= $${params.length}::date`);
  } else {
    conditions.push(`"PolicyExpiryDate" <= $${params.length}::date`);
  }

  if (status && status !== "all") {
    params.push(String(status).toUpperCase());
    conditions.push(`UPPER(TRIM("EndorsementStatus")) = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    conditions.push(
      `("TechnicalSheetNumber"::text ILIKE ${p} OR "PolicyHolder" ILIKE ${p} OR "Agency" ILIKE ${p} OR "PolicyGroup" ILIKE ${p} OR "BusinessRelationManager" ILIKE ${p})`,
    );
  }
  if (brmName) {
    params.push(`%${brmName.trim()}%`);
    conditions.push(`"BusinessRelationManager" ILIKE $${params.length}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const filterParams = [...params];

  params.push(parsedLimit);
  const limitIdx = params.length;
  params.push(parsedOffset);
  const offsetIdx = params.length;

  const [countRows, statusRows, dataRows] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT 1 FROM public."MasterDataLayer" ${whereClause}
         GROUP BY CASE WHEN LOWER(TRIM("PolicyType")) = 'group' THEN "PolicyGroupCode" ELSE "TechnicalSheetNumber" END
       ) t`,
      filterParams,
    ),
    query(
      `SELECT COALESCE(UPPER(TRIM("EndorsementStatus")), 'UNKNOWN') AS status,
              COUNT(*)::int AS count,
              COALESCE(SUM("GrossPremium"), 0)::float AS premium
       FROM public."MasterDataLayer" ${whereClause}
       GROUP BY 1 ORDER BY count DESC
       LIMIT 20`,
      filterParams,
    ),
    query(
      `SELECT
         MAX("TechnicalSheetNumber") AS "TechnicalSheetNumber",
         MAX("PolicyGroup") AS "PolicyGroup",
         MAX("PolicyGroupCode") AS "PolicyGroupCode",
         MAX("PolicyHolder") AS "PolicyHolder",
         MAX("Agency") AS "Agency",
         MAX("PolicyType") AS "PolicyType",
         MAX("NewOrRenewal") AS "NewOrRenewal",
         MAX("EndorsementTypeCode") AS "EndorsementTypeCode",
         MAX("EndorsementTypeDescription") AS "EndorsementTypeDescription",
         MAX("EndorsementStatus") AS "EndorsementStatus",
         TO_CHAR(MAX("PolicyEffectiveDate"), 'DD-MM-YYYY') AS "PolicyEffectiveDate",
         TO_CHAR(MAX("PolicyExpiryDate"), 'DD-MM-YYYY') AS "PolicyExpiryDate",
         MAX("InsuranceCompany") AS "InsuranceCompany",
         MAX("BusinessRelationManager") AS "BusinessRelationManager",
         COUNT(*)::int AS "memberCount",
         COALESCE(ROUND(SUM("GrossPremium")::numeric, 2), 0)::float AS "totalGrossPremium"
       FROM public."MasterDataLayer"
       ${whereClause}
       GROUP BY CASE WHEN LOWER(TRIM("PolicyType")) = 'group' THEN "PolicyGroupCode" ELSE "TechnicalSheetNumber" END
       ORDER BY MAX("PolicyEffectiveDate") DESC NULLS LAST
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
  ]);

  return {
    rows: dataRows,
    total: toNumber(countRows[0]?.total),
    statusBreakdown: statusRows,
    limit: parsedLimit,
    offset: parsedOffset,
  };
}

/**
 * New Business cases — ownership matches BRM master_data (caseDetailsList).
 * When executiveId set: no forced date filter (parity). Dates only if explicitly passed.
 */
async function getCases({
  executiveId,
  search,
  dealStatus,
  dateFrom,
  dateTo,
  limit = 25,
  offset = 0,
} = {}) {
  const dates = optionalDates({ dateFrom, dateTo });
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const params = [];
  const extra = [];

  const hasExec = executiveId && executiveId !== "all";

  if (hasExec) {
    params.push(executiveId);
  }

  if (dates.dateFrom) {
    params.push(dates.dateFrom);
    extra.push(`qc."CreateDate"::date >= $${params.length}::date`);
  }
  if (dates.dateTo) {
    params.push(dates.dateTo);
    extra.push(`qc."CreateDate"::date <= $${params.length}::date`);
  }
  if (dealStatus != null && dealStatus !== "" && dealStatus !== "all") {
    params.push(parseInt(dealStatus, 10));
    extra.push(`qc."DealStatus" = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    extra.push(
      `(qc."DisplayID" ILIKE ${p} OR qc."BrokerCompanyName" ILIKE ${p} OR c."Name" ILIKE ${p})`,
    );
  }

  const extraSql = extra.length ? `AND ${extra.join(" AND ")}` : "";

  // Scoped to one BRM — identical to caseDetailsList core filters
  if (hasExec) {
    const filterParams = [...params];
    params.push(parsedLimit);
    const limitIdx = params.length;
    params.push(parsedOffset);
    const offsetIdx = params.length;

    const [aggRows, caseRows] = await Promise.all([
      query(
        `
        WITH ${brokerUsersCteSql("$1")},
        scoped AS (
          SELECT qc."ID", qc."DealStatus", qc."TargetPremium", qc."DisplayID"
          FROM public."HealthInsuranceQuotationCase" qc
          LEFT JOIN public."User" u ON qc."CreatedByUserID" = u."ID"
          LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
          WHERE ${MASTER_DATA_CASE_FILTER}
          ${extraSql}
        ),
        latest AS (
          SELECT DISTINCT ON (REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''))
            s."ID", s."DealStatus", s."TargetPremium"
          FROM scoped s
          ORDER BY REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''),
                   CAST(NULLIF(REGEXP_REPLACE(s."DisplayID", '^.*-V([0-9]+)$', '\\1'), s."DisplayID") AS INT) DESC NULLS LAST
        )
        SELECT
          COUNT(*)::int AS "totalCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 3)::int AS "wonCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 4)::int AS "lostCount",
          COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "totalGrossPremium"
        FROM latest
        `,
        filterParams,
      ),
      query(
        `
        WITH ${brokerUsersCteSql("$1")},
        scoped AS (
          SELECT
            qc."ID",
            qc."DisplayID",
            qc."DealStatus",
            qc."TargetPremium",
            qc."BrokerCompanyName",
            qc."BrokerEmail",
            qc."QuotationPreparedBy",
            qc."AssignedBrmExecutive",
            qc."ReferenceNumber",
            qc."Insurer",
            qc."PolicyEffectiveDate",
            qc."CreateDate",
            c."Name" AS "client_name",
            u."Name" AS "broker_name",
            CASE
              WHEN qc."DisplayID" ~* '-I[0-9]+' THEN 'Individual'
              ELSE 'Group'
            END AS "policy_type",
            (
              SELECT STRING_AGG(
                DISTINCT REGEXP_REPLACE(TRIM(cat."HealthInsurancePlanName"), '[^a-zA-Z0-9 _]+$', ''),
                ', '
              )
              FROM public."HealthInsuranceQuotationCategory" cat
              WHERE cat."HealthInsuranceQuotationCaseID" = qc."ID"
                AND TRIM(COALESCE(cat."HealthInsurancePlanName", '')) <> ''
            ) AS "category_plan_name",
            REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,
            CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\1'), qc."DisplayID") AS INT) AS version_num
          FROM public."HealthInsuranceQuotationCase" qc
          LEFT JOIN public."User" u ON qc."CreatedByUserID" = u."ID"
          LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
          WHERE ${MASTER_DATA_CASE_FILTER}
          ${extraSql}
        ),
        latest AS (
          SELECT DISTINCT ON (base_display_id) *
          FROM scoped
          ORDER BY base_display_id, version_num DESC NULLS LAST
        )
        SELECT
          l."ID",
          l."DisplayID",
          l."DealStatus",
          l."TargetPremium",
          l."BrokerCompanyName",
          l."BrokerEmail",
          l."QuotationPreparedBy",
          l."AssignedBrmExecutive",
          l."ReferenceNumber",
          l."Insurer",
          l."policy_type",
          l."category_plan_name",
          TO_CHAR(l."PolicyEffectiveDate", 'DD-MM-YYYY') AS "PolicyEffectiveDate",
          TO_CHAR(l."CreateDate", 'DD-MM-YYYY') AS "CreateDate",
          l."client_name",
          l."broker_name",
          (SELECT COALESCE(NULLIF(TRIM(an."UserName"), ''), an."Email")
           FROM public."AspNetUsers" an WHERE an."Id" = $1 LIMIT 1) AS "brm_name",
          brm."Status" AS "brm_status",
          brm."Priority" AS "brm_priority",
          brm."Potential" AS "brm_potential",
          brm."ConfirmStatus" AS "brm_confirm_status",
          COALESCE(
            (
              SELECT SUM(qm."TotalAmount")
              FROM public."HealthInsuranceQuotationMember" qm
              WHERE qm."HealthInsuranceQuotationCaseID" = l."ID"
            ),
            l."TargetPremium",
            0
          )::float AS "gross_premium",
          (
            COALESCE(
              (
                SELECT SUM(qm."TotalAmount")
                FROM public."HealthInsuranceQuotationMember" qm
                WHERE qm."HealthInsuranceQuotationCaseID" = l."ID"
              ),
              l."TargetPremium",
              0
            ) - COALESCE(l."TargetPremium", 0)
          )::float AS "difference"
        FROM latest l
        LEFT JOIN LATERAL (
          SELECT b."Status", b."Priority", b."Potential", b."ConfirmStatus"
          FROM public."BrmCaseActionsUpdates" b
          WHERE b."CaseID" = l."ID"
          ORDER BY b."UpdatedAt" DESC NULLS LAST
          LIMIT 1
        ) brm ON TRUE
        ORDER BY l."ID" DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `,
        params,
      ),
    ]);

    const agg = aggRows[0] || {};
    return {
      cases: caseRows,
      totalCount: toNumber(agg.totalCount),
      activeCount: toNumber(agg.activeCount),
      hotCount: toNumber(agg.hotCount),
      wonCount: toNumber(agg.wonCount),
      lostCount: toNumber(agg.lostCount),
      totalGrossPremium: toNumber(agg.totalGrossPremium),
      limit: parsedLimit,
      offset: parsedOffset,
      ownership: "brm_master_data_parity",
      dateFrom: dates.dateFrom,
      dateTo: dates.dateTo,
    };
  }

  // All BRMs — open B-cases only (management global). Optional dates.
  params.length = 0;
  const allExtra = [
    `qc."DisplayID" ~ '-B[0-9]+'`,
    `qc."BookingStatus" IS false`,
  ];
  if (dates.dateFrom) {
    params.push(dates.dateFrom);
    allExtra.push(`qc."CreateDate"::date >= $${params.length}::date`);
  }
  if (dates.dateTo) {
    params.push(dates.dateTo);
    allExtra.push(`qc."CreateDate"::date <= $${params.length}::date`);
  }
  if (dealStatus != null && dealStatus !== "" && dealStatus !== "all") {
    params.push(parseInt(dealStatus, 10));
    allExtra.push(`qc."DealStatus" = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    allExtra.push(
      `(qc."DisplayID" ILIKE ${p} OR qc."BrokerCompanyName" ILIKE ${p} OR c."Name" ILIKE ${p})`,
    );
  }
  const whereAll = `WHERE ${allExtra.join(" AND ")}`;
  const filterParams = [...params];
  params.push(parsedLimit);
  const limitIdx = params.length;
  params.push(parsedOffset);
  const offsetIdx = params.length;

  const [aggRows, caseRows] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS "totalCount",
         COUNT(*) FILTER (WHERE qc."DealStatus" = 2)::int AS "activeCount",
         COUNT(*) FILTER (WHERE qc."DealStatus" = 1)::int AS "hotCount",
         COUNT(*) FILTER (WHERE qc."DealStatus" = 3)::int AS "wonCount",
         COUNT(*) FILTER (WHERE qc."DealStatus" = 4)::int AS "lostCount",
         COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS "totalGrossPremium"
       FROM public."HealthInsuranceQuotationCase" qc
       LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
       ${whereAll}`,
      filterParams,
    ),
    query(
      `SELECT
         qc."ID", qc."DisplayID", qc."DealStatus", qc."TargetPremium",
         qc."BrokerCompanyName", qc."BrokerEmail", qc."QuotationPreparedBy",
         qc."AssignedBrmExecutive", qc."ReferenceNumber", qc."Insurer",
         CASE WHEN qc."DisplayID" ~* '-I[0-9]+' THEN 'Individual' ELSE 'Group' END AS "policy_type",
         (
           SELECT STRING_AGG(
             DISTINCT REGEXP_REPLACE(TRIM(cat."HealthInsurancePlanName"), '[^a-zA-Z0-9 _]+$', ''),
             ', '
           )
           FROM public."HealthInsuranceQuotationCategory" cat
           WHERE cat."HealthInsuranceQuotationCaseID" = qc."ID"
             AND TRIM(COALESCE(cat."HealthInsurancePlanName", '')) <> ''
         ) AS "category_plan_name",
         TO_CHAR(qc."PolicyEffectiveDate", 'DD-MM-YYYY') AS "PolicyEffectiveDate",
         TO_CHAR(qc."CreateDate", 'DD-MM-YYYY') AS "CreateDate",
         c."Name" AS "client_name",
         (
           SELECT COALESCE(NULLIF(TRIM(bru."UserName"), ''), bru."Email")
           FROM public."User" broker
           JOIN public."UserBrokerMapping" ubm ON ubm."CompanyId" = broker."CompanyID"
           JOIN public."AspNetUsers" bru ON bru."Id" = ubm."UserId"
           WHERE broker."ID" = qc."CreatedByUserID"
           LIMIT 1
         ) AS "brm_name",
         brm."Status" AS "brm_status",
         brm."Priority" AS "brm_priority",
         brm."Potential" AS "brm_potential",
         brm."ConfirmStatus" AS "brm_confirm_status",
         COALESCE(
           (SELECT SUM(qm."TotalAmount") FROM public."HealthInsuranceQuotationMember" qm WHERE qm."HealthInsuranceQuotationCaseID" = qc."ID"),
           qc."TargetPremium", 0
         )::float AS "gross_premium",
         (
           COALESCE(
             (SELECT SUM(qm."TotalAmount") FROM public."HealthInsuranceQuotationMember" qm WHERE qm."HealthInsuranceQuotationCaseID" = qc."ID"),
             qc."TargetPremium", 0
           ) - COALESCE(qc."TargetPremium", 0)
         )::float AS "difference"
       FROM public."HealthInsuranceQuotationCase" qc
       LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
       LEFT JOIN LATERAL (
         SELECT b."Status", b."Priority", b."Potential", b."ConfirmStatus"
         FROM public."BrmCaseActionsUpdates" b
         WHERE b."CaseID" = qc."ID"
         ORDER BY b."UpdatedAt" DESC NULLS LAST
         LIMIT 1
       ) brm ON TRUE
       ${whereAll}
       ORDER BY qc."ID" DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
  ]);

  const agg = aggRows[0] || {};
  return {
    cases: caseRows,
    totalCount: toNumber(agg.totalCount),
    activeCount: toNumber(agg.activeCount),
    hotCount: toNumber(agg.hotCount),
    wonCount: toNumber(agg.wonCount),
    lostCount: toNumber(agg.lostCount),
    totalGrossPremium: toNumber(agg.totalGrossPremium),
    limit: parsedLimit,
    offset: parsedOffset,
    ownership: "all_open_b_cases",
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  };
}


/**
 * Per-BRM ranking — same ownership as BRM master_data (no forced date unless passed).
 */
async function getByExecutive({ dateFrom, dateTo, dealStatus } = {}) {
  const dates = optionalDates({ dateFrom, dateTo });
  const names = BRM_ROLE_NAMES;
  const params = [...names];
  let openDateFilter = "";
  let bookedDateFilter = "";
  if (dates.dateFrom) {
    params.push(dates.dateFrom);
    openDateFilter += ` AND qc."CreateDate"::date >= $${params.length}::date`;
    bookedDateFilter += ` AND qc."CreateDate"::date >= $${params.length}::date`;
  }
  if (dates.dateTo) {
    params.push(dates.dateTo);
    openDateFilter += ` AND qc."CreateDate"::date <= $${params.length}::date`;
    bookedDateFilter += ` AND qc."CreateDate"::date <= $${params.length}::date`;
  }
  if (dealStatus != null && dealStatus !== "" && dealStatus !== "all") {
    params.push(parseInt(dealStatus, 10));
    openDateFilter += ` AND qc."DealStatus" = $${params.length}`;
    bookedDateFilter += ` AND qc."DealStatus" = $${params.length}`;
  }

  const rows = await query(
    `
    WITH brm_users AS (
      SELECT DISTINCT ON (an."Id")
             an."Id",
             COALESCE(NULLIF(TRIM(an."UserName"), ''), NULLIF(TRIM(an."Email"), ''), an."Id") AS "executiveName",
             r."Name" AS role
      FROM public."AspNetUserRoles" aur
      JOIN public."AspNetUsers" an ON an."Id" = aur."UserId"
      JOIN public."AspNetRoles" r ON r."Id" = aur."RoleId"
      WHERE UPPER(TRIM(r."Name")) IN (${names.map((_, i) => `UPPER($${i + 1})`).join(", ")})
      ORDER BY an."Id", r."Name"
    ),
    open_raw AS (
      SELECT DISTINCT bu."Id" AS executive_id, qc."ID" AS case_id, qc."DealStatus", qc."TargetPremium", qc."DisplayID"
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-B[0-9]+'
        AND qc."BookingStatus" IS false
        ${openDateFilter}
    ),
    open_latest AS (
      SELECT DISTINCT ON (executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''))
        executive_id, case_id, "DealStatus", "TargetPremium"
      FROM open_raw
      ORDER BY executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''), case_id DESC
    ),
    booked_raw AS (
      SELECT DISTINCT bu."Id" AS executive_id, qc."ID" AS case_id, qc."TargetPremium", qc."DisplayID"
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-B[0-9]+'
        AND qc."BookingStatus" IS true
        ${bookedDateFilter}
    ),
    booked_latest AS (
      SELECT DISTINCT ON (executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''))
        executive_id, case_id, "TargetPremium"
      FROM booked_raw
      ORDER BY executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''), case_id DESC
    ),
    open_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "newCaseTotal",
        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCases",
        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCases",
        COUNT(*) FILTER (WHERE "DealStatus" = 3)::int AS "wonCases",
        COUNT(*) FILTER (WHERE "DealStatus" = 4)::int AS "lostCases",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "openPremium"
      FROM open_latest
      GROUP BY executive_id
    ),
    booked_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "bookedCaseTotal",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "bookedPremium"
      FROM booked_latest
      GROUP BY executive_id
    ),
    renewal_agg AS (
      SELECT bu."Id" AS executive_id,
             COUNT(*)::int AS "renewalCaseTotal",
             COALESCE(SUM(
               COALESCE(NULLIF(b."ExpiringPremium"::float, 0), mp.total_premium, 0)
             ), 0)::float AS "renewalPremium"
      FROM brm_users bu
      JOIN public."BrmRenewalData" b ON bu."Id" = ANY(b."BrmUserIds")
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(m."GrossPremium"), 0)::float AS total_premium
        FROM public."MasterDataLayer" m
        WHERE m."EndorsementTypeCode" = '02'
          AND m."TechnicalSheetNumber"::text = ANY(
            ARRAY(
              SELECT TRIM(val)
              FROM unnest(string_to_array(REPLACE(COALESCE(b."PolicyList", ''), ' ', ''), ',')) AS val
              WHERE TRIM(val) <> ''
            )
          )
      ) mp ON TRUE
      WHERE b."BatchStatus" = 'Distributed'
      GROUP BY bu."Id"
    )
    SELECT
      bu."Id" AS "executiveId",
      bu."executiveName",
      bu.role,
      COALESCE(o."newCaseTotal", 0)::int AS "newCaseTotal",
      COALESCE(r."renewalCaseTotal", 0)::int AS "renewalCaseTotal",
      COALESCE(bk."bookedCaseTotal", 0)::int AS "bookedCaseTotal",
      (COALESCE(o."newCaseTotal", 0) + COALESCE(r."renewalCaseTotal", 0) + COALESCE(bk."bookedCaseTotal", 0))::int AS "brmTotal",
      COALESCE(o."newCaseTotal", 0)::int AS "totalCases",
      COALESCE(bk."bookedCaseTotal", 0)::int AS "bookedCases",
      COALESCE(o."newCaseTotal", 0)::int AS "openCases",
      COALESCE(o."activeCases", 0)::int AS "activeCases",
      COALESCE(o."hotCases", 0)::int AS "hotCases",
      COALESCE(o."wonCases", 0)::int AS "wonCases",
      COALESCE(o."lostCases", 0)::int AS "lostCases",
      COALESCE(o."openPremium", 0)::float AS "totalGrossPremium",
      COALESCE(bk."bookedPremium", 0)::float AS "bookedPremium",
      COALESCE(r."renewalPremium", 0)::float AS "renewalPremium",
      CASE
        WHEN COALESCE(o."newCaseTotal", 0) > 0
        THEN (COALESCE(o."openPremium", 0) / o."newCaseTotal")::float
        ELSE 0::float
      END AS "avgCasePremium"
    FROM brm_users bu
    LEFT JOIN open_agg o ON o.executive_id = bu."Id"
    LEFT JOIN booked_agg bk ON bk.executive_id = bu."Id"
    LEFT JOIN renewal_agg r ON r.executive_id = bu."Id"
    ORDER BY "totalGrossPremium" DESC NULLS LAST, bu."executiveName" ASC
    `,
    params,
  );

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalCases += toNumber(r.totalCases);
      acc.newCaseTotal += toNumber(r.newCaseTotal);
      acc.renewalCaseTotal += toNumber(r.renewalCaseTotal);
      acc.bookedCaseTotal += toNumber(r.bookedCaseTotal);
      acc.brmTotal += toNumber(r.brmTotal);
      acc.totalGrossPremium += toNumber(r.totalGrossPremium);
      acc.bookedPremium += toNumber(r.bookedPremium);
      acc.renewalPremium += toNumber(r.renewalPremium);
      return acc;
    },
    {
      totalCases: 0,
      newCaseTotal: 0,
      renewalCaseTotal: 0,
      bookedCaseTotal: 0,
      brmTotal: 0,
      totalGrossPremium: 0,
      bookedPremium: 0,
      renewalPremium: 0,
    },
  );

  const enriched = rows.map((r) => {
    const won = toNumber(r.wonCases);
    const lost = toNumber(r.lostCases);
    const closed = won + lost;
    const openPrem = toNumber(r.totalGrossPremium);
    const newCount = toNumber(r.newCaseTotal);
    return {
      ...r,
      avgCasePremium: newCount > 0 ? openPrem / newCount : 0,
      winRate: closed > 0 ? Math.round((won / closed) * 1000) / 10 : null,
      shareOfPremium:
        totals.totalGrossPremium > 0
          ? Math.round((openPrem / totals.totalGrossPremium) * 1000) / 10
          : 0,
    };
  });

  return {
    executives: enriched,
    totals,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
    ownership: "brm_master_data_parity",
  };
}


async function getTrends({ period = "monthly", executiveId, dateFrom, dateTo } = {}) {
  const dates = withDefaultDates({ dateFrom, dateTo });
  const trunc = period === "yearly" ? "year" : "month";
  const fmt = period === "yearly" ? "'YYYY'" : "'YYYY-MM'";

  const hasExec = executiveId && executiveId !== "all";
  const caseParams = hasExec
    ? [executiveId, dates.dateFrom, dates.dateTo]
    : [dates.dateFrom, dates.dateTo];

  const nbSql = hasExec
    ? `
      WITH ${brokerUsersCteSql("$1")}
      SELECT TO_CHAR(date_trunc('${trunc}', qc."CreateDate"), ${fmt}) AS period,
             COUNT(*)::int AS "caseCount",
             COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS premium,
             COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS "nbBookedPremium",
             0::float AS "renBookedPremium"
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE ${MASTER_DATA_CASE_FILTER}
        AND qc."CreateDate"::date BETWEEN $2::date AND $3::date
      GROUP BY 1 ORDER BY 1 ASC`
    : `
      SELECT TO_CHAR(date_trunc('${trunc}', qc."CreateDate"), ${fmt}) AS period,
             COUNT(*)::int AS "caseCount",
             COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS premium,
             COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS "nbBookedPremium",
             0::float AS "renBookedPremium"
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE qc."DisplayID" ~ '-B[0-9]+'
        AND qc."BookingStatus" IS false
        AND qc."CreateDate"::date BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY 1 ASC`;

  const renParams = hasExec
    ? [executiveId, dates.dateFrom, dates.dateTo]
    : [dates.dateFrom, dates.dateTo];
  const renSql = hasExec
    ? `
      SELECT TO_CHAR(date_trunc('${trunc}', b."EffectiveDate"), ${fmt}) AS period,
             COUNT(*)::int AS "batchCount",
             COALESCE(SUM(b."ExpiringPremium"), 0)::float AS "expiringPremium",
             0::float AS "nbBookedPremium",
             COALESCE(SUM(b."ExpiringPremium"), 0)::float AS "renBookedPremium"
      FROM public."BrmRenewalData" b
      WHERE b."BatchStatus" = 'Distributed'
        AND $1::text = ANY(b."BrmUserIds")
        AND b."EffectiveDate"::date BETWEEN $2::date AND $3::date
      GROUP BY 1 ORDER BY 1 ASC`
    : `
      SELECT TO_CHAR(date_trunc('${trunc}', b."EffectiveDate"), ${fmt}) AS period,
             COUNT(*)::int AS "batchCount",
             COALESCE(SUM(b."ExpiringPremium"), 0)::float AS "expiringPremium",
             0::float AS "nbBookedPremium",
             COALESCE(SUM(b."ExpiringPremium"), 0)::float AS "renBookedPremium"
      FROM public."BrmRenewalData" b
      WHERE b."BatchStatus" = 'Distributed'
        AND b."EffectiveDate"::date BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY 1 ASC`;

  const [nbRows, renRows] = await Promise.all([
    query(nbSql, caseParams),
    query(renSql, renParams),
  ]);

  const periodMap = new Map();
  const ensure = (p) => {
    if (!periodMap.has(p)) {
      periodMap.set(p, {
        period: p,
        caseCount: 0,
        pipelinePremium: 0,
        renewalBatches: 0,
        expiringPremium: 0,
        nbBookedPremium: 0,
        renBookedPremium: 0,
      });
    }
    return periodMap.get(p);
  };

  for (const r of nbRows) {
    const row = ensure(r.period);
    row.caseCount = toNumber(r.caseCount);
    row.pipelinePremium = toNumber(r.premium);
    row.nbBookedPremium = toNumber(r.nbBookedPremium);
  }
  for (const r of renRows) {
    const row = ensure(r.period);
    row.renewalBatches = toNumber(r.batchCount);
    row.expiringPremium = toNumber(r.expiringPremium);
    row.renBookedPremium = toNumber(r.renBookedPremium);
  }

  return {
    period,
    series: Array.from(periodMap.values()).sort((a, b) => String(a.period).localeCompare(String(b.period))),
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  };
}

async function getRenewals({
  search,
  policyType = "Group",
  executiveId,
  limit = 25,
  offset = 0,
} = {}) {
  const params = [];
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
  let where = `WHERE b."BatchStatus" = 'Distributed'`;

  if (policyType === "Individual") where += ` AND b."PolicyGroupCode" ILIKE 'IND%'`;
  else where += ` AND b."PolicyGroupCode" NOT ILIKE 'IND%'`;

  // Parity with BRM my_renewal: userId = ANY(BrmUserIds)
  if (executiveId && executiveId !== "all") {
    params.push(executiveId);
    where += ` AND $${params.length}::text = ANY(b."BrmUserIds")`;
  }

  if (search) {
    params.push(`%${search.trim()}%`);
    where += ` AND (
      b."PolicyGroup" ILIKE $${params.length}
      OR b."BrokerName" ILIKE $${params.length}
      OR b."PolicyGroupCode" ILIKE $${params.length}
      OR b."BatchName" ILIKE $${params.length}
    )`;
  }

  const filterParams = [...params];
  params.push(parsedLimit);
  const limitIdx = params.length;
  params.push(parsedOffset);
  const offsetIdx = params.length;

  // Same as BRM BrokerCaseDetailsService.renewalMasterDataLateralJoin:
  // EndorsementTypeCode = '02' + PolicyList → TechnicalSheetNumber match.
  // Displayed Expiring Premium = stored column, fallback MasterData SUM(GrossPremium).
  const renewalMasterDataLateralJoin = `
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS member_count,
        COALESCE(SUM(m."GrossPremium"), 0)::float AS total_premium
      FROM public."MasterDataLayer" m
      WHERE m."EndorsementTypeCode" = '02'
        AND m."TechnicalSheetNumber"::text = ANY(
          ARRAY(
            SELECT TRIM(val)
            FROM unnest(string_to_array(REPLACE(COALESCE(b."PolicyList", ''), ' ', ''), ',')) AS val
            WHERE TRIM(val) <> ''
          )
        )
    ) mp ON TRUE
  `;

  const [rows, countRows, confirmedRows, premiumRows] = await Promise.all([
    query(
      `SELECT
         b."BatchId", b."PolicyGroup", b."PolicyGroupCode",
         b."BrokerName" AS "brokerName",
         TO_CHAR(b."EffectiveDate", 'DD-MM-YYYY') AS "EffectiveDate",
         b."BatchName", b."BatchStatus",
         b."ExpiringTPA", b."ExpiringBroker", b."ExpiringDIN",
         COALESCE(NULLIF(b."ExpiringPremium"::float, 0), mp.total_premium, 0)::float AS "ExpiringPremium",
         COALESCE(mp.total_premium, 0)::float AS "TotalExpiringPremium",
         COALESCE(mp.total_premium, 0)::float AS "TotalGrossPremium",
         b."ExpiringMH"::float AS "ExpiringMH",
         b."RenewalTPA", b."RenewalBroker", b."RenewalDIN", b."RenewalMH"::float AS "RenewalMH",
         b."RunningLossRatio"::float AS "RunningLossRatio",
         b."FinalIncrease"::float AS "FinalIncrease",
         b."BrmAction01"::text AS "BrmAction01",
         b."BrmActionStatus"::text AS "BrmActionStatus",
         b."BrmConfirmStatus"::text AS "BrmConfirmStatus",
         b."BrmActionType"::text AS "BrmActionType",
         b."BrmUserIds",
         COALESCE(mp.member_count, 0)::int AS "member_count"
       FROM public."BrmRenewalData" b
       ${renewalMasterDataLateralJoin}
       ${where}
       ORDER BY b."EffectiveDate" DESC NULLS LAST
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    query(`SELECT COUNT(*)::int AS count FROM public."BrmRenewalData" b ${where}`, filterParams),
    query(
      `SELECT COUNT(*)::int AS count FROM public."BrmRenewalData" b ${where} AND b."BrmActionStatus" = 2`,
      filterParams,
    ),
    query(
      `SELECT
         COALESCE(SUM(
           COALESCE(NULLIF(b."ExpiringPremium"::float, 0), mp.total_premium, 0)
         ), 0)::float AS "totalExpiringPremium",
         COALESCE(AVG(NULLIF(b."RunningLossRatio", 0)), 0)::float AS "avgLossRatio",
         COALESCE(AVG(NULLIF(b."FinalIncrease", 0)), 0)::float AS "avgIncrease"
       FROM public."BrmRenewalData" b
       ${renewalMasterDataLateralJoin}
       ${where}`,
      filterParams,
    ),
  ]);

  return {
    rows,
    total: toNumber(countRows[0]?.count),
    confirmedCount: toNumber(confirmedRows[0]?.count),
    totalExpiringPremium: toNumber(premiumRows[0]?.totalExpiringPremium),
    avgLossRatio: toNumber(premiumRows[0]?.avgLossRatio),
    avgIncrease: toNumber(premiumRows[0]?.avgIncrease),
    limit: parsedLimit,
    offset: parsedOffset,
    ownership: "brm_my_renewal_parity",
  };
}


async function getCompare({
  executiveIds = [],
  dateFrom,
  dateTo,
  compareFrom,
  compareTo,
} = {}) {
  const ids = Array.isArray(executiveIds)
    ? executiveIds.filter(Boolean).slice(0, 8)
    : String(executiveIds || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);

  const byExec = await getByExecutive({ dateFrom, dateTo });
  let selected = byExec.executives;
  if (ids.length) selected = byExec.executives.filter((e) => ids.includes(e.executiveId));

  let periodB = null;
  if (compareFrom && compareTo) {
    periodB = await getByExecutive({ dateFrom: compareFrom, dateTo: compareTo });
  }

  return {
    periodA: {
      dateFrom: byExec.dateFrom,
      dateTo: byExec.dateTo,
      executives: selected,
      totals: byExec.totals,
    },
    periodB: periodB
      ? {
          dateFrom: compareFrom,
          dateTo: compareTo,
          executives: ids.length
            ? periodB.executives.filter((e) => ids.includes(e.executiveId))
            : periodB.executives,
          totals: periodB.totals,
        }
      : null,
  };
}

/**
 * Fast overview — NO MasterDataLayer for pipeline (that stays on All Summary for booked production).
 * Pipeline uses BRM master_data ownership (broker mapping + DisplayID -B + open).
 * Dates optional when filtering a BRM (parity); defaults only for global trend chart.
 * Supports dealStatus + period for the new Management Overview UI.
 */
async function getOverviewSnapshot({ dateFrom, dateTo, executiveId, dealStatus, period = "monthly" } = {}) {
  const opt = optionalDates({ dateFrom, dateTo });
  const trendDates = withDefaultDates({ dateFrom, dateTo });
  const hasExec = executiveId && executiveId !== "all";
  const hasDeal =
    dealStatus != null && dealStatus !== "" && String(dealStatus) !== "all";
  const dealVal = hasDeal ? parseInt(dealStatus, 10) : null;

  const pipelineParams = [];
  let pipelineSql;

  if (hasExec) {
    pipelineParams.push(executiveId);
    const dateConds = [];
    if (opt.dateFrom) {
      pipelineParams.push(opt.dateFrom);
      dateConds.push(`qc."CreateDate"::date >= $${pipelineParams.length}::date`);
    }
    if (opt.dateTo) {
      pipelineParams.push(opt.dateTo);
      dateConds.push(`qc."CreateDate"::date <= $${pipelineParams.length}::date`);
    }
    let dealParam = "";
    if (hasDeal) {
      pipelineParams.push(dealVal);
      dealParam = `AND qc."DealStatus" = $${pipelineParams.length}`;
    }
    const dateSql = dateConds.length ? `AND ${dateConds.join(" AND ")}` : "";
    pipelineSql = `
      WITH ${brokerUsersCteSql("$1")},
      scoped AS (
        SELECT qc."ID", qc."DealStatus", qc."TargetPremium", qc."DisplayID"
        FROM public."HealthInsuranceQuotationCase" qc
        WHERE ${MASTER_DATA_CASE_FILTER}
        ${dateSql}
        ${dealParam}
      ),
      latest AS (
        SELECT DISTINCT ON (REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''))
          s."ID", s."DealStatus", s."TargetPremium"
        FROM scoped s
        ORDER BY REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''), s."ID" DESC
      )
      SELECT
        COUNT(*)::int AS "openCount",
        0::int AS "bookedCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 3)::int AS "wonCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 4)::int AS "lostCount",
        COUNT(*)::int AS "totalCount",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "totalGrossPremium",
        0::float AS "bookedPremium",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "openPremium"
      FROM latest
    `;
  } else {
    const dateConds = [
      `qc."DisplayID" ~ '-B[0-9]+'`,
      `qc."BookingStatus" IS false`,
    ];
    if (opt.dateFrom) {
      pipelineParams.push(opt.dateFrom);
      dateConds.push(`qc."CreateDate"::date >= $${pipelineParams.length}::date`);
    } else {
      pipelineParams.push(trendDates.dateFrom);
      dateConds.push(`qc."CreateDate"::date >= $${pipelineParams.length}::date`);
    }
    if (opt.dateTo) {
      pipelineParams.push(opt.dateTo);
      dateConds.push(`qc."CreateDate"::date <= $${pipelineParams.length}::date`);
    } else {
      pipelineParams.push(trendDates.dateTo);
      dateConds.push(`qc."CreateDate"::date <= $${pipelineParams.length}::date`);
    }
    if (hasDeal) {
      pipelineParams.push(dealVal);
      dateConds.push(`qc."DealStatus" = $${pipelineParams.length}`);
    }
    pipelineSql = `
      SELECT
        COUNT(*)::int AS "openCount",
        0::int AS "bookedCount",
        COUNT(*) FILTER (WHERE qc."DealStatus" = 1)::int AS "hotCount",
        COUNT(*) FILTER (WHERE qc."DealStatus" = 2)::int AS "activeCount",
        COUNT(*) FILTER (WHERE qc."DealStatus" = 3)::int AS "wonCount",
        COUNT(*) FILTER (WHERE qc."DealStatus" = 4)::int AS "lostCount",
        COUNT(*)::int AS "totalCount",
        COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS "totalGrossPremium",
        0::float AS "bookedPremium",
        COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float AS "openPremium"
      FROM public."HealthInsuranceQuotationCase" qc
      WHERE ${dateConds.join(" AND ")}
    `;
  }

  // MasterDataLayer booked production for Consolidated "Booked Premium" tile (All Summary source)
  const bookedParams = [];
  const bookedConds = buildMasterDateConditions(
    opt.dateFrom || trendDates.dateFrom,
    opt.dateTo || trendDates.dateTo,
    bookedParams,
  );
  bookedConds.push(`UPPER(TRIM("NewOrRenewal")) = 'NEW'`);
  bookedConds.push(`COALESCE("EventNbr"::int, 1) = 1`);
  const bookedWhere = bookedConds.length ? `WHERE ${bookedConds.join(" AND ")}` : "";

  const [byExecutive, trends, pipeline, renewalSnap, bookedRows] = await Promise.all([
    getByExecutive({
      dateFrom: opt.dateFrom,
      dateTo: opt.dateTo,
      dealStatus: hasDeal ? dealStatus : undefined,
    }),
    getTrends({
      period: period === "yearly" ? "yearly" : "monthly",
      executiveId,
      dateFrom: trendDates.dateFrom,
      dateTo: trendDates.dateTo,
    }),
    query(pipelineSql, pipelineParams),
    hasExec
      ? getRenewals({ executiveId, policyType: "Group", limit: 1, offset: 0 })
      : getRenewals({ policyType: "Group", limit: 1, offset: 0 }),
    query(
      `SELECT COALESCE(SUM("GrossPremium"), 0)::float AS "bookedPremium",
              COUNT(*)::int AS "bookedCount"
       FROM public."MasterDataLayer"
       ${bookedWhere}`,
      bookedParams,
    ).catch(() => [{ bookedPremium: 0, bookedCount: 0 }]),
  ]);

  const p = pipeline[0] || {};
  const bookedPremium = toNumber(bookedRows[0]?.bookedPremium);
  const bookedCount = toNumber(bookedRows[0]?.bookedCount);
  const topBrms = [...byExecutive.executives]
    .sort((a, b) => toNumber(b.totalGrossPremium) - toNumber(a.totalGrossPremium))
    .filter((e) => toNumber(e.totalCases) > 0)
    .slice(0, 8);

  const pipelineHealth = {
    open: toNumber(p.openCount),
    hot: toNumber(p.hotCount),
    active: toNumber(p.activeCount),
    won: toNumber(p.wonCount),
    lost: toNumber(p.lostCount),
    total: toNumber(p.totalCount),
    openPremium: toNumber(p.openPremium),
  };

  const cards = {
    achievedTotal: bookedPremium,
    AchievedBookedConfirmedNewPremium: bookedPremium,
    AchievedBookedConfirmedRenewalPremium: toNumber(renewalSnap.totalExpiringPremium),
    totalPremium: toNumber(p.totalGrossPremium),
    openPremium: toNumber(p.openPremium),
    bookedPremium,
    bookedCount,
    forecastTotal: bookedPremium + toNumber(p.openPremium) * 0.6,
    nbCount: toNumber(p.totalCount),
    renCount: toNumber(renewalSnap.total),
    endCount: 0,
    openPipelineCount: toNumber(p.openCount),
    brmCount: byExecutive.executives.length,
    dateFrom: opt.dateFrom || trendDates.dateFrom,
    dateTo: opt.dateTo || trendDates.dateTo,
  };

  const insights = [];
  if (topBrms[0]) {
    insights.push({
      type: "top_performer",
      title: "Top BRM by target premium",
      detail: `${topBrms[0].executiveName} · ${formatInt(topBrms[0].totalCases)} cases · AED ${Math.round(toNumber(topBrms[0].totalGrossPremium)).toLocaleString()}`,
    });
  }
  insights.push({
    type: "pipeline",
    title: "Open pipeline (master_data parity)",
    detail: `${toNumber(p.openCount)} open B-cases · Hot ${toNumber(p.hotCount)} · Active ${toNumber(p.activeCount)}`,
  });
  const lowWin = topBrms
    .filter((e) => e.winRate != null && toNumber(e.wonCases) + toNumber(e.lostCases) >= 3)
    .sort((a, b) => (a.winRate ?? 0) - (b.winRate ?? 0))[0];
  if (lowWin) {
    insights.push({
      type: "attention",
      title: "Win-rate watch",
      detail: `${lowWin.executiveName} at ${lowWin.winRate}%`,
    });
  }

  return {
    cards,
    pipelineHealth,
    byExecutive: topBrms,
    byExecutiveTotals: byExecutive.totals,
    executiveCount: byExecutive.executives.length,
    trends: trends.series,
    caseKpis: {
      totalCount: toNumber(p.openCount),
      activeCount: toNumber(p.activeCount),
      hotCount: toNumber(p.hotCount),
      wonCount: toNumber(p.wonCount),
      lostCount: toNumber(p.lostCount),
      totalGrossPremium: toNumber(p.openPremium),
    },
    insights,
    ownership: hasExec ? "brm_master_data_parity" : "all_open_b_cases",
    filters: {
      dateFrom: cards.dateFrom,
      dateTo: cards.dateTo,
      executiveId: hasExec ? executiveId : "all",
      dealStatus: hasDeal ? String(dealStatus) : "all",
      period: period === "yearly" ? "yearly" : "monthly",
    },
    dateFrom: cards.dateFrom,
    dateTo: cards.dateTo,
  };
}

function formatInt(n) {
  return toNumber(n).toLocaleString();
}

module.exports = {
  getExecutives,
  getSummaryCards,
  getSummaryList,
  getCases,
  getByExecutive,
  getTrends,
  getRenewals,
  getCompare,
  getOverviewSnapshot,
};
