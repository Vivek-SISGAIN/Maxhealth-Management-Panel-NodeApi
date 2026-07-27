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

/** Match BRM my_renewal: empty BrmUserIds = unassigned */
const RENEWAL_UNASSIGNED_SQL = `(
  b."BrmUserIds" IS NULL
  OR COALESCE(array_length(b."BrmUserIds", 1), 0) = 0
)`;

/**
 * BRM dashboard Group filter = PolicyGroupCode NOT ILIKE 'IND%'.
 * All scope also includes Draft rows with no BRM (queued, not mapped yet).
 */
const renewalBatchScopeSql = (includeDraftUnassigned = false) =>
  includeDraftUnassigned
    ? `(b."BatchStatus" = 'Distributed' OR (b."BatchStatus" = 'Draft' AND ${RENEWAL_UNASSIGNED_SQL}))`
    : `b."BatchStatus" = 'Distributed'`;

const RENEWAL_GROUP_ONLY_SQL = `b."PolicyGroupCode" NOT ILIKE 'IND%'`;

/** Text cast — column may be int or text; BRM UI: 1/4→Ongoing, 2→Confirmed, 3→Lost, else Pending */
const RENEWAL_STATUS_CODE = `TRIM(COALESCE(b."BrmActionStatus"::text, ''))`;
const RENEWAL_ONGOING_SQL = `${RENEWAL_STATUS_CODE} IN ('1', '4')`;
const RENEWAL_CONFIRMED_SQL = `${RENEWAL_STATUS_CODE} = '2'`;
const RENEWAL_LOST_SQL = `${RENEWAL_STATUS_CODE} = '3'`;
const RENEWAL_PENDING_SQL = `(${RENEWAL_STATUS_CODE} = '' OR ${RENEWAL_STATUS_CODE} NOT IN ('1', '2', '3', '4'))`;

/**
 * Shared NB + Renewal status buckets (same labels in Management UI).
 * Deal priority: Hot=1 · Active=2 · Warm=3 · Cold=4
 * Lifecycle: Ongoing = Status 1/2/5 (Draft/Negotiation/Emailed) · Won=3 · Lost=4
 * Linked renewals use quotation case Status/DealStatus; unlinked use BrmActionStatus.
 */
const NB_ONGOING_STATUS_SQL = `"Status" IN (1, 2, 5)`;
const NB_WON_STATUS_SQL = `"Status" = 3`;
const NB_LOST_STATUS_SQL = `"Status" = 4`;
const NB_HOT_SQL = `"DealStatus" = 1`;
const NB_ACTIVE_SQL = `"DealStatus" = 2`;
const NB_WARM_SQL = `"DealStatus" = 3`;
const NB_COLD_SQL = `"DealStatus" = 4`;

const RENEWAL_LINKED_JOIN = `
  LEFT JOIN public."HealthInsuranceQuotationCase" lqc
    ON lqc."ID" = b."LinkedQuotationCaseId"
   AND COALESCE(lqc."IsDeleted", false) = false`;

const RENEWAL_EFF_HOT_SQL = `(b."LinkedQuotationCaseId" IS NOT NULL AND lqc."DealStatus" = 1)`;
const RENEWAL_EFF_ACTIVE_SQL = `(b."LinkedQuotationCaseId" IS NOT NULL AND lqc."DealStatus" = 2)`;
const RENEWAL_EFF_WARM_SQL = `(b."LinkedQuotationCaseId" IS NOT NULL AND lqc."DealStatus" = 3)`;
const RENEWAL_EFF_COLD_SQL = `(b."LinkedQuotationCaseId" IS NOT NULL AND lqc."DealStatus" = 4)`;
const RENEWAL_EFF_ONGOING_SQL = `(
  (b."LinkedQuotationCaseId" IS NOT NULL AND lqc."Status" IN (1, 2, 5))
  OR (b."LinkedQuotationCaseId" IS NULL AND ${RENEWAL_STATUS_CODE} IN ('1', '4', '5', '6'))
)`;
const RENEWAL_EFF_WON_SQL = `(
  (b."LinkedQuotationCaseId" IS NOT NULL AND lqc."Status" = 3)
  OR (b."LinkedQuotationCaseId" IS NULL AND ${RENEWAL_CONFIRMED_SQL})
)`;
const RENEWAL_EFF_LOST_SQL = `(
  (b."LinkedQuotationCaseId" IS NOT NULL AND lqc."Status" = 4)
  OR (b."LinkedQuotationCaseId" IS NULL AND ${RENEWAL_LOST_SQL})
)`;
const RENEWAL_WON_PREMIUM_SQL = `COALESCE(SUM(
  CASE
    WHEN b."LinkedQuotationCaseId" IS NOT NULL AND lqc."Status" = 3
      THEN COALESCE(lqc."TargetPremium"::float, 0)
    WHEN b."LinkedQuotationCaseId" IS NULL AND ${RENEWAL_CONFIRMED_SQL}
      THEN COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)
    ELSE 0
  END
), 0)::float`;

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


