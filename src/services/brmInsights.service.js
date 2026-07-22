/**
 * Management BRM Insights â€” executive read aggregations against shared Postgres.
 * BRM list: AspNetRoles.Name IN ('BRM','Admin') â€” not hardcoded RoleId (BRM backend GUID is stale).
 */
const { prisma } = require("../lib/prisma");
const Redis = require("ioredis");

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : null;

const SUMMARY_CARDS_CACHE_TTL_SEC = parseInt(
  process.env.REDIS_TTL_SUMMARY_CARDS || "120",
  10,
);

/** Match BRM Assign form intent + include Admin as management asked */
const BRM_ROLE_NAMES = ["BRM", "Admin"];

/** Latest member row per Name+DOB (handles duplicated census on a case version).
 * Gross = BaseAmount (formula-adjusted); falls back to PlanAmount / TotalAmount.
 * Matches CRM HealthInsuranceQuotationCaseRepository plan-assign / Update Loading.
 */
const memberPremiumAmountSql = `COALESCE(qm."BaseAmount", qm."PlanAmount", qm."TotalAmount", 0)`;

const quotationMemberGpSql = (caseIdExpr) => `
  (
    SELECT COALESCE(SUM(deduped.gross_amt), 0)
    FROM (
      SELECT DISTINCT ON (
        TRIM(COALESCE(qm."Name", '')),
        qm."DateofBirth"
      )
        ${memberPremiumAmountSql} AS gross_amt
      FROM public."HealthInsuranceQuotationMember" qm
      WHERE qm."HealthInsuranceQuotationCaseID" = ${caseIdExpr}
        AND COALESCE(qm."IsDeleted", false) = false
        AND COALESCE(qm."IsArchived", false) = false
      ORDER BY
        TRIM(COALESCE(qm."Name", '')),
        qm."DateofBirth",
        qm."ID" DESC
    ) deduped
  )
`;

const planAllocatedFeePctSql = `(
  SELECT COALESCE(SUM(fd."Percentage"), 0)
  FROM public."HealthInsurancePlan" hp
  INNER JOIN public."HealthInsuranceFormulaDetail" fd
    ON fd."HealthInsuranceFormulaID" = hp."HealthInsuranceFormulaID"
  WHERE hp."ID" = qm."HealthInsurancePlanID"
)`;

/** Net = PlanAmount Ã— (1 âˆ’ plan fees) when case formula set; else same as gross. */
const quotationMemberNetSql = (caseIdExpr, caseFormulaIdExpr) => `
  (
    SELECT COALESCE(SUM(deduped.net_amt), 0)
    FROM (
      SELECT DISTINCT ON (
        TRIM(COALESCE(qm."Name", '')),
        qm."DateofBirth"
      )
        CASE
          WHEN COALESCE(${caseFormulaIdExpr}, 0) > 0
          THEN COALESCE(qm."PlanAmount", 0) * (1.0 - COALESCE(${planAllocatedFeePctSql}, 0))
          ELSE ${memberPremiumAmountSql}
        END AS net_amt
      FROM public."HealthInsuranceQuotationMember" qm
      WHERE qm."HealthInsuranceQuotationCaseID" = ${caseIdExpr}
        AND COALESCE(qm."IsDeleted", false) = false
        AND COALESCE(qm."IsArchived", false) = false
      ORDER BY
        TRIM(COALESCE(qm."Name", '')),
        qm."DateofBirth",
        qm."ID" DESC
    ) deduped
  )
`;

