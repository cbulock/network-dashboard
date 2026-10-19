import { defineEventHandler } from "h3";
import { listInventoryLookups } from "~/scripts/device-registry.js";
import { withInventoryDb } from "~/server/utils/inventory-db.js";

export default defineEventHandler(async () =>
  withInventoryDb(async (db) => listInventoryLookups(db))
);
