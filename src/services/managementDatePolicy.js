/**
 * Shared date-field policy for Management executive dashboard.
 * NB / Ops / Booking / AML → PolicyEffectiveDate
 * Renewal → MAX(MasterDataLayer.PolicyExpiryDate) per group
 * Medical → CreatedAt (handled in medicalInsights)
 */

function policyStartConds(alias, dateFrom, dateTo, params) {
  const a = alias || "qc";
  const out = [];
  if (dateFrom) {
    params.push(dateFrom);
    out.push(`${a}."PolicyEffectiveDate"::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    out.push(`${a}."PolicyEffectiveDate"::date <= $${params.length}::date`);
  }
  return out;
}

/** EXISTS: case has KYC doc sent to AML (Operations AML definition). */
function amlSentToSql(alias = "qc") {
  return `EXISTS (
    SELECT 1
    FROM public."HealthInsuranceQuotationDocument" d
    WHERE (
        d."DisplayID" = ${alias}."DisplayID"
        OR d."HealthInsuranceQuotationCaseID" = ${alias}."ID"
      )
      AND COALESCE(d."IsArchived", false) = false
      AND COALESCE(d."SentToAML", false) = true
      AND (
        LOWER(COALESCE(d."DocumentScope"::text, '')) = 'kyc'
        OR LOWER(COALESCE(d."DocumentScope"::text, '')) LIKE '%kyc%'
      )
  )`;
}

/**
 * Lateral join for renewal expiry (same as BRM getRenewals).
 * Alias: mp.expiry_date
 */
const RENEWAL_MASTER_DATA_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      MAX(m."PolicyExpiryDate") FILTER (
        WHERE m."PolicyExpiryDate" IS NOT NULL
          AND m."PolicyExpiryDate" != 'infinity'::date
      ) AS expiry_date
    FROM public."MasterDataLayer" m
    WHERE (
      (
        m."EndorsementTypeCode" = '02'
        AND m."TechnicalSheetNumber"::text = ANY(
          ARRAY(
            SELECT TRIM(val)
            FROM unnest(string_to_array(REPLACE(COALESCE(b."PolicyList", ''), ' ', ''), ',')) AS val
            WHERE TRIM(val) <> ''
          )
        )
      )
      OR (
        NULLIF(TRIM(COALESCE(b."PolicyGroupCode"::text, '')), '') IS NOT NULL
        AND m."PolicyGroupCode"::text = TRIM(b."PolicyGroupCode"::text)
      )
    )
  ) mp ON TRUE
`;

function renewalExpiryConds(dateFrom, dateTo, params, expiryAlias = "mp.expiry_date") {
  const out = [];
  if (dateFrom) {
    params.push(dateFrom);
    out.push(`${expiryAlias} >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    out.push(`${expiryAlias} <= $${params.length}::date`);
  }
  return out;
}

function clampDateSpan({ dateFrom, dateTo } = {}, maxDays = 366) {
  const iso = (d) => d.toISOString().slice(0, 10);
  let from = dateFrom && String(dateFrom).trim() ? new Date(String(dateFrom).trim()) : null;
  let to = dateTo && String(dateTo).trim() ? new Date(String(dateTo).trim()) : null;
  if (!from && !to) return { dateFrom: null, dateTo: null };
  if (!from && to) from = new Date(to);
  if (from && !to) to = new Date(from);
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  const span = (to - from) / (24 * 60 * 60 * 1000);
  if (span > maxDays) {
    from = new Date(to);
    from.setDate(from.getDate() - maxDays);
  }
  return { dateFrom: iso(from), dateTo: iso(to) };
}

const DATE_POLICY_META = {
  nb: { field: "PolicyEffectiveDate", label: "Policy start date" },
  ops: { field: "PolicyEffectiveDate", label: "Policy start date" },
  booking: { field: "PolicyEffectiveDate", label: "Policy start date" },
  aml: { field: "PolicyEffectiveDate", label: "Policy start date" },
  renewal: { field: "PolicyExpiryDate", label: "Policy expiry date" },
  medical: { field: "CreatedAt", label: "Case created date" },
  hr: { field: "LeaveRequestDate", label: "Leave request date" },
};

module.exports = {
  policyStartConds,
  amlSentToSql,
  RENEWAL_MASTER_DATA_LATERAL,
  renewalExpiryConds,
  clampDateSpan,
  DATE_POLICY_META,
};
