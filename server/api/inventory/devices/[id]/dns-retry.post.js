import { defineEventHandler, createError } from 'h3';
import { withInventoryDb, parseNumericId } from '~/server/utils/inventory-db.js';
export default defineEventHandler(event => withInventoryDb(async db => {
  const result = await db.query(`UPDATE dns_platform_jobs SET retry_requested=true WHERE id=(
    SELECT id FROM dns_platform_jobs WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1) AND state='failed'
    AND NOT COALESCE((remote->>'conflict')::boolean,false) RETURNING id`,
  [parseNumericId(event.context.params.id)]);
  if (!result.rows.length) throw createError({statusCode:409,statusMessage:'There is no failed DNS deployment to retry.'});
  await db.query(`UPDATE unifi_ip_jobs SET state='dns_pending',error=NULL,updated_at=NOW()
    WHERE device_id=$1 AND dns_job_id=$2 AND state='dns_failed'`,[parseNumericId(event.context.params.id),result.rows[0].id]);
  return {ok:true};
}));
