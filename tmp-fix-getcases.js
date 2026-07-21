const fs = require("fs");
const p =
  "c:/Users/User/Desktop/MaxhealtCRMUAT/Maxhealth-Management-Panel-NodeApi/src/services/brmInsights.service.js";
let s = fs.readFileSync(p, "utf8");

const startMarker = "  // Scoped to one BRM";
const endMarker =
  "/**\r\n * Per-BRM ranking — same ownership as BRM master_data (no forced date unless passed).";

const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker);
if (start < 0 || end < 0) {
  console.error("markers not found", { start, end });
  process.exit(1);
}

// Build replacement as LF then convert to CRLF
function L(strings, ...vals) {
  // plain tagged template — no interpolation escaping needed; we write ${ as ${
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += vals[i] + strings[i + 1];
  return out;
}

// Use String.raw-style: write file content via array join to avoid template issues
const lines = [];
const push = (...a) => lines.push(...a);

push(
  `  // Scoped to one BRM — parity with BRM caseDetailsList (own)`,
  `  if (hasExec) {`,
  `    const filterParams = [...params];`,
  `    params.push(parsedLimit);`,
  `    const limitIdx = params.length;`,
  `    params.push(parsedOffset);`,
  `    const offsetIdx = params.length;`,
  ``,
  `    const [aggRows, caseRows] = await Promise.all([`,
  `      query(`,
  `        \``,
  `        WITH \${brokerUsersCteSql("$1")},`,
  `        scoped AS (`,
  `          SELECT`,
  `            qc."ID",`,
  `            qc."DealStatus",`,
  `            qc."Status",`,
  `            qc."DisplayID",`,
  `            REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,`,
  `            CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\\\1'), qc."DisplayID") AS INT) AS version_num`,
  `          FROM public."HealthInsuranceQuotationCase" qc`,
  `          LEFT JOIN public."User" u ON qc."CreatedByUserID" = u."ID"`,
  `          LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"`,
  `          WHERE \${MASTER_DATA_CASE_FILTER}`,
  `          \${extraSql}`,
  `        ),`,
  `        latest AS (`,
  `          SELECT DISTINCT ON (base_display_id)`,
  `            "ID", "DealStatus", "Status"`,
  `          FROM scoped`,
  `          ORDER BY base_display_id, version_num DESC NULLS LAST`,
  `        )`,
  `        SELECT`,
  `          COUNT(*)::int AS "totalCount",`,
  `          COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",`,
  `          COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",`,
  `          COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCount",`,
  `          COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCount",`,
  `          COALESCE(SUM(\${memberGpSumSql('"ID"')}), 0)::float AS "totalGrossPremium"`,
  `        FROM latest`,
  `        \`,`,
  `        filterParams,`,
  `      ),`,
  `      query(`,
  `        \``,
  `        WITH \${brokerUsersCteSql("$1")},`,
  `        scoped AS (`,
  `          SELECT`,
  `            qc."ID",`,
  `            qc."DisplayID",`,
  `            qc."DealStatus",`,
  `            qc."Status",`,
  `            qc."TargetPremium",`,
  `            qc."HealthInsuranceFormulaID",`,
  `            qc."BrokerCompanyName",`,
  `            qc."BrokerEmail",`,
  `            qc."QuotationPreparedBy",`,
  `            qc."AssignedBrmExecutive",`,
  `            qc."ReferenceNumber",`,
  `            qc."Insurer",`,
  `            qc."PolicyEffectiveDate",`,
  `            qc."CreateDate",`,
  `            c."Name" AS "client_name",`,
  `            u."Name" AS "broker_name",`,
  `            CASE`,
  `              WHEN qc."DisplayID" ~* '-I[0-9]+' THEN 'Individual'`,
  `              ELSE 'Group'`,
  `            END AS "policy_type",`,
  `            (`,
  `              SELECT STRING_AGG(`,
  `                DISTINCT REGEXP_REPLACE(TRIM(cat."HealthInsurancePlanName"), '[^a-zA-Z0-9 _]+$', ''),`,
  `                ', '`,
  `              )`,
  `              FROM public."HealthInsuranceQuotationCategory" cat`,
  `              WHERE cat."HealthInsuranceQuotationCaseID" = qc."ID"`,
  `                AND TRIM(COALESCE(cat."HealthInsurancePlanName", '')) <> ''`,
  `            ) AS "category_plan_name",`,
  `            REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,`,
  `            CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\\\1'), qc."DisplayID") AS INT) AS version_num`,
  `          FROM public."HealthInsuranceQuotationCase" qc`,
  `          LEFT JOIN public."User" u ON qc."CreatedByUserID" = u."ID"`,
  `          LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"`,
  `          WHERE \${MASTER_DATA_CASE_FILTER}`,
  `          \${extraSql}`,
  `        ),`,
  `        latest AS (`,
  `          SELECT DISTINCT ON (base_display_id) *`,
  `          FROM scoped`,
  `          ORDER BY base_display_id, version_num DESC NULLS LAST`,
  `        )`,
  `        SELECT`,
  `          l."ID",`,
  `          l."DisplayID",`,
  `          l."DealStatus",`,
  `          l."Status" AS "case_status",`,
  `          l."TargetPremium",`,
  `          l."BrokerCompanyName",`,
  `          l."BrokerEmail",`,
  `          l."QuotationPreparedBy",`,
  `          l."AssignedBrmExecutive",`,
  `          l."ReferenceNumber",`,
  `          l."Insurer",`,
  `          l."policy_type",`,
  `          l."category_plan_name",`,
  `          TO_CHAR(l."PolicyEffectiveDate", 'DD-MM-YYYY') AS "PolicyEffectiveDate",`,
  `          TO_CHAR(l."CreateDate", 'DD-MM-YYYY') AS "CreateDate",`,
  `          l."client_name",`,
  `          l."broker_name",`,
  `          (SELECT COALESCE(NULLIF(TRIM(an."UserName"), ''), an."Email")`,
  `           FROM public."AspNetUsers" an WHERE an."Id" = $1 LIMIT 1) AS "brm_name",`,
  `          l."Status" AS "brm_status",`,
  `          brm."Priority" AS "brm_priority",`,
  `          brm."Potential" AS "brm_potential",`,
  `          brm."ConfirmStatus" AS "brm_confirm_status",`,
  `          \${quotationMemberGpSql('l."ID"')}::float AS "gross_premium",`,
  `          \${quotationMemberNetSql('l."ID"', 'l."HealthInsuranceFormulaID"')}::float AS "net_premium",`,
  `          (`,
  `            \${quotationMemberGpSql('l."ID"')} - COALESCE(l."TargetPremium", 0)`,
  `          )::float AS "difference"`,
  `        FROM latest l`,
  `        LEFT JOIN LATERAL (`,
  `          SELECT b."Priority", b."Potential", b."ConfirmStatus"`,
  `          FROM public."BrmCaseActionsUpdates" b`,
  `          WHERE b."CaseID" = l."ID"`,
  `          ORDER BY b."UpdatedAt" DESC NULLS LAST`,
  `          LIMIT 1`,
  `        ) brm ON TRUE`,
  `        ORDER BY l."ID" DESC`,
  `        LIMIT $\${limitIdx} OFFSET $\${offsetIdx}`,
  `        \`,`,
  `        params,`,
  `      ),`,
  `    ]);`,
  ``,
  `    const agg = aggRows[0] || {};`,
  `    return {`,
  `      cases: caseRows,`,
  `      totalCount: toNumber(agg.totalCount),`,
  `      activeCount: toNumber(agg.activeCount),`,
  `      hotCount: toNumber(agg.hotCount),`,
  `      wonCount: toNumber(agg.wonCount),`,
  `      lostCount: toNumber(agg.lostCount),`,
  `      totalGrossPremium: toNumber(agg.totalGrossPremium),`,
  `      limit: parsedLimit,`,
  `      offset: parsedOffset,`,
  `      ownership: "brm_master_data_parity",`,
  `      dateFrom: dates.dateFrom,`,
  `      dateTo: dates.dateTo,`,
  `    };`,
  `  }`,
  ``,
  `  // All BRMs — open B/D cases, latest version only`,
  `  params.length = 0;`,
  `  const allExtra = [`,
  `    \`qc."DisplayID" ~ '-[BD][0-9]+'\`,`,
  `    \`qc."BookingStatus" IS false\`,`,
  `  ];`,
  `  if (dates.dateFrom) {`,
  `    params.push(dates.dateFrom);`,
  `    allExtra.push(\`qc."CreateDate"::date >= $\${params.length}::date\`);`,
  `  }`,
  `  if (dates.dateTo) {`,
  `    params.push(dates.dateTo);`,
  `    allExtra.push(\`qc."CreateDate"::date <= $\${params.length}::date\`);`,
  `  }`,
  `  if (dealStatus != null && dealStatus !== "" && dealStatus !== "all") {`,
  `    params.push(parseInt(dealStatus, 10));`,
  `    allExtra.push(\`qc."DealStatus" = $\${params.length}\`);`,
  `  }`,
  `  if (search) {`,
  `    params.push(\`%\${search.trim()}%\`);`,
  `    const p = \`$\${params.length}\`;`,
  `    allExtra.push(`,
  `      \`(qc."DisplayID" ILIKE \${p} OR qc."BrokerCompanyName" ILIKE \${p} OR c."Name" ILIKE \${p})\`,`,
  `    );`,
  `  }`,
  `  const whereAll = allExtra.join(" AND ");`,
  `  const filterParamsAll = [...params];`,
  `  params.push(parsedLimit);`,
  `  const limitIdxAll = params.length;`,
  `  params.push(parsedOffset);`,
  `  const offsetIdxAll = params.length;`,
  ``,
  `  const [aggRowsAll, caseRowsAll] = await Promise.all([`,
  `    query(`,
  `      \``,
  `      WITH scoped AS (`,
  `        SELECT`,
  `          qc."ID",`,
  `          qc."DealStatus",`,
  `          qc."Status",`,
  `          qc."DisplayID",`,
  `          REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,`,
  `          CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\\\1'), qc."DisplayID") AS INT) AS version_num`,
  `        FROM public."HealthInsuranceQuotationCase" qc`,
  `        LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"`,
  `        WHERE \${whereAll}`,
  `      ),`,
  `      latest AS (`,
  `        SELECT DISTINCT ON (base_display_id)`,
  `          "ID", "DealStatus", "Status"`,
  `        FROM scoped`,
  `        ORDER BY base_display_id, version_num DESC NULLS LAST`,
  `      )`,
  `      SELECT`,
  `        COUNT(*)::int AS "totalCount",`,
  `        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCount",`,
  `        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCount",`,
  `        COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCount",`,
  `        COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCount",`,
  `        COALESCE(SUM(\${memberGpSumSql('"ID"')}), 0)::float AS "totalGrossPremium"`,
  `      FROM latest`,
  `      \`,`,
  `      filterParamsAll,`,
  `    ),`,
  `    query(`,
  `      \``,
  `      WITH scoped AS (`,
  `        SELECT`,
  `          qc."ID",`,
  `          qc."DisplayID",`,
  `          qc."DealStatus",`,
  `          qc."Status",`,
  `          qc."TargetPremium",`,
  `          qc."HealthInsuranceFormulaID",`,
  `          qc."BrokerCompanyName",`,
  `          qc."BrokerEmail",`,
  `          qc."QuotationPreparedBy",`,
  `          qc."AssignedBrmExecutive",`,
  `          qc."ReferenceNumber",`,
  `          qc."Insurer",`,
  `          qc."PolicyEffectiveDate",`,
  `          qc."CreateDate",`,
  `          c."Name" AS "client_name",`,
  `          CASE WHEN qc."DisplayID" ~* '-I[0-9]+' THEN 'Individual' ELSE 'Group' END AS "policy_type",`,
  `          (`,
  `            SELECT STRING_AGG(`,
  `              DISTINCT REGEXP_REPLACE(TRIM(cat."HealthInsurancePlanName"), '[^a-zA-Z0-9 _]+$', ''),`,
  `              ', '`,
  `            )`,
  `            FROM public."HealthInsuranceQuotationCategory" cat`,
  `            WHERE cat."HealthInsuranceQuotationCaseID" = qc."ID"`,
  `              AND TRIM(COALESCE(cat."HealthInsurancePlanName", '')) <> ''`,
  `          ) AS "category_plan_name",`,
  `          (`,
  `            SELECT COALESCE(NULLIF(TRIM(bru."UserName"), ''), bru."Email")`,
  `            FROM public."User" broker`,
  `            JOIN public."UserBrokerMapping" ubm ON ubm."CompanyId" = broker."CompanyID"`,
  `            JOIN public."AspNetUsers" bru ON bru."Id" = ubm."UserId"`,
  `            WHERE broker."ID" = qc."CreatedByUserID"`,
  `            LIMIT 1`,
  `          ) AS "brm_name",`,
  `          REGEXP_REPLACE(qc."DisplayID", '-V[0-9]+$', '') AS base_display_id,`,
  `          CAST(NULLIF(REGEXP_REPLACE(qc."DisplayID", '^.*-V([0-9]+)$', '\\\\1'), qc."DisplayID") AS INT) AS version_num`,
  `        FROM public."HealthInsuranceQuotationCase" qc`,
  `        LEFT JOIN public."Company" c ON qc."ClientID" = c."ID"`,
  `        WHERE \${whereAll}`,
  `      ),`,
  `      latest AS (`,
  `        SELECT DISTINCT ON (base_display_id) *`,
  `        FROM scoped`,
  `        ORDER BY base_display_id, version_num DESC NULLS LAST`,
  `      )`,
  `      SELECT`,
  `        l."ID",`,
  `        l."DisplayID",`,
  `        l."DealStatus",`,
  `        l."Status" AS "case_status",`,
  `        l."TargetPremium",`,
  `        l."BrokerCompanyName",`,
  `        l."BrokerEmail",`,
  `        l."QuotationPreparedBy",`,
  `        l."AssignedBrmExecutive",`,
  `        l."ReferenceNumber",`,
  `        l."Insurer",`,
  `        l."policy_type",`,
  `        l."category_plan_name",`,
  `        TO_CHAR(l."PolicyEffectiveDate", 'DD-MM-YYYY') AS "PolicyEffectiveDate",`,
  `        TO_CHAR(l."CreateDate", 'DD-MM-YYYY') AS "CreateDate",`,
  `        l."client_name",`,
  `        l."brm_name",`,
  `        l."Status" AS "brm_status",`,
  `        brm."Priority" AS "brm_priority",`,
  `        brm."Potential" AS "brm_potential",`,
  `        brm."ConfirmStatus" AS "brm_confirm_status",`,
  `        \${quotationMemberGpSql('l."ID"')}::float AS "gross_premium",`,
  `        \${quotationMemberNetSql('l."ID"', 'l."HealthInsuranceFormulaID"')}::float AS "net_premium",`,
  `        (`,
  `          \${quotationMemberGpSql('l."ID"')} - COALESCE(l."TargetPremium", 0)`,
  `        )::float AS "difference"`,
  `      FROM latest l`,
  `      LEFT JOIN LATERAL (`,
  `        SELECT b."Priority", b."Potential", b."ConfirmStatus"`,
  `        FROM public."BrmCaseActionsUpdates" b`,
  `        WHERE b."CaseID" = l."ID"`,
  `        ORDER BY b."UpdatedAt" DESC NULLS LAST`,
  `        LIMIT 1`,
  `      ) brm ON TRUE`,
  `      ORDER BY l."ID" DESC`,
  `      LIMIT $\${limitIdxAll} OFFSET $\${offsetIdxAll}`,
  `      \`,`,
  `      params,`,
  `    ),`,
  `  ]);`,
  ``,
  `  const aggAll = aggRowsAll[0] || {};`,
  `  return {`,
  `    cases: caseRowsAll,`,
  `    totalCount: toNumber(aggAll.totalCount),`,
  `    activeCount: toNumber(aggAll.activeCount),`,
  `    hotCount: toNumber(aggAll.hotCount),`,
  `    wonCount: toNumber(aggAll.wonCount),`,
  `    lostCount: toNumber(aggAll.lostCount),`,
  `    totalGrossPremium: toNumber(aggAll.totalGrossPremium),`,
  `    limit: parsedLimit,`,
  `    offset: parsedOffset,`,
  `    ownership: "all_open_bd_cases",`,
  `    dateFrom: dates.dateFrom,`,
  `    dateTo: dates.dateTo,`,
  `  };`,
  `}`,
  ``,
  ``,
);