/** Per-BRM case ownership — broker mapping, AssignedBrmExecutive (csv), or BRM self-created. */
const brmCaseOwnershipSql = (buAlias, qcAlias) => `
  (
    ${qcAlias}."CreatedByUserID" IN (
      SELECT u."ID"
      FROM public."UserBrokerMapping" ubm
      JOIN public."User" u ON u."CompanyID" = ubm."CompanyId"
      WHERE ubm."UserId" = ${buAlias}."Id"
    )
    OR (
      ${qcAlias}."AssignedBrmExecutive" IS NOT NULL
      AND TRIM(COALESCE(${qcAlias}."AssignedBrmExecutive"::text, '')) <> ''
      AND (
        TRIM(${qcAlias}."AssignedBrmExecutive"::text) = ${buAlias}."Id"::text
        OR ${buAlias}."Id"::text = ANY(
          string_to_array(REPLACE(COALESCE(${qcAlias}."AssignedBrmExecutive"::text, ''), ' ', ''), ',')
        )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public."User" creator
      WHERE creator."ID" = ${qcAlias}."CreatedByUserID"
        AND creator."AspNetUserID"::text = ${buAlias}."Id"::text
    )
  )
`;

/**
 * Per-BRM ranking — same ownership as BRM master_data.
 * Fast path: TargetPremium / ExpiringPremium only (no per-case member SUM, no MasterData lateral).
 */
