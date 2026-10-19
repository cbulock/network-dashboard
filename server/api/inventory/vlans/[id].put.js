import { createError, defineEventHandler, readBody, getRouterParam } from 'h3';
import { saveVlan } from '~/scripts/network-registry.js';
import { withInventoryDb } from '~/server/utils/inventory-db.js';
export default defineEventHandler(async event => {
  const body = await readBody(event);
  try {
    return await withInventoryDb(async db => ({ vlan: await saveVlan(db, body || {}, Number(getRouterParam(event, 'id'))) }));
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error.message || 'Unable to update VLAN.' });
  }
});
