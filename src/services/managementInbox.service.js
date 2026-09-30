/**
 * Management inbox notifications — mirrors Medical UW inbox pattern.
 * Persists via raw SQL so it works even if Prisma client isn't regenerated.
 */
const { randomUUID } = require("crypto");
const { prisma } = require("../lib/prisma");
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ManagementInboxNotification" (
      "Id" TEXT PRIMARY KEY,
      "Type" TEXT NOT NULL,
      "Title" TEXT NOT NULL,
      "Message" TEXT NOT NULL,
      "SourceKey" TEXT UNIQUE,
      "Module" TEXT,
      "LinkModule" TEXT,
      "IsRead" BOOLEAN NOT NULL DEFAULT false,
      "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ManagementInboxNotification_IsRead_idx"
      ON "ManagementInboxNotification" ("IsRead")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ManagementInboxNotification_CreatedAt_idx"
      ON "ManagementInboxNotification" ("CreatedAt")
  `);
  tableReady = true;
}

async function upsertNotification({ type, title, message, sourceKey, module, linkModule, legacyKey, legacyNotBefore }) {
  await ensureTable();
  const existing = await prisma.$queryRawUnsafe(
    `SELECT "Id" FROM "ManagementInboxNotification" WHERE "SourceKey" = $1 LIMIT 1`,
    sourceKey,
  );
  if (existing?.length) return existing[0];
  // Old-format key already notified for this same submission → don't duplicate
  if (legacyKey && legacyNotBefore) {
    const legacy = await prisma.$queryRawUnsafe(
      `SELECT "Id" FROM "ManagementInboxNotification" WHERE "SourceKey" = $1 AND "CreatedAt" >= $2::timestamptz LIMIT 1`,
      legacyKey,
      new Date(legacyNotBefore).toISOString(),
    );
    if (legacy?.length) return legacy[0];
  }
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ManagementInboxNotification"
      ("Id","Type","Title","Message","SourceKey","Module","LinkModule","IsRead","CreatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW())
     ON CONFLICT ("SourceKey") DO NOTHING`,
    id,
    type,
    title,
    message,
    sourceKey,
    module || null,
    linkModule || null,
  );
  return { Id: id };
}

/**
 * Sync inbox from live Management-relevant events:
 * - medical underwriting approvals waiting
 * - active management alerts
 * - UW SLA breaches
 */
async function syncFromLiveEvents() {
  await ensureTable();

  // 1) Pending medical workbench approvals
  const tasks = await prisma.medicalTask.findMany({
    where: { TaskType: "UNDERWRITING" },
    select: { Id: true, CaseId: true, Metadata: true, Priority: true, UpdatedAt: true },
    orderBy: { UpdatedAt: "desc" },
    take: 120,
  });

  // Collect pending members first so names / case numbers can be looked up in bulk
  const pending = [];
  for (const task of tasks) {
    const members = task.Metadata?.doctorWorkbench?.members || {};
    for (const [memberId, wb] of Object.entries(members)) {
      if (!wb || typeof wb !== "object") continue;
      const stage = String(wb.stage || "");
      if (stage !== "SENT_FOR_MANAGEMENT_APPROVAL" && stage !== "RESUBMITTED") continue;
      pending.push({ task, memberId, wb });
    }
  }

  const memberRows = pending.length
    ? await prisma.underwritingMember
        .findMany({
          where: { Id: { in: pending.map((p) => p.memberId) } },
          select: { Id: true, Name: true },
        })
        .catch(() => [])
    : [];
  const caseRows = pending.length
    ? await prisma.underwritingCase
        .findMany({
          where: { Id: { in: [...new Set(pending.map((p) => p.task.CaseId).filter(Boolean))] } },
          select: { Id: true, CaseId: true, Client: true },
        })
        .catch(() => [])
    : [];
  const nameById = new Map(memberRows.map((m) => [m.Id, m.Name]));
  const caseById = new Map(caseRows.map((c) => [c.Id, c]));

  for (const { task, memberId, wb } of pending) {
    const name =
      nameById.get(memberId) ||
      wb.formSnapshot?.memberName ||
      wb.formSnapshot?.name ||
      "Member";
    const c = caseById.get(task.CaseId);
    const caseLabel = c?.CaseId || task.CaseId || "—";
    const client = c?.Client ? ` · ${c.Client}` : "";
    const resubmitted = (wb.stageHistory || []).filter(
      (h) => h?.stage === "SENT_FOR_MANAGEMENT_APPROVAL",
    ).length > 1;
    // Key includes the submission time → every (re)submission notifies again
    const sentAt = wb.stageUpdatedAt ? new Date(wb.stageUpdatedAt).getTime() : 0;
    await upsertNotification({
      type: "approval_required",
      title: resubmitted ? "Medical UW resubmitted for approval" : "Medical UW approval required",
      message: `${name} · case ${caseLabel}${client} — sent by Medical team for management decision`,
      sourceKey: `approval:${task.Id}:${memberId}:${sentAt}`,
      legacyKey: `approval:${task.Id}:${memberId}`,
      legacyNotBefore: wb.stageUpdatedAt || null,
      module: "medical",
      linkModule: "medical-approvals",
    });
  }

  // 2) Active alerts
  const alerts = await prisma.managementAlert.findMany({
    where: { Status: { in: ["active", "acknowledged"] } },
    orderBy: { CreatedAt: "desc" },
    take: 40,
  });
  for (const a of alerts) {
    await upsertNotification({
      type: a.Severity === "critical" || a.Severity === "high" ? "alert_critical" : "alert",
      title: a.Title,
      message: a.Message,
      sourceKey: `alert:${a.Id}`,
      module: "alerts",
      linkModule: "overview",
    });
  }

  // 3) SLA breaches (UW tasks)
  const breaches = await prisma.medicalTask.findMany({
    where: { TaskType: "UNDERWRITING", SlaBreach: true },
    orderBy: { UpdatedAt: "desc" },
    take: 30,
    select: { Id: true, CaseId: true, Priority: true, UpdatedAt: true },
  });
  for (const t of breaches) {
    await upsertNotification({
      type: "sla_breach",
      title: "UW task SLA breach",
      message: `Case ${t.CaseId || t.Id} · priority ${t.Priority || "MEDIUM"}`,
      sourceKey: `sla:${t.Id}`,
      module: "medical",
      linkModule: "medical-tasks",
    });
  }
}

async function listInbox() {
  await ensureTable();
  await syncFromLiveEvents();
  const rows = await prisma.$queryRawUnsafe(`
    SELECT "Id","Type","Title","Message","SourceKey","Module","LinkModule","IsRead","CreatedAt"
    FROM "ManagementInboxNotification"
    ORDER BY "CreatedAt" DESC
    LIMIT 100
  `);
  const unread = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS c FROM "ManagementInboxNotification" WHERE "IsRead" = false
  `);
  return {
    items: rows,
    unreadCount: unread?.[0]?.c || 0,
  };
}

async function markRead(id) {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "ManagementInboxNotification" SET "IsRead" = true WHERE "Id" = $1`,
    id,
  );
}

async function markAllRead() {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "ManagementInboxNotification" SET "IsRead" = true WHERE "IsRead" = false`,
  );
}

module.exports = {
  ensureTable,
  upsertNotification,
  syncFromLiveEvents,
  listInbox,
  markRead,
  markAllRead,
};