async function getByExecutive({ dateFrom, dateTo, dealStatus } = {}) {
  const dates = optionalDates({ dateFrom, dateTo });
  const names = BRM_ROLE_NAMES;
  const params = [...names];
  let openExtra = "";
  let bookedExtra = "";
  // Renewals: do NOT date-filter by EffectiveDate — Distributed portfolio is assign-based
  // (same as BRM my_renewal). Month filters apply to NB CreateDate only.
  if (dates.dateFrom) {
    params.push(dates.dateFrom);
    openExtra += ` AND qc."CreateDate"::date >= $${params.length}::date`;
    bookedExtra += ` AND qc."CreateDate"::date >= $${params.length}::date`;
  }
  if (dates.dateTo) {
    params.push(dates.dateTo);
    openExtra += ` AND qc."CreateDate"::date <= $${params.length}::date`;
    bookedExtra += ` AND qc."CreateDate"::date <= $${params.length}::date`;
  }
  if (dealStatus != null && dealStatus !== "" && dealStatus !== "all") {
    params.push(parseInt(dealStatus, 10));
    openExtra += ` AND qc."DealStatus" = $${params.length}`;
    bookedExtra += ` AND qc."DealStatus" = $${params.length}`;
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
      JOIN public."HealthInsuranceQuotationCase" qc ON ${brmCaseOwnershipSql("bu", "qc")}
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS false
        ${openExtra}
      ORDER BY bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
    ),
    booked_latest AS (
      SELECT DISTINCT ON (bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
        bu."Id" AS executive_id,
        qc."ID" AS case_id,
        COALESCE(qc."TargetPremium", 0)::float AS target_premium
      FROM brm_users bu
      JOIN public."HealthInsuranceQuotationCase" qc ON ${brmCaseOwnershipSql("bu", "qc")}
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS true
        ${bookedExtra}
      ORDER BY bu."Id", REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
    ),
    open_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "newCaseTotal",
        COUNT(*) FILTER (WHERE ${NB_HOT_SQL})::int AS "hotCases",
        COUNT(*) FILTER (WHERE ${NB_ACTIVE_SQL})::int AS "activeCases",
        COUNT(*) FILTER (WHERE ${NB_WARM_SQL})::int AS "warmCases",
        COUNT(*) FILTER (WHERE ${NB_COLD_SQL})::int AS "coldCases",
        COUNT(*) FILTER (WHERE ${NB_ONGOING_STATUS_SQL})::int AS "ongoingCases",
        COUNT(*) FILTER (WHERE ${NB_WON_STATUS_SQL})::int AS "wonCases",
        COUNT(*) FILTER (WHERE ${NB_LOST_STATUS_SQL})::int AS "lostCases",
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
      SELECT
        bu."Id" AS executive_id,
        COUNT(*)::int AS "renewalCaseTotal",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_HOT_SQL})::int AS "renewalHot",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_ACTIVE_SQL})::int AS "renewalActive",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_WARM_SQL})::int AS "renewalWarm",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_COLD_SQL})::int AS "renewalCold",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_ONGOING_SQL})::int AS "renewalOngoing",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_WON_SQL})::int AS "renewalConfirmed",
        COUNT(*) FILTER (WHERE ${RENEWAL_EFF_LOST_SQL})::int AS "renewalLost",
        COUNT(*) FILTER (WHERE ${RENEWAL_PENDING_SQL} AND b."LinkedQuotationCaseId" IS NULL)::int AS "renewalPending",
        COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "renewalPremium",
        ${RENEWAL_WON_PREMIUM_SQL} AS "renewalWonPremium"
      FROM brm_users bu
      JOIN public."BrmRenewalData" b ON bu."Id" = ANY(b."BrmUserIds")
      ${RENEWAL_LINKED_JOIN}
      WHERE ${renewalBatchScopeSql(false)}
        AND ${RENEWAL_GROUP_ONLY_SQL}
      GROUP BY bu."Id"
    )
    SELECT
      bu."Id" AS "executiveId",
      bu."executiveName",
      bu.role,
      COALESCE(o."newCaseTotal", 0)::int AS "newCaseTotal",
      COALESCE(r."renewalCaseTotal", 0)::int AS "renewalCaseTotal",
      COALESCE(r."renewalHot", 0)::int AS "renewalHot",
      COALESCE(r."renewalActive", 0)::int AS "renewalActive",
      COALESCE(r."renewalWarm", 0)::int AS "renewalWarm",
      COALESCE(r."renewalCold", 0)::int AS "renewalCold",
      COALESCE(r."renewalOngoing", 0)::int AS "renewalOngoing",
      COALESCE(r."renewalConfirmed", 0)::int AS "renewalConfirmed",
      COALESCE(r."renewalLost", 0)::int AS "renewalLost",
      COALESCE(r."renewalPending", 0)::int AS "renewalPending",
      COALESCE(bk."bookedCaseTotal", 0)::int AS "bookedCaseTotal",
      (COALESCE(o."newCaseTotal", 0) + COALESCE(r."renewalCaseTotal", 0) + COALESCE(bk."bookedCaseTotal", 0))::int AS "brmTotal",
      COALESCE(o."newCaseTotal", 0)::int AS "totalCases",
      COALESCE(bk."bookedCaseTotal", 0)::int AS "bookedCases",
      COALESCE(o."newCaseTotal", 0)::int AS "openCases",
      COALESCE(o."activeCases", 0)::int AS "activeCases",
      COALESCE(o."hotCases", 0)::int AS "hotCases",
      COALESCE(o."warmCases", 0)::int AS "warmCases",
      COALESCE(o."coldCases", 0)::int AS "coldCases",
      COALESCE(o."ongoingCases", 0)::int AS "ongoingCases",
      COALESCE(o."wonCases", 0)::int AS "wonCases",
      COALESCE(o."lostCases", 0)::int AS "lostCases",
      COALESCE(o."openPremium", 0)::float AS "totalGrossPremium",
      COALESCE(o."openPremium", 0)::float AS "newBusinessPremium",
      COALESCE(bk."bookedPremium", 0)::float AS "bookedPremium",
      COALESCE(r."renewalPremium", 0)::float AS "renewalPremium",
      COALESCE(r."renewalWonPremium", 0)::float AS "renewalWonPremium",
      (COALESCE(bk."bookedPremium", 0) + COALESCE(r."renewalWonPremium", 0))::float AS "winCasePremium",
      (COALESCE(o."openPremium", 0) + COALESCE(r."renewalPremium", 0) + COALESCE(bk."bookedPremium", 0))::float AS "totalPremium",
      CASE
        WHEN COALESCE(o."newCaseTotal", 0) > 0
        THEN (COALESCE(o."openPremium", 0) / o."newCaseTotal")::float
        ELSE 0::float
      END AS "avgCasePremium"
    FROM brm_users bu
    LEFT JOIN open_agg o ON o.executive_id = bu."Id"
    LEFT JOIN booked_agg bk ON bk.executive_id = bu."Id"
    LEFT JOIN renewal_agg r ON r.executive_id = bu."Id"
    ORDER BY "brmTotal" DESC NULLS LAST, bu."executiveName" ASC
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
      acc.newBusinessPremium += toNumber(r.newBusinessPremium);
      acc.bookedPremium += toNumber(r.bookedPremium);
      acc.renewalPremium += toNumber(r.renewalPremium);
      acc.renewalWonPremium += toNumber(r.renewalWonPremium);
      acc.winCasePremium += toNumber(r.winCasePremium);
      acc.totalPremium += toNumber(r.totalPremium);
      return acc;
    },
    {
      totalCases: 0,
      newCaseTotal: 0,
      renewalCaseTotal: 0,
      bookedCaseTotal: 0,
      brmTotal: 0,
      totalGrossPremium: 0,
      newBusinessPremium: 0,
      bookedPremium: 0,
      renewalPremium: 0,
      renewalWonPremium: 0,
      winCasePremium: 0,
      totalPremium: 0,
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
  // Only clamp when the client actually sent dates. Empty = All time (no fabricated window).
  const hasClientDates = Boolean(
    (dateFrom && String(dateFrom).trim()) || (dateTo && String(dateTo).trim()),
  );
  const clamped = hasClientDates
    ? clampDateSpan({ dateFrom, dateTo }, 366)
    : { dateFrom: null, dateTo: null };
  const opt = optionalDates(clamped);
  const trendDates = withDefaultDates(hasClientDates ? clamped : {});
  const hasExec = executiveId && executiveId !== "all";
  const hasDeal =
    dealStatus != null && dealStatus !== "" && String(dealStatus) !== "all";
  const dealVal = hasDeal ? parseInt(dealStatus, 10) : null;

  const cacheKey =
    `mgmt:brm:overview:v3:` +
    `${hasExec ? executiveId : "all"}:` +
    `${hasDeal ? dealStatus : "all"}:` +
    `${period}:` +
    `${opt.dateFrom || "all"}:${opt.dateTo || "all"}`;
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
        SELECT qc."ID", qc."DealStatus", qc."Status", qc."TargetPremium", qc."DisplayID"
        FROM public."HealthInsuranceQuotationCase" qc
        WHERE ${MASTER_DATA_CASE_FILTER}
        ${dateSql}
        ${dealParam}
      ),
      latest AS (
        SELECT DISTINCT ON (REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''))
          s."ID", s."DealStatus", s."Status", s."TargetPremium"
        FROM scoped s
        ORDER BY REGEXP_REPLACE(s."DisplayID", '-V[0-9]+$', ''), s."ID" DESC
      )
      SELECT
        COUNT(*)::int AS "openCount",
        0::int AS "bookedCount",
        COUNT(*) FILTER (WHERE ${NB_HOT_SQL})::int AS "hotCount",
        COUNT(*) FILTER (WHERE ${NB_ACTIVE_SQL})::int AS "activeCount",
        COUNT(*) FILTER (WHERE ${NB_WARM_SQL})::int AS "warmCount",
        COUNT(*) FILTER (WHERE ${NB_COLD_SQL})::int AS "coldCount",
        COUNT(*) FILTER (WHERE ${NB_ONGOING_STATUS_SQL})::int AS "ongoingCount",
        COUNT(*) FILTER (WHERE ${NB_WON_STATUS_SQL})::int AS "wonCount",
        COUNT(*) FILTER (WHERE ${NB_LOST_STATUS_SQL})::int AS "lostCount",
        COUNT(*)::int AS "totalCount",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "totalGrossPremium",
        0::float AS "bookedPremium",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "openPremium"
      FROM latest
    `;
  } else {
    // Company-wide open B/D cases. Dates optional — empty = no date limit (Reset → All).
    const dateConds = [
      `qc."DisplayID" ~ '-[BD][0-9]+'`,
      `qc."BookingStatus" IS false`,
    ];
    if (opt.dateFrom) {
      pipelineParams.push(opt.dateFrom);
      dateConds.push(`qc."CreateDate"::date >= $${pipelineParams.length}::date`);
    }
    if (opt.dateTo) {
      pipelineParams.push(opt.dateTo);
      dateConds.push(`qc."CreateDate"::date <= $${pipelineParams.length}::date`);
    }
    if (hasDeal) {
      pipelineParams.push(dealVal);
      dateConds.push(`qc."DealStatus" = $${pipelineParams.length}`);
    }
    pipelineSql = `
      WITH scoped AS (
        SELECT
          qc."ID",
          qc."DealStatus",
          qc."Status",
          qc."TargetPremium",
          qc."DisplayID",
          REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,
          CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\1'), qc."DisplayID") AS INT) AS version_num
        FROM public."HealthInsuranceQuotationCase" qc
        WHERE ${dateConds.join(" AND ")}
      ),
      latest AS (
        SELECT DISTINCT ON (base_display_id)
          "ID", "DealStatus", "Status", "TargetPremium"
        FROM scoped
        ORDER BY base_display_id, version_num DESC NULLS LAST
      )
      SELECT
        COUNT(*)::int AS "openCount",
        0::int AS "bookedCount",
        COUNT(*) FILTER (WHERE ${NB_HOT_SQL})::int AS "hotCount",
        COUNT(*) FILTER (WHERE ${NB_ACTIVE_SQL})::int AS "activeCount",
        COUNT(*) FILTER (WHERE ${NB_WARM_SQL})::int AS "warmCount",
        COUNT(*) FILTER (WHERE ${NB_COLD_SQL})::int AS "coldCount",
        COUNT(*) FILTER (WHERE ${NB_ONGOING_STATUS_SQL})::int AS "ongoingCount",
        COUNT(*) FILTER (WHERE ${NB_WON_STATUS_SQL})::int AS "wonCount",
        COUNT(*) FILTER (WHERE ${NB_LOST_STATUS_SQL})::int AS "lostCount",
        COUNT(*)::int AS "totalCount",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "totalGrossPremium",
        0::float AS "bookedPremium",
        COALESCE(SUM(COALESCE("TargetPremium", 0)), 0)::float AS "openPremium"
      FROM latest
    `;
  }

  const bookedFrom = opt.dateFrom || trendDates.dateFrom;
  const bookedTo = opt.dateTo || trendDates.dateTo;
  const bookedParams = [bookedFrom, bookedTo];

  // Renewals = BRM my_renewal parity (no EffectiveDate clamp — that zeroed the portfolio).
  // All: Distributed + Draft-unassigned, Group only. One BRM: Distributed + assigned.
  const renewalParams = hasExec ? [executiveId] : [];
  const renewalWhere = hasExec
    ? `WHERE ${renewalBatchScopeSql(false)} AND ${RENEWAL_GROUP_ONLY_SQL} AND $1::text = ANY(b."BrmUserIds")`
    : `WHERE ${renewalBatchScopeSql(true)} AND ${RENEWAL_GROUP_ONLY_SQL}`;

  const [byExecutive, trends, pipeline, renewalRows, bookedRows] = await Promise.all([
    getByExecutive({
      dateFrom: opt.dateFrom || undefined,
      dateTo: opt.dateTo || undefined,
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
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_HOT_SQL})::int AS hot,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_ACTIVE_SQL})::int AS active,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_WARM_SQL})::int AS warm,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_COLD_SQL})::int AS cold,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_ONGOING_SQL})::int AS ongoing,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_WON_SQL})::int AS confirmed,
              COUNT(*) FILTER (WHERE ${RENEWAL_EFF_LOST_SQL})::int AS lost,
              COUNT(*) FILTER (WHERE ${RENEWAL_PENDING_SQL} AND b."LinkedQuotationCaseId" IS NULL)::int AS pending,
              COALESCE(SUM(COALESCE(NULLIF(b."ExpiringPremium"::float, 0), 0)), 0)::float AS "totalExpiringPremium",
              ${RENEWAL_WON_PREMIUM_SQL} AS "wonPremium"
       FROM public."BrmRenewalData" b
       ${RENEWAL_LINKED_JOIN}
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
  const execTotals = byExecutive.totals || {};
  const topBrms = [...byExecutive.executives]
    .sort((a, b) => toNumber(b.brmTotal) - toNumber(a.brmTotal))
    .filter((e) => toNumber(e.brmTotal) > 0)
    .slice(0, 8);

  const pipelineHealth = {
    open: toNumber(p.openCount),
    hot: toNumber(p.hotCount),
    active: toNumber(p.activeCount),
    warm: toNumber(p.warmCount),
    cold: toNumber(p.coldCount),
    ongoing: toNumber(p.ongoingCount),
    won: toNumber(p.wonCount),
    lost: toNumber(p.lostCount),
    other: Math.max(
      0,
      toNumber(p.totalCount) -
        toNumber(p.hotCount) -
        toNumber(p.activeCount) -
        toNumber(p.warmCount) -
        toNumber(p.coldCount) -
        toNumber(p.wonCount) -
        toNumber(p.lostCount),
    ),
    total: toNumber(p.totalCount),
    openPremium: toNumber(p.openPremium),
  };

  const renewalHealth = {
    total: toNumber(renewalSnap.total),
    hot: toNumber(renewalSnap.hot),
    active: toNumber(renewalSnap.active),
    warm: toNumber(renewalSnap.warm),
    cold: toNumber(renewalSnap.cold),
    ongoing: toNumber(renewalSnap.ongoing),
    confirmed: toNumber(renewalSnap.confirmed),
    won: toNumber(renewalSnap.confirmed),
    lost: toNumber(renewalSnap.lost),
    pending: toNumber(renewalSnap.pending),
    expiringPremium: toNumber(renewalSnap.totalExpiringPremium),
    wonPremium: toNumber(renewalSnap.wonPremium),
  };

  const winCasePremium = bookedPremium + renewalHealth.wonPremium;

  const cards = {
    achievedTotal: bookedPremium,
    AchievedBookedConfirmedNewPremium: bookedPremium,
    AchievedBookedConfirmedRenewalPremium: renewalHealth.expiringPremium,
    totalPremium: toNumber(p.totalGrossPremium) + renewalHealth.expiringPremium + bookedPremium,
    openPremium: toNumber(p.openPremium),
    bookedPremium,
    bookedCount,
    winCasePremium,
    forecastTotal: bookedPremium + toNumber(p.openPremium) * 0.6,
    nbCount: toNumber(p.totalCount),
    nbHot: toNumber(p.hotCount),
    nbActive: toNumber(p.activeCount),
    nbWarm: toNumber(p.warmCount),
    nbCold: toNumber(p.coldCount),
    nbOngoing: toNumber(p.ongoingCount),
    nbWon: toNumber(p.wonCount),
    nbLost: toNumber(p.lostCount),
    renCount: renewalHealth.total,
    renHot: renewalHealth.hot,
    renActive: renewalHealth.active,
    renWarm: renewalHealth.warm,
    renCold: renewalHealth.cold,
    renOngoing: renewalHealth.ongoing,
    renConfirmed: renewalHealth.confirmed,
    renWon: renewalHealth.won,
    renLost: renewalHealth.lost,
    renPending: renewalHealth.pending,
    renExpiringPremium: renewalHealth.expiringPremium,
    renWonPremium: renewalHealth.wonPremium,
    endCount: 0,
    openPipelineCount: toNumber(p.openCount),
    brmCount: byExecutive.executives.length,
    dateFrom: opt.dateFrom || trendDates.dateFrom,
    dateTo: opt.dateTo || trendDates.dateTo,
  };

  const insights = [];
  insights.push({
    type: "pipeline",
    title: "New business pipeline",
    detail: `${pipelineHealth.total} open · Hot ${pipelineHealth.hot} · Active ${pipelineHealth.active} · Cold ${pipelineHealth.cold} · Ongoing ${pipelineHealth.ongoing} · Won ${pipelineHealth.won} · Lost ${pipelineHealth.lost}`,
  });
  insights.push({
    type: "renewal",
    title: "Renewal portfolio",
    detail: `${renewalHealth.total} groups · Hot ${renewalHealth.hot} · Active ${renewalHealth.active} · Cold ${renewalHealth.cold} · Ongoing ${renewalHealth.ongoing} · Won ${renewalHealth.won} · Lost ${renewalHealth.lost}`,
  });
  if (topBrms[0]) {
    insights.push({
      type: "load",
      title: "Highest case load",
      detail: `${topBrms[0].executiveName} · ${formatInt(topBrms[0].brmTotal)} total (NB ${formatInt(topBrms[0].newCaseTotal)} · RN ${formatInt(topBrms[0].renewalCaseTotal)})`,
    });
  }
  const lowWin = [...byExecutive.executives]
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
    renewalHealth,
    byExecutive: topBrms,
    byExecutiveFull: byExecutive.executives,
    byExecutiveTotals: {
      ...execTotals,
      renewalHot: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalHot), 0),
      renewalActive: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalActive), 0),
      renewalWarm: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalWarm), 0),
      renewalCold: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalCold), 0),
      renewalOngoing: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalOngoing), 0),
      renewalConfirmed: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalConfirmed), 0),
      renewalLost: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalLost), 0),
      renewalPending: byExecutive.executives.reduce((s, e) => s + toNumber(e.renewalPending), 0),
      hotCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.hotCases), 0),
      activeCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.activeCases), 0),
      warmCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.warmCases), 0),
      coldCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.coldCases), 0),
      ongoingCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.ongoingCases), 0),
      wonCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.wonCases), 0),
      lostCases: byExecutive.executives.reduce((s, e) => s + toNumber(e.lostCases), 0),
    },
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

/**
 * FSD lost-reason mix — Status=4 (Lost) on quotation cases (latest version per DisplayID).
 */
async function getLostReasonMix({ dateFrom, dateTo, brmName } = {}) {
  const dates = withDefaultDates({ dateFrom, dateTo });
  const params = [dates.dateFrom, dates.dateTo];
  const brmNames = parseBrmNames(brmName);
  const brmIds = brmNames.length ? await resolveAspNetIdsByNames(brmNames) : [];

  let assignFilter = "";
  if (brmIds.length) {
    params.push(brmIds);
    assignFilter = ` AND ${assignedBrmContainsSql('qc."AssignedBrmExecutive"', params.length)}`;
  } else if (brmNames.length) {
    assignFilter = " AND FALSE";
  }

  try {
    const rows = await query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(qc."LostReasonCode"), ''), 'unspecified') AS "reasonCode",
        COUNT(*)::int AS "count"
      FROM (
        SELECT DISTINCT ON (REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''))
          qc."LostReasonCode",
          qc."Status",
          qc."LastUpdateDate",
          qc."AssignedBrmExecutive"
        FROM public."HealthInsuranceQuotationCase" qc
        WHERE COALESCE(qc."Status"::int, 0) = 4
          AND (
            qc."LastUpdateDate"::date BETWEEN $1::date AND $2::date
            OR qc."CreateDate"::date BETWEEN $1::date AND $2::date
          )
          ${assignFilter}
        ORDER BY REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', ''), qc."ID" DESC
      ) qc
      GROUP BY 1
      ORDER BY "count" DESC
      `,
      params,
    );

    const total = rows.reduce((s, r) => s + toNumber(r.count), 0);
    return {
      dateFrom: dates.dateFrom,
      dateTo: dates.dateTo,
      total,
      mix: rows.map((r) => ({
        reasonCode: String(r.reasonCode || "unspecified"),
        count: toNumber(r.count),
        pct: total ? Math.round((toNumber(r.count) / total) * 100) : 0,
      })),
    };
  } catch (err) {
    console.warn(
      "[brmInsights.getLostReasonMix]",
      err?.message || err,
      "(run add_lost_reason_and_followup.sql if LostReasonCode missing)",
    );
    return {
      dateFrom: dates.dateFrom,
      dateTo: dates.dateTo,
      total: 0,
      mix: [],
    };
  }
}

