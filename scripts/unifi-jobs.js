import { randomUUID } from 'node:crypto';
import { connectUnifi, readInventory, assignmentFor, settingsRevision, writeSettings, desiredSettings, ACTIVE_IP_STATES, problem, siteName } from './unifi-platform.js';
import { syncUnifiRecords } from './fetch-unifi.js';
import { getInventoryDeviceDetails } from './device-registry.js';
import { controllerRequest } from './dns-platform.js';
import { fetchDns } from './fetch-dns-platform.js';

export async function refreshUnifi(db, client, site = siteName()) {
  try {
    client ||= await connectUnifi();
    const snapshot = await readInventory(client, site);
    await syncUnifiRecords(db, client, { site, snapshot });
    return snapshot;
  } catch (error) {
    await db.query(`UPDATE unifi_inventory_state SET error=$1 WHERE id=1`, [error.statusCode ? error.message : 'UniFi refresh failed. Check the controller connection.']);
    throw error;
  }
}

export async function queueDnsMove(db, device, targetIp, { request = controllerRequest, fromIp, expectedRevision } = {}) {
  if (!device.hostname || !device.dnsComparison.records.length) throw problem('There is no existing managed DNS record to move.');
  if (!device.allIps.includes(targetIp)) throw problem('The target address must be reported by UniFi.');
  if (device.dns.error || device.unifi.error) throw problem('Refresh both sources successfully before updating DNS.', 409);
  const records = device.dnsComparison.records;
  if (records.length !== 1) throw problem('Multiple DNS answers need manual reconciliation before this hostname can move.', 409);
  const oldIp = fromIp || records[0].ip;
  if (records[0].ip !== oldIp) throw problem('The managed DNS record changed. Refresh before updating.', 409);
  if (oldIp === targetIp) return null;
  // Older controllers cannot safely move existing names. Never fall back to hostname.set.
  const capabilities = await request({ operation: 'records.list' });
  if (!capabilities.capabilities?.includes('hostname.move')) throw problem('DNS Platform needs the hostname.move controller upgrade. UniFi settings are retained.', 409);
  if (capabilities.revision !== device.dns.revision || (expectedRevision && expectedRevision !== device.dns.revision)) throw problem('DNS records changed. Refresh before updating.', 409);
  const id = randomUUID();
  await db.query(`INSERT INTO dns_platform_jobs(id,device_id,hostname,ip,expected_revision,move_from)
    VALUES($1,$2,$3,$4,$5,$6)`, [id,device.id,device.hostname,targetIp,device.dns.revision,oldIp]);
  return id;
}

export async function processUnifiJobs(db, options = {}) {
  const { rows: jobs } = await db.query(`SELECT *,host(ip) AS ip,host(old_ip) AS old_ip FROM unifi_ip_jobs
    WHERE state=ANY($1::text[]) AND state<>'dns_failed' ORDER BY created_at`, [ACTIVE_IP_STATES]);
  if (!jobs.length) return;
  // Independent from the DNS worker's lifetime lock; request APIs share this lock.
  const { rows: [lock] } = await db.query('SELECT pg_try_advisory_lock(70821403) AS acquired');
  if (!lock?.acquired) return;
  try {
    const client = await (options.connect || connectUnifi)();
    for (const job of jobs) {
      try {
        if (job.site !== siteName() && !options.refresh) throw problem('The configured UniFi site changed; reconcile this operation before proceeding.',409);
        if (job.state === 'dns_pending') {
          const { rows: [dns] } = await db.query('SELECT state,error FROM dns_platform_jobs WHERE id=$1', [job.dns_job_id]);
          if (dns?.state === 'live') await setState(db,job,'completed');
          else if (dns?.state === 'failed') await setState(db,job,'dns_failed',dns.error);
          continue;
        }
        let snapshot = await (options.refresh || refreshUnifi)(db,client,job.site);
        const record = snapshot.records.find(r => r.device.mac?.toLowerCase() === job.mac)?.device;
        let assignment = assignmentFor(record,snapshot.networks);
        if (!record) throw problem('The device is no longer reported by UniFi.',409);
        const desiredHash = settingsRevision(job.desired);
        if (assignment.revision !== desiredHash) {
          if (job.state === 'waiting' || assignment.revision !== settingsRevision(job.baseline)) throw problem('UniFi settings were changed outside this operation. Refresh and reconcile.',409);
          const { rows: pending } = await db.query(`SELECT mac,host(ip) AS ip FROM unifi_ip_jobs WHERE state=ANY($1::text[])`,[ACTIVE_IP_STATES]);
          desiredSettings(assignment, job.desired.fixed === false || job.desired.config?.type === 'dhcp' ? 'automatic':'fixed',job.ip,snapshot,job.mac,pending);
          // Commit the attempt marker before an uncertain external request.
          await setState(db,job,'applying');
          await (options.write || writeSettings)(client,job.desired,job.site);
          snapshot = await (options.refresh || refreshUnifi)(db,client,job.site);
          assignment = assignmentFor(snapshot.records.find(r=>r.device.mac?.toLowerCase()===job.mac)?.device,snapshot.networks);
          if (assignment.revision !== desiredHash) throw problem('UniFi update sent; waiting for settings readback.',502);
        }
        await setState(db,job,'waiting');
        const observed = assignment.connected && (job.ip ? assignment.ips.includes(job.ip) : assignment.ips.some(ip => ip !== job.old_ip && !ip.includes(':')));
        if (!observed) continue;
        const target = job.ip || assignment.ips.find(ip=>!ip.includes(':') && ip!==job.old_ip);
        if (!job.hostname) { await setState(db,job,'completed'); continue; }
        try {
          await (options.fetchDns || fetchDns)(db,options.request);
          const device = await (options.getDevice || getInventoryDeviceDetails)(db,job.device_id);
          if (device.hostname !== job.hostname) throw problem('The managed hostname changed. Review DNS before continuing.',409);
          await db.query('BEGIN');
          try {
            await db.query('SELECT id FROM devices WHERE id=$1 FOR UPDATE',[job.device_id]);
            const dnsId = await (options.queueDns || queueDnsMove)(db,device,target,{ request:options.request,fromIp:String(job.dns_from || job.old_ip).split('/')[0],expectedRevision:job.dns_revision });
            await db.query(`UPDATE unifi_ip_jobs SET state=$2,dns_job_id=$3,error=NULL,updated_at=NOW() WHERE id=$1`,[job.id,dnsId?'dns_pending':'completed',dnsId]);
            await db.query('COMMIT');
          } catch(error) { await db.query('ROLLBACK'); throw error; }
        } catch(error) { await setState(db,job,'dns_failed',error.message); }
      } catch(error) {
        await setState(db,job,error.statusCode===409?'conflict':job.state==='pending'?'pending':job.state,error.statusCode ? error.message : 'UniFi request failed. The worker will reconcile controller settings before retrying.');
      }
    }
  } catch(error) {
    await db.query(`UPDATE unifi_inventory_state SET error=$1 WHERE id=1`,[error.statusCode ? error.message : 'UniFi job reconciliation failed. Check the controller connection.']);
    throw error;
  } finally { await db.query('SELECT pg_advisory_unlock(70821403)'); }
}

async function setState(db, job, state, error = null) {
  await db.query('UPDATE unifi_ip_jobs SET state=$2,error=$3,updated_at=NOW() WHERE id=$1',[job.id,state,error]);
  job.state=state;
}
