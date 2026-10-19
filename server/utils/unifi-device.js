import { createError, getQuery, readBody } from 'h3';
import { withInventoryDb, parseNumericId } from './inventory-db.js';
import { getInventoryDeviceDetails } from '~/scripts/device-registry.js';
import { queueDnsMove } from '~/scripts/unifi-jobs.js';
import { availabilitySnapshot, deviceFromSnapshot, getIpAvailability } from '~/scripts/unifi-availability.js';
import { enqueueIpChange, problem } from '~/scripts/unifi-platform.js';
import { fetchDns } from '~/scripts/fetch-dns-platform.js';

export async function unifiDeviceRequest(event, action) {
  const id = parseNumericId(event.context.params?.id, 'device id');
  const input = event.method === 'GET' ? getQuery(event) : await readBody(event) || {};
  try {
    return await withInventoryDb(async db => {
      let device = await getInventoryDeviceDetails(db,id);
      if (!device) throw problem('Device not found.',404);
      if (action === 'status') return {device};
      if (action === 'availability') return getIpAvailability(db,device,await availabilitySnapshot(),input);
      if (action === 'refresh') {
        const snapshot=await availabilitySnapshot({fresh:true});
        try {await fetchDns(db);} catch { /* Return the latest source error with retained records. */ }
        return {device:deviceFromSnapshot(await getInventoryDeviceDetails(db,id),snapshot)};
      }
      const { rows: [lock] } = await db.query('SELECT pg_try_advisory_lock(70821403) AS acquired');
      if (!lock.acquired) throw problem('A UniFi operation is running. Try again shortly.',409);
      try {
        const snapshot = await availabilitySnapshot({fresh:true});
        device = deviceFromSnapshot(device,snapshot);
        if (action === 'assign') {
          await db.query('BEGIN');
          try {
            await db.query('SELECT id FROM devices WHERE id=$1 FOR UPDATE',[id]);
            const operationId=await enqueueIpChange(db,device,snapshot,input);
            await db.query('COMMIT');
            return {operationId,device:deviceFromSnapshot(await getInventoryDeviceDetails(db,id),snapshot)};
          } catch(error) { await db.query('ROLLBACK'); throw error; }
        }
        if (action === 'dns') {
          await fetchDns(db);
          device=deviceFromSnapshot(await getInventoryDeviceDetails(db,id),snapshot);
          if (input.expectedRevision!==device.dns.revision) throw problem('DNS records changed. Refresh before updating.',409);
          if (!device.unifi.connected) throw problem('Wait for UniFi to report the device connected before moving DNS.',409);
          await db.query('BEGIN');
          try {
            await db.query('SELECT id FROM devices WHERE id=$1 FOR UPDATE',[id]);
            const operationId=await queueDnsMove(db,device,input.targetIp,{expectedRevision:input.expectedRevision});
            await db.query(`UPDATE unifi_ip_jobs SET state=$2,dns_job_id=$3,error=NULL,updated_at=NOW()
              WHERE device_id=$1 AND state='dns_failed'`,[id,operationId?'dns_pending':'completed',operationId]);
            await db.query('COMMIT');
            return {operationId,device:deviceFromSnapshot(await getInventoryDeviceDetails(db,id),snapshot)};
          } catch(error) {await db.query('ROLLBACK');throw error;}
        }
      } finally { await db.query('SELECT pg_advisory_unlock(70821403)'); }
    });
  } catch(error) {
    if (error.statusCode) throw error;
    if (error.code==='23505') throw createError({statusCode:409,statusMessage:'This device or address already has an operation in progress.'});
    throw createError({statusCode:502,statusMessage:'Unable to complete the UniFi request. Refresh status before trying again.'});
  }
}
