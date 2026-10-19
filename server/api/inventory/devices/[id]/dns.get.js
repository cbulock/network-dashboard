import { defineEventHandler, createError } from 'h3';
import { getInventoryDeviceDetails } from '~/scripts/device-registry.js';
import { withInventoryDb, parseNumericId } from '~/server/utils/inventory-db.js';
export default defineEventHandler(event => withInventoryDb(async db => {
  const device = await getInventoryDeviceDetails(db,parseNumericId(event.context.params.id));
  if (!device) throw createError({statusCode:404,statusMessage:'Device not found'});
  return { dns: device.dns, hostname: device.hostname };
}));
