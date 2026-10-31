import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL ?? null;
export const databaseAvailable = Boolean(databaseUrl);

export const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

const runtimeDb = databaseUrl ? drizzle(pool!, { schema }) : null;

export function requireDatabase(): typeof runtimeDb {
  if (!runtimeDb) {
    throw new Error(
      "DATABASE_URL is not configured. Database-backed features are unavailable in this environment; non-database functions remain available and database tests are skipped.",
    );
  }
  return runtimeDb;
}

export const db = new Proxy({} as Record<string, unknown>, {
  get(_target, property, _receiver) {
    if (!runtimeDb) {
      throw new Error(
        "DATABASE_URL is not configured. Database-backed features are unavailable in this environment; non-database functions remain available and database tests are skipped.",
      );
    }
    const value = (runtimeDb as Record<string, unknown>)[String(property)];
    if (typeof value === "function") {
      return value.bind(runtimeDb);
    }
    return value;
  },
});

export * from "./schema";