// The push() strings above still have \${ which in normal JS strings (backtick) become ${...}
// Wait - I used template literals for each line! So \${ becomes ${ in each line. Good.
// And '\\\\1' becomes '\\1' in each line. Good.
// And $\${limitIdx} becomes $${limitIdx} - WAIT that's wrong!
// $\${limitIdx} in a template literal: $ + \${limitIdx} = $ + ${limitIdx} = $${limitIdx}
// In the service file we need: LIMIT ${limitIdx}  i.e. dollar-brace for JS interpolation of limitIdx into SQL
// Looking at original: `LIMIT $${limitIdx} OFFSET $${offsetIdx}`
// In the SOURCE of the service file, that's: LIMIT $ then ${limitIdx} which evaluates to LIMIT $5 etc.
// So the source characters should be: LIMIT $${limitIdx}
// In my push string as a template literal: `LIMIT $\${limitIdx}` 
// - \${limitIdx} → ${limitIdx}
// - result: LIMIT $${limitIdx}  CORRECT!

const replacement = lines.join("\r\n") + "\r\n";
s = s.slice(0, start) + replacement + s.slice(end);

// --- getByExecutive open_raw / open_agg / booked_agg ---
const oldBlockLf = `    open_raw AS (
      SELECT DISTINCT bu."Id" AS executive_id, qc."ID" AS case_id, qc."DealStatus", qc."TargetPremium", qc."DisplayID"
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS false
        \${openDateFilter}
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
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS true
        \${bookedDateFilter}
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
    ),`;

