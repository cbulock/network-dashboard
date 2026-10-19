import { createError } from "h3";
import pg from "pg";
import { ensureDeviceSchema } from "~/scripts/device-registry.js";

const { Client } = pg;

let schemaPromise;

export async function getInventoryDb() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw createError({
      statusCode: 500,
      statusMessage: "DATABASE_URL is not configured",
    });
  }

  const db = new Client({ connectionString });
  await db.connect();

  if (!schemaPromise) {
    schemaPromise = ensureDeviceSchema(db).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
  return db;
}

export async function withInventoryDb(work) {
  const db = await getInventoryDb();

  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

export function parseNumericId(value, label = "id") {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid ${label}`,
    });
  }

  return parsed;
}
