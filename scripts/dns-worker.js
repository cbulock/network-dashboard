import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { getDbClient, ensureDeviceSchema } from './device-registry.js';
import { controllerRequest } from './dns-platform.js';
import { fetchDns } from './fetch-dns-platform.js';
import { processUnifiJobs } from './unifi-jobs.js';

export async function processDnsJobs(db, request = controllerRequest) {
  const { rows } = await db.query(`SELECT *,host(ip) AS ip FROM dns_platform_jobs
    WHERE state IN ('pending','deploying') OR retry_requested ORDER BY created_at`);
  let completed = false;
  for (const job of rows) {
    try {
      const result = await request(job.retry_requested ? { operation:'job.retry', id:job.id } :
        { operation:job.move_from ? 'hostname.move' : 'hostname.set', id:job.id, hostname:job.hostname, ip:job.ip, expectedRevision:job.expected_revision,
          ...(job.move_from ? { fromIp: String(job.move_from).split('/')[0] } : {}) });
      if (!['pending','deploying','live','failed'].includes(result.state)) throw new Error('Invalid DNS controller job response');
      await db.query(`UPDATE dns_platform_jobs SET state=$2,remote=$3,error=$4,retry_requested=false,updated_at=NOW() WHERE id=$1`,
        [job.id, result.state, result, result.error ?? null]);
      if (result.state === 'live') await db.query('UPDATE devices SET managed_hostname=$2,dns_target_ip=$3 WHERE id=$1',[job.device_id,job.hostname,job.ip]);
      completed ||= result.state === 'live' || result.state === 'failed';
    } catch (error) {
      // A lost response is not a failed DNS operation. Resubmit the same ID until reconciled.
      await db.query('UPDATE dns_platform_jobs SET error=$2,updated_at=NOW() WHERE id=$1', [job.id,error.message]);
    }
  }
  return completed;
}

export async function runDnsWorker({
  connect = getDbClient, ensure = ensureDeviceSchema, processJobs = processDnsJobs,
  importRecords = fetchDns, sleep = delay, shouldStop = () => false,
  log = message => console.error(message),
  processIpJobs = processUnifiJobs,
} = {}) {
  while (!shouldStop()) {
    let db;
    let connectionError;
    try {
      db = await connect();
      // pg emits errors while idle when a laptop sleeps or the database restarts.
      // Reconnect and reacquire the lock before resuming the durable outbox.
      db.on('error', error => { connectionError = error; });
      await ensure(db);
      const { rows: [lock] } = await db.query('SELECT pg_try_advisory_lock(70821402) AS acquired');
      if (!lock.acquired) throw new Error('Another DNS worker holds the database lock.');
      let lastImport = 0;
      let lastIpCheck = 0;
      while (!shouldStop()) {
        if (connectionError) throw connectionError;
        const completed = await processJobs(db);
        if (Date.now()-lastIpCheck > 10000) {
          try { await processIpJobs(db); } catch(error) { log(error.message); }
          lastIpCheck=Date.now();
        }
        if (connectionError) throw connectionError;
        if (completed || Date.now()-lastImport > 300000) {
          try { await importRecords(db); lastImport = Date.now(); }
          catch (error) {
            if (connectionError) throw connectionError;
            log(error.message);
            lastImport = Date.now()-270000;
          }
        }
        await sleep(2000);
      }
    } catch (error) {
      log(`DNS worker reconnecting: ${error.message}`);
    } finally {
      if (db) await db.end().catch(() => {});
    }
    if (!shouldStop()) await sleep(5000);
  }
}

async function main() {
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });
  process.on('SIGTERM', () => { stopped = true; });
  const logFlag = process.argv.indexOf('--log-file');
  const logFile = logFlag === -1 ? null : process.argv[logFlag + 1];
  if (logFlag !== -1 && !logFile) throw new Error('--log-file requires a path');
  await runDnsWorker({ shouldStop: () => stopped, log(message) {
    if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    else console.error(message);
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode=1; });
