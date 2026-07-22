/**
 * Single shared Prisma client for the Management API.
 * Creating many PrismaClient() instances multiplies connection pools and
 * causes P2024 (pool timeout) under concurrent BRM insights queries.
 */
const { PrismaClient } = require("@prisma/client");

const globalForPrisma = global;

function buildDatasourceUrl() {
  const raw = process.env.DATABASE_URL || "";
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    // Docker / small CPU hosts default to connection_limit≈3 — too low for Promise.all.
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set(
        "connection_limit",
        process.env.PRISMA_CONNECTION_LIMIT || "20",
      );
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set(
        "pool_timeout",
        process.env.PRISMA_POOL_TIMEOUT || "30",
      );
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const prisma =
  globalForPrisma.__mgmtPrisma ||
  new PrismaClient({
    datasources: {
      db: { url: buildDatasourceUrl() },
    },
    log:
      process.env.PRISMA_LOG === "true"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__mgmtPrisma = prisma;
}

module.exports = { prisma };
