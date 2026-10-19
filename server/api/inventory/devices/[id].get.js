import { createError, defineEventHandler } from "h3";
import { getInventoryDeviceDetails } from "~/scripts/device-registry.js";
import { parseNumericId, withInventoryDb } from "~/server/utils/inventory-db.js";

export default defineEventHandler(async (event) => {
  const id = parseNumericId(event.context.params?.id, "device id");

  return withInventoryDb(async (db) => {
    const device = await getInventoryDeviceDetails(db, id);

    if (!device) {
      throw createError({
        statusCode: 404,
        statusMessage: "Device not found",
      });
    }

    return { device };
  });
});
