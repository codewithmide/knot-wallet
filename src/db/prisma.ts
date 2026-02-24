import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;

// Create connection pool with SSL config for DigitalOcean
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Accept DigitalOcean's self-signed cert
  },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
  keepAlive: true,
});

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Singleton pattern for Prisma client
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
