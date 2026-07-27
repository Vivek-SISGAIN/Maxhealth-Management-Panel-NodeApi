/**
 * Light audit insert into BrmActionChangeHistory (Management panel).
 * Soft-fails if table missing — does not throw to callers.
 */
const { prisma } = require("../lib/prisma");

async function insertMgmtAudit({
  eventType,
  entityType = "EXPORT",
  caseKey = "mgmt",
  changedBy = null,
  newValues = null,
  module = "management",
}) {
  try {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO public."BrmActionChangeHistory"
        ("EventType", "EntityType", "CaseKey", "ChangedByAspNetUserId",
         "NewValues", "SourcePanel", "Module", "ChangedAt")
      VALUES ($1, $2, $3, $4, $5::jsonb, 'MANAGEMENT', $6, NOW())
      `,
      eventType,
      entityType,
      String(caseKey).slice(0, 128),
      changedBy,
      JSON.stringify(newValues || {}),
      module,
    );
  } catch (err) {
    console.warn("[mgmtAudit]", err?.message || err);
  }
}

module.exports = { insertMgmtAudit };
