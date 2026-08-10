/**
 * Apply Management Executive Overview indexes.
 * Usage: node scripts/apply-executive-indexes.js
 * Requires DATABASE_URL in .env (same as Management Panel API).
 */
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/lib/prisma");

async function main() {
  const sqlPath = path.join(__dirname, "..", "sql", "add_management_executive_indexes.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const statements = sql
    .split(";")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter((s) => s.length > 0);

  console.log(`Applying ${statements.length} index statements…`);
  for (const stmt of statements) {
    const label = stmt.slice(0, 80).replace(/\s+/g, " ");
    console.log(`  → ${label}…`);
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
