import { createError, defineEventHandler, readBody } from "h3";
import { createInventoryDevice } from "~/scripts/device-registry.js";
import { withInventoryDb } from "~/server/utils/inventory-db.js";
import { dnsInventoryPayload } from '~/server/utils/dns-inventory.js';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  try {
    return await withInventoryDb(async (db) => {
      const device = await createInventoryDevice(db, await dnsInventoryPayload(db, body || {}));
      return { device };
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "Invalid device payload",
    });
  }
});