const newBlockLf = `    open_raw AS (
      SELECT DISTINCT bu."Id" AS executive_id, qc."ID" AS case_id, qc."DealStatus", qc."Status", qc."DisplayID"
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS false
        \${openDateFilter}
    ),
    open_latest AS (
      SELECT DISTINCT ON (executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''))
        executive_id, case_id, "DealStatus", "Status"
      FROM open_raw
      ORDER BY executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''), case_id DESC
    ),
    booked_raw AS (
      SELECT DISTINCT bu."Id" AS executive_id, qc."ID" AS case_id, qc."DisplayID"
      FROM brm_users bu
      JOIN public."UserBrokerMapping" ubm ON ubm."UserId" = bu."Id"
      JOIN public."User" broker ON broker."CompanyID" = ubm."CompanyId"
      JOIN public."HealthInsuranceQuotationCase" qc ON qc."CreatedByUserID" = broker."ID"
      WHERE qc."DisplayID" ~ '-[BD][0-9]+'
        AND qc."BookingStatus" IS true
        \${bookedDateFilter}
    ),
    booked_latest AS (
      SELECT DISTINCT ON (executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''))
        executive_id, case_id
      FROM booked_raw
      ORDER BY executive_id, REGEXP_REPLACE("DisplayID", '-V[0-9]+$', ''), case_id DESC
    ),
    open_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "newCaseTotal",
        COUNT(*) FILTER (WHERE "DealStatus" = 2)::int AS "activeCases",
        COUNT(*) FILTER (WHERE "DealStatus" = 1)::int AS "hotCases",
        COUNT(*) FILTER (WHERE "Status" = 3)::int AS "wonCases",
        COUNT(*) FILTER (WHERE "Status" = 4)::int AS "lostCases",
        COALESCE(SUM(\${memberGpSumSql("case_id")}), 0)::float AS "openPremium"
      FROM open_latest
      GROUP BY executive_id
    ),
    booked_agg AS (
      SELECT
        executive_id,
        COUNT(*)::int AS "bookedCaseTotal",
        COALESCE(SUM(\${memberGpSumSql("case_id")}), 0)::float AS "bookedPremium"
      FROM booked_latest
      GROUP BY executive_id
    ),`;

