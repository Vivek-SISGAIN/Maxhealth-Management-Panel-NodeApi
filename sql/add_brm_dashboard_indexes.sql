-- Indexes for BRM dashboard workbasket (master_data / my_renewal).
-- Additive — no data change. Prefer CONCURRENTLY on production (run outside a transaction).

CREATE INDEX IF NOT EXISTS idx_hiqc_list_active_id
  ON public."HealthInsuranceQuotationCase" ("ID" DESC)
  WHERE COALESCE("IsDeleted", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_created_by_active
  ON public."HealthInsuranceQuotationCase" ("CreatedByUserID")
  WHERE COALESCE("IsDeleted", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_booking_active
  ON public."HealthInsuranceQuotationCase" ("BookingStatus", "Status")
  WHERE COALESCE("IsDeleted", false) = false;

CREATE INDEX IF NOT EXISTS idx_hiqc_assigned_brm_active
  ON public."HealthInsuranceQuotationCase" ("AssignedBrmExecutive")
  WHERE COALESCE("IsDeleted", false) = false
    AND "AssignedBrmExecutive" IS NOT NULL
    AND TRIM(COALESCE("AssignedBrmExecutive"::text, '')) <> '';

CREATE INDEX IF NOT EXISTS idx_hiqc_last_update_status3
  ON public."HealthInsuranceQuotationCase" ("LastUpdateDate")
  WHERE COALESCE("IsDeleted", false) = false
    AND COALESCE("Status"::int, 0) = 3
    AND COALESCE("BookingStatus", false) = false;

CREATE INDEX IF NOT EXISTS idx_cps_case_id
  ON public."CasePremiumSummary" ("CaseID");

CREATE INDEX IF NOT EXISTS idx_ubm_userid
  ON public."UserBrokerMapping" ("UserId");

CREATE INDEX IF NOT EXISTS idx_ubm_companyid
  ON public."UserBrokerMapping" ("CompanyId");

CREATE INDEX IF NOT EXISTS idx_user_aspnet_id
  ON public."User" ("AspNetUserID");

CREATE INDEX IF NOT EXISTS idx_brm_renewal_linked_case
  ON public."BrmRenewalData" ("LinkedQuotationCaseId")
  WHERE "LinkedQuotationCaseId" IS NOT NULL;