function formatInt(n) {
  return toNumber(n).toLocaleString();
}

/**
 * Light broker→member drilldown for a quotation case (by DisplayID or numeric ID).
 */
async function getCaseMemberDrilldown(caseKey) {
  const key = String(caseKey || "").trim();
  if (!key) return { caseId: null, displayId: null, memberCount: 0, totalGrossPremium: 0, members: [] };

  const caseRows = await query(
    `
    SELECT qc."ID", qc."DisplayID", qc."BrokerCompanyName", qc."BrokerEmail",
           c."Name" AS "client_name",
           ${quotationMemberGpSql('qc."ID"')}::float AS "total_gp",
           (
             SELECT COUNT(*)::int FROM (
               SELECT DISTINCT ON (TRIM(COALESCE(qm."Name", '')), qm."DateofBirth") 1
               FROM public."HealthInsuranceQuotationMember" qm
               WHERE qm."HealthInsuranceQuotationCaseID" = qc."ID"
                 AND COALESCE(qm."IsDeleted", false) = false
                 AND COALESCE(qm."IsArchived", false) = false
               ORDER BY TRIM(COALESCE(qm."Name", '')), qm."DateofBirth", qm."ID" DESC
             ) t
           ) AS "member_count"
    FROM public."HealthInsuranceQuotationCase" qc
    LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"
    WHERE qc."DisplayID" = $1 OR qc."ID"::text = $1
    ORDER BY qc."ID" DESC
    LIMIT 1
    `,
    [key],
  );
  const cse = caseRows[0];
  if (!cse) {
    return { caseId: null, displayId: key, memberCount: 0, totalGrossPremium: 0, members: [] };
  }

  const members = await query(
    `
    SELECT DISTINCT ON (TRIM(COALESCE(qm."Name", '')), qm."DateofBirth")
      qm."ID",
      qm."Name",
      TO_CHAR(qm."DateofBirth", 'DD-MM-YYYY') AS "dob",
      qm."Gender",
      qm."Relation",
      COALESCE(qm."BaseAmount", qm."PlanAmount", qm."TotalAmount", 0)::float AS "gross_premium",
      qm."Email",
      qm."Mobile"
    FROM public."HealthInsuranceQuotationMember" qm
    WHERE qm."HealthInsuranceQuotationCaseID" = $1
      AND COALESCE(qm."IsDeleted", false) = false
      AND COALESCE(qm."IsArchived", false) = false
    ORDER BY TRIM(COALESCE(qm."Name", '')), qm."DateofBirth", qm."ID" DESC
    LIMIT 500
    `,
    [cse.ID],
  );

  return {
    caseId: cse.ID,
    displayId: cse.DisplayID,
    clientName: cse.client_name,
    brokerCompany: cse.BrokerCompanyName,
    brokerEmail: cse.BrokerEmail,
    memberCount: toNumber(cse.member_count),
    totalGrossPremium: toNumber(cse.total_gp),
    members,
  };
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
  getLostReasonMix,
  getCaseMemberDrilldown,
};
