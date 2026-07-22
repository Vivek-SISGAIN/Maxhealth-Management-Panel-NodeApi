const { prisma } = require("../lib/prisma");

/**
 * Write to shared BrmActionChangeHistory from Management panel.
 * Never throws.
 */
async function writeManagementAudit(entry = {}) {
  try {
    const {
      eventType,
      entityType = "MANAGEMENT",
      caseKey,
      caseId = null,
      changedBy = null,
      oldValues = null,
      newValues = null,
      meta = null,
      sourcePanel = "MANAGEMENT",
      module = "alerts",
    } = entry;
    if (!eventType || !caseKey) return;

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS public."BrmActionChangeHistory" (
        "ID" BIGSERIAL PRIMARY KEY,
        "EventType" VARCHAR(64) NOT NULL,
        "EntityType" VARCHAR(32) NOT NULL,
        "CaseKey" VARCHAR(128) NOT NULL,
        "CaseID" INTEGER NULL,
        "ChangedByAspNetUserId" VARCHAR(450) NULL,
        "ChangedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "OldValues" JSONB NULL,
        "NewValues" JSONB NULL,
        "Meta" JSONB NULL,
        "SourcePanel" VARCHAR(32) DEFAULT 'BRM',
        "Module" VARCHAR(64) DEFAULT 'workbasket'
      )
    `).catch(() => {});

    await prisma.$executeRawUnsafe(
      `ALTER TABLE public."BrmActionChangeHistory"
         ADD COLUMN IF NOT EXISTS "SourcePanel" VARCHAR(32) DEFAULT 'BRM'`
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `ALTER TABLE public."BrmActionChangeHistory"
         ADD COLUMN IF NOT EXISTS "Module" VARCHAR(64) DEFAULT 'workbasket'`
    ).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO public."BrmActionChangeHistory"
        ("EventType", "EntityType", "CaseKey", "CaseID", "ChangedByAspNetUserId",
         "OldValues", "NewValues", "Meta", "SourcePanel", "Module")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
      String(eventType),
      String(entityType),
      String(caseKey),
      caseId != null ? Number(caseId) || null : null,
      changedBy ? String(changedBy) : null,
      oldValues != null ? JSON.stringify(oldValues) : null,
      newValues != null ? JSON.stringify(newValues) : null,
      meta != null ? JSON.stringify(meta) : null,
      String(sourcePanel),
      String(module),
    );
  } catch (err) {
    console.warn("writeManagementAudit failed:", err?.message || err);
  }
}

module.exports = { writeManagementAudit };