// Template literals above turn \${ into ${ — convert newlines to CRLF for matching
const oldBlock = oldBlockLf.replace(/\n/g, "\r\n");
const newBlock = newBlockLf.replace(/\n/g, "\r\n");

if (!s.includes(oldBlock)) {
  console.error("getByExecutive block not found");
  // debug: show nearby
  const i = s.indexOf("open_raw AS");
  console.error(JSON.stringify(s.slice(i, i + 120)));
  process.exit(1);
}
s = s.replace(oldBlock, newBlock);

fs.writeFileSync(p, s, "utf8");
console.log("OK patched");
const buf = fs.readFileSync(p);
console.log("CRLF preserved:", buf.includes(Buffer.from([13, 10])));

// sanity: Promise.all should have two query( calls in hasExec region
const g = s.slice(s.indexOf("parity with BRM caseDetailsList"), s.indexOf("Per-BRM ranking"));
const queryCount = (g.match(/query\(/g) || []).length;
console.log("query( calls in getCases body:", queryCount);
console.log("has Status = 3 won:", g.includes('FILTER (WHERE "Status" = 3)'));
console.log("has memberGpSumSql:", g.includes("memberGpSumSql"));
console.log("has case_status:", g.includes('"case_status"'));
console.log("getByExecutive Status won:", s.includes('FILTER (WHERE "Status" = 3)::int AS "wonCases"'));
