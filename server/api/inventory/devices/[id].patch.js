import { createError, defineEventHandler, readBody } from "h3";
import { updateInventoryDevice } from "~/scripts/device-registry.js";
import { parseNumericId, withInventoryDb } from "~/server/utils/inventory-db.js";
import { dnsInventoryPayload } from '~/server/utils/dns-inventory.js';

export default defineEventHandler(async (event) => {
  const id = parseNumericId(event.context.params?.id, "device id");
  const body = await readBody(event);

  try {
    return await withInventoryDb(async (db) => {
      const device = await updateInventoryDevice(db, id, await dnsInventoryPayload(db, body || {}, id));

      if (!device) {
        throw createError({
          statusCode: 404,
          statusMessage: "Device not found",
        });
      }

      return { device };
    });
  } catch (error) {
    if (error?.statusCode) {
      throw error;
    }

    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "Invalid device payload",
    });
  }
});
