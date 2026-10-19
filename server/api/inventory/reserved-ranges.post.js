import { createError, defineEventHandler, readBody } from "h3";
import { createReservedRange } from "~/scripts/device-registry.js";
import { withInventoryDb } from "~/server/utils/inventory-db.js";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  try {
    return await withInventoryDb(async (db) => {
      const reservedRange = await createReservedRange(db, body || {});
      return { reservedRange, virtualSubnet: reservedRange };
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : "Invalid reserved range payload",
    });
  }
});