const toNumber = (v) => {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && v !== null) {
    // Prisma Decimal / decimal.js â†’ { s, e, d }
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

/** Soft default = current calendar month (All Summary / dashboard parity) */
const withDefaultDates = ({ dateFrom, dateTo } = {}) => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const monthEnd = `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return {
    dateFrom: dateFrom && String(dateFrom).trim() ? String(dateFrom).trim() : monthStart,
    dateTo: dateTo && String(dateTo).trim() ? String(dateTo).trim() : monthEnd,
  };
};

/** Parse one or many BRM display names from `brmName` / comma-separated list. */
const parseBrmNames = (brmName) =>
  String(brmName || "")
    .split(",")
    .map((s) => s.replace(/\s*·\s*Admin$/i, "").trim())
    .filter(Boolean);

/** Append MasterDataLayer BRM name filter (exact, case-insensitive). */
const pushBrmNameCondition = (conditions, params, brmName, column = `"BusinessRelationManager"`) => {
  const names = parseBrmNames(brmName);
  if (!names.length) return names;
  if (names.length === 1) {
    params.push(names[0]);
    conditions.push(`LOWER(TRIM(COALESCE(${column}, ''))) = LOWER($${params.length})`);
    return names;
  }
  params.push(names);
  conditions.push(
    `LOWER(TRIM(COALESCE(${column}, ''))) = ANY(SELECT LOWER(TRIM(x)) FROM unnest($${params.length}::text[]) AS x)`,
  );
  return names;
};

/** Resolve AspNet user ids for BRM display names (for quotation / renewal assign filters). */
const resolveAspNetIdsByNames = async (names) => {
  if (!names.length) return [];
  const rows = await query(
    `
    SELECT DISTINCT an."Id"::text AS id
    FROM public."AspNetUsers" an
    LEFT JOIN public."User" u ON u."AspNetUserID" = an."Id"
    WHERE LOWER(TRIM(COALESCE(NULLIF(TRIM(u."Name"), ''), an."UserName", '')))
            = ANY(SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)
       OR LOWER(TRIM(COALESCE(an."UserName", '')))
            = ANY(SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)
    `,
    [names],
  );
  return rows.map((r) => String(r.id)).filter(Boolean);
};

/** True when AssignedBrmExecutive csv overlaps any of the AspNet ids. */
const assignedBrmContainsSql = (columnExpr, paramIdx) => `
  (
    ${columnExpr} IS NOT NULL
    AND TRIM(COALESCE(${columnExpr}::text, '')) <> ''
    AND EXISTS (
      SELECT 1
      FROM unnest(
        string_to_array(REPLACE(COALESCE(${columnExpr}::text, ''), ' ', ''), ',')
      ) AS aid(id)
      WHERE TRIM(aid.id) <> ''
        AND TRIM(aid.id) = ANY($${paramIdx}::text[])
    )
  )
`;

/** Optional dates — empty means no date filter (BRM master_data parity) */
const optionalDates = ({ dateFrom, dateTo } = {}) => ({
  dateFrom: dateFrom && String(dateFrom).trim() ? String(dateFrom).trim() : null,
  dateTo: dateTo && String(dateTo).trim() ? String(dateTo).trim() : null,
});

/** If From→To spans more than maxDays, keep the last maxDays ending at dateTo (or today). */
const clampDateSpan = ({ dateFrom, dateTo } = {}, maxDays = 366) => {
  const to = dateTo && String(dateTo).trim() ? new Date(String(dateTo).trim()) : new Date();
  let from = dateFrom && String(dateFrom).trim() ? new Date(String(dateFrom).trim()) : null;
  if (Number.isNaN(to.getTime())) {
    return withDefaultDates({});
  }
  if (!from || Number.isNaN(from.getTime())) {
    from = new Date(to);
    from.setDate(from.getDate() - Math.min(maxDays, 31));
  }
  const spanMs = to.getTime() - from.getTime();
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  if (spanMs > maxMs) {
    from = new Date(to.getTime() - maxMs);
  }
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { dateFrom: iso(from), dateTo: iso(to) };
};

/**
 * Same broker user set as BRM caseDetailsList:
 * UserBrokerMapping.UserId = AspNet BRM id â†’ CompanyId â†’ User.ID at those companies.
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

/**
 * Same ownership as BRM caseDetailsList (scope=own):
 * broker-mapped creators OR AssignedBrmExecutive OR BRM self-created.
 * $1 must be the AspNet BRM user id.
 */
const MASTER_DATA_CASE_FILTER = `
  (
    qc."CreatedByUserID" = ANY(SELECT "ID" FROM broker_users)
    OR qc."AssignedBrmExecutive"::text = $1::text
    OR EXISTS (
      SELECT 1
      FROM public."User" creator
      WHERE creator."ID" = qc."CreatedByUserID"
        AND creator."AspNetUserID"::text = $1::text
    )
  )
  AND qc."DisplayID" ~ '-[BD][0-9]+'
  AND qc."BookingStatus" IS false
`;

/** Cheap member GP for KPI totals (no Name+DOB dedupe). */
const memberGpSumSql = (caseIdExpr) => `
  (
    SELECT COALESCE(SUM(COALESCE(qm."BaseAmount", qm."PlanAmount", qm."TotalAmount", 0)), 0)
    FROM public."HealthInsuranceQuotationMember" qm
    WHERE qm."HealthInsuranceQuotationCaseID" = ${caseIdExpr}
      AND COALESCE(qm."IsDeleted", false) = false
      AND COALESCE(qm."IsArchived", false) = false
  )
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
 * List real BRM (+ Admin) users by role NAME â€” same intent as BRM workbasket,
 * but GUID 05be3be5-â€¦ is wrong/stale in this DB (actual BRM role Id differs).
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
  const brmNames = pushBrmNameCondition(conditions, params, brmName);

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const cacheKey =
    `mgmt:brm:summaryCards:${brmNames.length ? brmNames.join("|").toLowerCase() : "all"}:` +
    `${dates.dateFrom}:${dates.dateTo}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // ignore cache read errors
    }
  }

  const brmIds = brmNames.length ? await resolveAspNetIdsByNames(brmNames) : [];
  const pipelineParams = [];
  let nbAssignFilter = "";
  let rnAssignFilter = "";
  if (brmIds.length) {
    pipelineParams.push(brmIds);
    const p = pipelineParams.length;
    nbAssignFilter = ` AND ${assignedBrmContainsSql('qc."AssignedBrmExecutive"', p)}`;
    rnAssignFilter = ` AND (
      brd."BrmUserIds" IS NOT NULL
      AND cardinality(brd."BrmUserIds") > 0
      AND brd."BrmUserIds" && $${p}::text[]
    )`;
  } else if (brmNames.length) {
    // Names selected but no AspNet match — force empty pipeline so KPIs don't stay "all"
    nbAssignFilter = " AND FALSE";
    rnAssignFilter = " AND FALSE";
  }

  // Booked = MasterDataLayer (date-filtered). Confirmed pipeline matches BRM All Summary:
  // NB = HealthInsuranceQuotationCase DealStatus=2 not booked (latest version);
  // RN = BrmRenewalData Distributed + BrmActionStatus=2 (no date filter on open pipeline).
  const [bookedRows, pipelineRows] = await Promise.all([
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
        COUNT(DISTINCT "TechnicalSheetNumber") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW' AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "nbCount",
        COUNT(DISTINCT "TechnicalSheetNumber") FILTER (
          WHERE UPPER(TRIM("NewOrRenewal")) = 'RENEWAL' AND COALESCE("EventNbr"::int, 1) = 1
        )::int AS "renCount",
        COUNT(DISTINCT "TechnicalSheetNumber") FILTER (
          WHERE COALESCE("EventNbr"::int, 1) <> 1
        )::int AS "endCount",
        COUNT(DISTINCT "TechnicalSheetNumber")::int AS "totalCount",
        (
          COALESCE(SUM("GrossPremium") FILTER (
            WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW' AND COALESCE("EventNbr"::int, 1) = 1
          ), 0)
          + COALESCE(SUM("GrossPremium") FILTER (
            WHERE UPPER(TRIM("NewOrRenewal")) = 'RENEWAL' AND COALESCE("EventNbr"::int, 1) = 1
          ), 0)
          + COALESCE(SUM("GrossPremium") FILTER (
            WHERE COALESCE("EventNbr"::int, 1) <> 1
          ), 0)
        )::float AS "totalPremium"
      FROM public."MasterDataLayer"
      ${whereClause}
      `,
      params,
    ),
    query(
      `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM (
            SELECT DISTINCT ON (REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
              qc."ID"
            FROM public."HealthInsuranceQuotationCase" qc
            WHERE qc."BookingStatus" IS false
              AND qc."DisplayID" ~ '-[BI][0-9]+'
              AND qc."DealStatus" = 2
              ${nbAssignFilter}
            ORDER BY REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
          ) t
        ) AS "confirmedNewCount",
        (
          SELECT COUNT(*)::int
          FROM public."BrmRenewalData" brd
          WHERE brd."BatchStatus" = 'Distributed'
            AND brd."BrmActionStatus" = 2
            ${rnAssignFilter}
        ) AS "confirmedRenewalCount",
        (
          SELECT COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float
          FROM (
            SELECT DISTINCT ON (REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
              qc."ID", qc."TargetPremium"
            FROM public."HealthInsuranceQuotationCase" qc
            WHERE qc."BookingStatus" IS false
              AND qc."DisplayID" ~ '-[BI][0-9]+'
              AND qc."DealStatus" = 2
              ${nbAssignFilter}
            ORDER BY REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
          ) qc
        ) AS "confirmedNewPremium",
        (
          SELECT COALESCE(SUM(
            COALESCE(NULLIF(brd."ExpiringPremium"::float, 0), mp.total_premium, 0)
          ), 0)::float
          FROM public."BrmRenewalData" brd
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(m."GrossPremium"), 0)::float AS total_premium
            FROM public."MasterDataLayer" m
            WHERE m."EndorsementTypeCode" = '02'
              AND m."TechnicalSheetNumber"::text = ANY(
                ARRAY(
                  SELECT TRIM(val)
                  FROM unnest(string_to_array(REPLACE(COALESCE(brd."PolicyList", ''), ' ', ''), ',')) AS val
                  WHERE TRIM(val) <> ''
                )
              )
          ) mp ON TRUE
          WHERE brd."BatchStatus" = 'Distributed'
            AND brd."BrmActionStatus" = 2
            ${rnAssignFilter}
        ) AS "confirmedRenewalPremium",
        (
          SELECT COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float
          FROM (
            SELECT DISTINCT ON (REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
              qc."ID", qc."TargetPremium", qc."RenewalFromCaseID"
            FROM public."HealthInsuranceQuotationCase" qc
            WHERE qc."BookingStatus" IS true
              AND qc."DisplayID" ~ '-[BI][0-9]+'
              ${nbAssignFilter}
            ORDER BY REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
          ) qc
          WHERE qc."RenewalFromCaseID" IS NULL OR qc."RenewalFromCaseID" = 0
        ) AS "AchievedBookedConfirmedNewPremium",
        (
          SELECT COALESCE(SUM(COALESCE(qc."TargetPremium", 0)), 0)::float
          FROM (
            SELECT DISTINCT ON (REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
              qc."ID", qc."TargetPremium", qc."RenewalFromCaseID"
            FROM public."HealthInsuranceQuotationCase" qc
            WHERE qc."BookingStatus" IS true
              AND qc."DisplayID" ~ '-[BI][0-9]+'
              ${nbAssignFilter}
            ORDER BY REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
          ) qc
          WHERE qc."RenewalFromCaseID" IS NOT NULL AND qc."RenewalFromCaseID" > 0
        ) AS "AchievedBookedConfirmedRenewalPremium"
      `,
      pipelineParams,
    ),
  ]);

  const booked = bookedRows[0] || {};
  const p = pipelineRows[0] || {};

  const confirmedNew = toNumber(p.confirmedNewPremium);
  const confirmedRen = toNumber(p.confirmedRenewalPremium);
  // Same as BRM: Achieved quotation booked TargetPremium + open confirmed pipeline
  const achievedNewTotal =
    toNumber(p.AchievedBookedConfirmedNewPremium) + confirmedNew;
  const achievedRenTotal =
    toNumber(p.AchievedBookedConfirmedRenewalPremium) + confirmedRen;
  const endPremium =
    toNumber(booked.endGroupPremium) + toNumber(booked.endIndividualPremium);
  const achievedTotal = achievedNewTotal + achievedRenTotal + endPremium;
  const forecastTotal = achievedTotal + 0.6 * (confirmedNew + confirmedRen);

  const out = {
    ...booked,
    confirmedNewCount: toNumber(p.confirmedNewCount),
    confirmedRenewalCount: toNumber(p.confirmedRenewalCount),
    confirmedNewPremium: confirmedNew,
    confirmedRenewalPremium: confirmedRen,
    AchievedBookedConfirmedNewPremium: achievedNewTotal,
    AchievedBookedConfirmedRenewalPremium: achievedRenTotal,
    achievedTotal,
    forecastTotal,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  };

  if (redis) {
    try {
      await redis.setex(cacheKey, SUMMARY_CARDS_CACHE_TTL_SEC, JSON.stringify(out));
    } catch {
      // ignore cache write failures
    }
  }

  return out;
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
  pushBrmNameCondition(conditions, params, brmName);

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
 * New Business cases â€” ownership matches BRM master_data (caseDetailsList).
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

  // Scoped to one BRM â€” parity with BRM caseDetailsList (own)
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
          SELECT
            qc."ID",
            qc."DealStatus",
            qc."Status",
            qc."DisplayID",
            REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,
            CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\1'), qc."DisplayID") AS INT) AS version_num
          FROM public."HealthInsuranceQuotationCase" qc
          LEFT JOIN public."User" u ON qc."CreatedByUserID" = u."ID"
          LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
          WHERE ${MASTER_DATA_CASE_FILTER}
          ${extraSql}
        ),
        latest AS (
          SELECT DISTINCT ON (base_display_id)
            "ID", "DealStatus", "Status"
          FROM scoped
          ORDER BY base_display_id, version_num DESC NULLS LAST
        )
        SELECT
          COUNT(*)::int AS "totalCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",
          COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",
          COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCount",
          COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCount",
          COALESCE(SUM(${memberGpSumSql('"ID"')}), 0)::float AS "totalGrossPremium"
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
            qc."Status",
            qc."TargetPremium",
            qc."HealthInsuranceFormulaID",
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
          l."Status" AS "case_status",
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
          l."Status" AS "brm_status",
          brm."Priority" AS "brm_priority",
          brm."Potential" AS "brm_potential",
          brm."ConfirmStatus" AS "brm_confirm_status",
          ${quotationMemberGpSql('l."ID"')}::float AS "gross_premium",
          ${quotationMemberNetSql('l."ID"', 'l."HealthInsuranceFormulaID"')}::float AS "net_premium",
          (
            ${quotationMemberGpSql('l."ID"')} - COALESCE(l."TargetPremium", 0)
          )::float AS "difference"
        FROM latest l
        LEFT JOIN LATERAL (
          SELECT b."Priority", b."Potential", b."ConfirmStatus"
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

  // All BRMs â€” open B/D cases, latest version only
  params.length = 0;
  const allExtra = [
    `qc."DisplayID" ~ '-[BD][0-9]+'`,
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
  const whereAll = allExtra.join(" AND ");
  const filterParamsAll = [...params];
  params.push(parsedLimit);
  const limitIdxAll = params.length;
  params.push(parsedOffset);
  const offsetIdxAll = params.length;

  const [aggRowsAll, caseRowsAll] = await Promise.all([
    query(
      `
      WITH scoped AS (
        SELECT
          qc."ID",
          qc."DealStatus",
          qc."Status",
          qc."DisplayID",
          REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,
          CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\1'), qc."DisplayID") AS INT) AS version_num
        FROM public."HealthInsuranceQuotationCase" qc
        LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
        WHERE ${whereAll}
      ),
      latest AS (
        SELECT DISTINCT ON (base_display_id)
          "ID", "DealStatus", "Status"
        FROM scoped
        ORDER BY base_display_id, version_num DESC NULLS LAST
      )
      SELECT
        COUNT(*)::int AS "totalCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",
        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",
        COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCount",
        COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCount",
        COALESCE(SUM(${memberGpSumSql('"ID"')}), 0)::float AS "totalGrossPremium"
      FROM latest
      `,
      filterParamsAll,
    ),
    query(
      `
      WITH scoped AS (
        SELECT
          qc."ID",
          qc."DisplayID",
          qc."DealStatus",
          qc."Status",
          qc."TargetPremium",
          qc."HealthInsuranceFormulaID",
          qc."BrokerCompanyName",
          qc."BrokerEmail",
          qc."QuotationPreparedBy",
          qc."AssignedBrmExecutive",
          qc."ReferenceNumber",
          qc."Insurer",
          qc."PolicyEffectiveDate",
          qc."CreateDate",
          c."Name" AS "client_name",
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
          (
            SELECT COALESCE(NULLIF(TRIM(bru."UserName"), ''), bru."Email")
            FROM public."User" broker
            JOIN public."UserBrokerMapping" ubm ON ubm."CompanyId" = broker."CompanyID"
            JOIN public."AspNetUsers" bru ON bru."Id" = ubm."UserId"
            WHERE broker."ID" = qc."CreatedByUserID"
            LIMIT 1
          ) AS "brm_name",
          REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,
          CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\1'), qc."DisplayID") AS INT) AS version_num
        FROM public."HealthInsuranceQuotationCase" qc
        LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
        WHERE ${whereAll}
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
        l."Status" AS "case_status",
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
        l."brm_name",
        l."Status" AS "brm_status",
        brm."Priority" AS "brm_priority",
        brm."Potential" AS "brm_potential",
        brm."ConfirmStatus" AS "brm_confirm_status",
        ${quotationMemberGpSql('l."ID"')}::float AS "gross_premium",
        ${quotationMemberNetSql('l."ID"', 'l."HealthInsuranceFormulaID"')}::float AS "net_premium",
        (
          ${quotationMemberGpSql('l."ID"')} - COALESCE(l."TargetPremium", 0)
        )::float AS "difference"
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT b."Priority", b."Potential", b."ConfirmStatus"
        FROM public."BrmCaseActionsUpdates" b
        WHERE b."CaseID" = l."ID"
        ORDER BY b."UpdatedAt" DESC NULLS LAST
        LIMIT 1
      ) brm ON TRUE
      ORDER BY l."ID" DESC
      LIMIT $${limitIdxAll} OFFSET $${offsetIdxAll}
      `,
      params,
    ),
  ]);

  const aggAll = aggRowsAll[0] || {};
  return {
    cases: caseRowsAll,
    totalCount: toNumber(aggAll.totalCount),
    activeCount: toNumber(aggAll.activeCount),
    hotCount: toNumber(aggAll.hotCount),
    wonCount: toNumber(aggAll.wonCount),
    lostCount: toNumber(aggAll.lostCount),
    totalGrossPremium: toNumber(aggAll.totalGrossPremium),
    limit: parsedLimit,
    offset: parsedOffset,
    ownership: "all_open_bd_cases",
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  };
}


/**
 * Per-BRM ranking — same ownership as BRM master_data.
 * Fast path: TargetPremium / ExpiringPremium only (no per-case member SUM, no MasterData lateral).
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
    open_latest AS (
      SELECT DISTINCT ON (bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
        bu."Id" AS executive_id,
        qc."ID" AS case_id,
        qc."DealStatus",
        qc."Status",
        COALESCE(qc."TargetPremium", 0)::float AS target_premium
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-[BI][0-9]+'
        AND qc."BookingStatus" IS false
        ${openDateFilter}
      ORDER BY bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
    ),
    booked_latest AS (
      SELECT DISTINCT ON (bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
        bu."Id" AS executive_id,
        qc."ID" AS case_id,
        COALESCE(qc."TargetPremium", 0)::float AS target_premium
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-[BI][0-9]+'
        AND qc."BookingStatus" IS true
        ${bookedDateFilter}
      ORDER BY bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
    ),
    open_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "newCaseTotal",
        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCases",
        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCases",
        COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCases",
        COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCases",
        COALESCE(SUM(target_premium), 0)::float AS "openPremium"
      FROM open_latest
      GROUP BY executive_id
    ),
    booked_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "bookedCaseTotal",
        COALESCE(SUM(target_premium), 0)::float AS "bookedPremium"
      FROM booked_latest
      GROUP BY executive_id
    ),
    renewal_agg AS (
      SELECT bu."Id" AS executive_id,
             COUNT(*)::int AS "renewalCaseTotal",
             COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "renewalPremium"
      FROM brm_users bu
      JOIN public."BrmRenewalData" b ON bu."Id" = ANY(b."BrmUserIds")
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
  const clamped = clampDateSpan({ dateFrom, dateTo }, 366);
  const dates = withDefaultDates(clamped);
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
      WHERE qc."DisplayID" ~ '-[BI][0-9]+'
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
             COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "expiringPremium",
             0::float AS "nbBookedPremium",
             COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "renBookedPremium"
      FROM public."BrmRenewalData" b
      WHERE b."BatchStatus" = 'Distributed'
        AND $1::text = ANY(b."BrmUserIds")
        AND b."EffectiveDate"::date BETWEEN $2::date AND $3::date
      GROUP BY 1 ORDER BY 1 ASC`
    : `
      SELECT TO_CHAR(date_trunc('${trunc}', b."EffectiveDate"), ${fmt}) AS period,
             COUNT(*)::int AS "batchCount",
             COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "expiringPremium",
             0::float AS "nbBookedPremium",
             COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "renBookedPremium"
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
  // EndorsementTypeCode = '02' + PolicyList â†’ TechnicalSheetNumber match.
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
  // Cap huge ranges (global Management filter often sends 18+ months → gateway 504)
  const clamped = clampDateSpan({ dateFrom, dateTo }, 366);
  const opt = optionalDates(clamped);
  const trendDates = withDefaultDates(clamped);
  const hasExec = executiveId && executiveId !== "all";
  const hasDeal =
    dealStatus != null && dealStatus !== "" && String(dealStatus) !== "all";
  const dealVal = hasDeal ? parseInt(dealStatus, 10) : null;

  const cacheKey =
    `mgmt:brm:overview:` +
    `${hasExec ? executiveId : "all"}:` +
    `${hasDeal ? dealStatus : "all"}:` +
    `${period}:` +
    `${opt.dateFrom || trendDates.dateFrom}:${opt.dateTo || trendDates.dateTo}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // ignore
    }
  }

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
      `qc."DisplayID" ~ '-[BI][0-9]+'`,
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

  const bookedFrom = opt.dateFrom || trendDates.dateFrom;
  const bookedTo = opt.dateTo || trendDates.dateTo;
  const bookedParams = [bookedFrom, bookedTo];

  const renewalParams = hasExec ? [executiveId] : [];
  const renewalWhere = hasExec
    ? `WHERE b."BatchStatus" = 'Distributed' AND $1::text = ANY(b."BrmUserIds")`
    : `WHERE b."BatchStatus" = 'Distributed'`;

  const [byExecutive, trends, pipeline, renewalRows, bookedRows] = await Promise.all([
    getByExecutive({
      dateFrom: opt.dateFrom || trendDates.dateFrom,
      dateTo: opt.dateTo || trendDates.dateTo,
      dealStatus: hasDeal ? dealStatus : undefined,
    }),
    getTrends({
      period: period === "yearly" ? "yearly" : "monthly",
      executiveId,
      dateFrom: trendDates.dateFrom,
      dateTo: trendDates.dateTo,
    }),
    query(pipelineSql, pipelineParams),
    query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "totalExpiringPremium"
       FROM public."BrmRenewalData" b
       ${renewalWhere}`,
      renewalParams,
    ),
    query(
      `SELECT COALESCE(SUM("GrossPremium"), 0)::float AS "bookedPremium",
              COUNT(*)::int AS "bookedCount"
       FROM public."MasterDataLayer"
       WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW'
         AND COALESCE("EventNbr"::int, 1) = 1
         AND "PolicyEffectiveDate" >= $1::date
         AND "PolicyEffectiveDate" <= $2::date`,
      bookedParams,
    ).catch(() => [{ bookedPremium: 0, bookedCount: 0 }]),
  ]);

  const p = pipeline[0] || {};
  const renewalSnap = renewalRows[0] || {};
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

  const out = {
    cards,
    pipelineHealth,
    byExecutive: topBrms,
    byExecutiveFull: byExecutive.executives,
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

  if (redis) {
    try {
      await redis.setex(cacheKey, 60, JSON.stringify(out));
    } catch {
      // ignore
    }
  }

  return out;
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
