import { defineEventHandler } from 'h3';
import { withInventoryDb } from '~/server/utils/inventory-db.js';
export default defineEventHandler(() => withInventoryDb(async db => {
  const { rows: [state] } = await db.query('SELECT revision,zone,last_sync AS "lastSync",error FROM dns_platform_state WHERE id=1');
  return {...state,configured:Boolean(process.env.DNS_PLATFORM_SSH_TARGET)};
}));
