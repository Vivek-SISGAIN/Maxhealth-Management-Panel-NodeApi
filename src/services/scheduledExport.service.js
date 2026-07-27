/**
 * Scheduled / on-demand CSV export (light) for Management.
 * Emails via SMTP when configured; always audits EXPORT.
 */
const { prisma } = require("../lib/prisma");
const brm = require("./brmInsights.service");
const { insertMgmtAudit } = require("./mgmtAudit.service");

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  /* optional */
}

const schedules = new Map(); // id -> { email, cadence, lastRunAt, filters }

function maskPii(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${(u || "").slice(0, 2)}***@${d || ""}`;
  }
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function buildCasesCsv(cases, mask = true) {
  const header = [
    "DisplayID",
    "Client",
    "Broker",
    "BrokerEmail",
    "BRM",
    "GP",
    "Target",
    "DealStatus",
  ];
  const lines = (cases || []).map((c) => {
    const email = c.BrokerEmail || "";
    const cells = [
      c.DisplayID,
      c.client_name,
      c.BrokerCompanyName,
      mask ? maskPii(email) : email,
      c.brm_name,
      c.gross_premium,
      c.TargetPremium,
      c.DealStatus,
    ];
    return cells
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
      .join(",");
  });
  return [header.join(","), ...lines].join("\n");
}

async function sendCsvEmail({ to, subject, csv, filename }) {
  const configured =
    nodemailer &&
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS;
  if (!configured) {
    return {
      sent: false,
      reason: "SMTP or nodemailer not configured — CSV generated only",
    };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transporter.sendMail({
    from: process.env.SMTP_USER_EMAIL || process.env.SMTP_USER,
    to,
    subject,
    text: "Attached: Management scheduled export (light).",
    attachments: [{ filename, content: csv }],
  });
  return { sent: true };
}

async function runCasesExport({
  email,
  filters = {},
  changedBy,
  maskPiiFlag = true,
}) {
  const data = await brm.getCases({
    ...filters,
    limit: filters.limit || 200,
    offset: 0,
  });
  const csv = buildCasesCsv(data.cases, maskPiiFlag !== false);
  const filename = `mgmt_cases_${new Date().toISOString().slice(0, 10)}.csv`;
  let mail = { sent: false, reason: "No email address" };
  if (email) {
    mail = await sendCsvEmail({
      to: email,
      subject: `MaxHealth Management export · ${filename}`,
      csv,
      filename,
    });
  }
  await insertMgmtAudit({
    eventType: "EXPORT",
    entityType: "CASES",
    caseKey: `export:${filename}`,
    changedBy,
    newValues: {
      rowCount: (data.cases || []).length,
      email: email || null,
      mailed: mail.sent,
      mailReason: mail.reason || null,
      filters,
      masked: maskPiiFlag !== false,
    },
    module: "scheduled-export",
  });
  return {
    filename,
    rowCount: (data.cases || []).length,
    csv,
    mail,
  };
}

function upsertSchedule({ id, email, cadenceHours = 24, filters = {} }) {
  const sid = id || `sch_${Date.now()}`;
  const row = {
    id: sid,
    email,
    cadenceHours: Number(cadenceHours) || 24,
    filters,
    lastRunAt: null,
    createdAt: new Date().toISOString(),
  };
  schedules.set(sid, row);
  return row;
}

function listSchedules() {
  return Array.from(schedules.values());
}

function startScheduler() {
  setInterval(async () => {
    const now = Date.now();
    for (const sch of schedules.values()) {
      const dueMs = (sch.cadenceHours || 24) * 3600 * 1000;
      const last = sch.lastRunAt ? new Date(sch.lastRunAt).getTime() : 0;
      if (now - last < dueMs) continue;
      try {
        await runCasesExport({
          email: sch.email,
          filters: sch.filters,
          changedBy: "scheduler",
        });
        sch.lastRunAt = new Date().toISOString();
      } catch (err) {
        console.warn("[scheduledExport]", err?.message || err);
      }
    }
  }, 60_000).unref?.();
}

module.exports = {
  maskPii,
  buildCasesCsv,
  runCasesExport,
  upsertSchedule,
  listSchedules,
  startScheduler,
};
