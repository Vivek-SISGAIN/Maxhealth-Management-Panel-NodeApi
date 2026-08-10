-- Indexes for Management Executive Overview (/management/executive).
-- Safe / additive — run once on the shared Postgres DB.
-- For production with zero downtime, prefer CREATE INDEX CONCURRENTLY (run outside a transaction).

-- NB / Ops cases: policy start date + status filters
CREATE INDEX IF NOT EXISTS idx_hiqc_policy_effective_date
  ON public."HealthInsuranceQuotationCase" ("PolicyEffectiveDate")
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_status_policy_date
  ON public."HealthInsuranceQuotationCase" ("Status", "PolicyEffectiveDate")
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_status_progress_booking
  ON public."HealthInsuranceQuotationCase" ("Status", "CaseProgressStatus", "BookingStatus")
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_display_id
  ON public."HealthInsuranceQuotationCase" ("DisplayID")
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

-- Latest-version dedup (base display id without -V suffix)
CREATE INDEX IF NOT EXISTS idx_hiqc_base_display_id
  ON public."HealthInsuranceQuotationCase" (
    (REGEXP_REPLACE(COALESCE("DisplayID", "ID"::text), '-V[0-9]+$', ''))
  )
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

-- AML sent-to (KYC docs) — speeds EXISTS in ops KPIs
CREATE INDEX IF NOT EXISTS idx_hiq_doc_kyc_sent_aml
  ON public."HealthInsuranceQuotationDocument" ("HealthInsuranceQuotationCaseID")
  WHERE COALESCE("IsArchived", false) = false
    AND "DocumentScope" = 'kyc'
    AND COALESCE("SentToAML", false) = true;

CREATE INDEX IF NOT EXISTS idx_hiq_doc_kyc_sent_aml_display
  ON public."HealthInsuranceQuotationDocument" ("DisplayID")
  WHERE COALESCE("IsArchived", false) = false
    AND "DocumentScope" = 'kyc'
    AND COALESCE("SentToAML", false) = true;

-- CPS net premium join
CREATE INDEX IF NOT EXISTS idx_cps_case_id
  ON public."CasePremiumSummary" ("CaseID");

-- Master production / renewal expiry
CREATE INDEX IF NOT EXISTS idx_mdl_policy_effective_new
  ON public."MasterDataLayer" ("PolicyEffectiveDate")
  WHERE UPPER(TRIM("NewOrRenewal")) = 'NEW';

CREATE INDEX IF NOT EXISTS idx_mdl_policy_expiry
  ON public."MasterDataLayer" ("PolicyExpiryDate")
  WHERE "PolicyExpiryDate" IS NOT NULL
    AND "PolicyExpiryDate" <> 'infinity'::date;

CREATE INDEX IF NOT EXISTS idx_mdl_pgc_endorsement_02
  ON public."MasterDataLayer" ("PolicyGroupCode", "PolicyExpiryDate")
  WHERE TRIM(COALESCE("EndorsementTypeCode"::text, '')) IN ('02', '2');

-- Medical executive trend buckets
CREATE INDEX IF NOT EXISTS idx_underwriting_case_created_at
  ON public."UnderwritingCase" ("CreatedAt");

CREATE INDEX IF NOT EXISTS idx_medical_task_uw_sla_created
  ON public."MedicalTask" ("TaskType", "SlaBreach", "CreatedAt")
  WHERE "TaskType" = 'UNDERWRITING';

-- Lost-reason mix (Status=4 + policy date)
CREATE INDEX IF NOT EXISTS idx_hiqc_status4_policy_date
  ON public."HealthInsuranceQuotationCase" ("PolicyEffectiveDate")
  WHERE COALESCE("Status"::int, 0) = 4
    AND COALESCE("IsDeleted", false) = false
    AND COALESCE("IsArchived", false) = false;

-- Executive renewal fast path (BrmRenewalData.EffectiveDate)
CREATE INDEX IF NOT EXISTS idx_brm_renewal_batch_effective
  ON public."BrmRenewalData" ("BatchStatus", "EffectiveDate")
  WHERE "PolicyGroupCode" NOT ILIKE 'IND%';
