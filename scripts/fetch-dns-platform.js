import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { controllerRequest, normalizeSnapshot, deviceAddress } from './dns-platform.js';
import { getDbClient, ensureDeviceSchema, findExistingDevice } from './device-registry.js';

export async function importDnsSnapshot(db, input) {
  const snapshot = normalizeSnapshot(input); // Validate everything before retiring any record.
  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(70821401)");
    await db.query('UPDATE dns_platform_records SET active=false');
    await db.query(`UPDATE device_sources SET raw_data=jsonb_set(COALESCE(raw_data,'{}'),'{active}','false') WHERE source='dns_platform'`);
    for (const record of snapshot.records) {
      await db.query(`INSERT INTO dns_platform_records(ip,names,revision,active) VALUES($1,$2,$3,true)
        ON CONFLICT(ip) DO UPDATE SET names=EXCLUDED.names,revision=EXCLUDED.revision,active=true`,
      [record.ip, JSON.stringify(record.names), snapshot.revision]);
    }
    for (const record of snapshot.records) {
      const sourceId = `A:${record.ip}`;
      const { rows: [previous] } = await db.query("SELECT * FROM device_sources WHERE source='dns_platform' AND source_id=$1", [sourceId]);
      const manual = previous?.link_method === 'manual' || Boolean(previous?.mapped_device_key);
      let deviceId = manual ? previous.device_id : null;
      let method = manual ? 'manual' : null;
      const { rows: bindings } = await db.query(`SELECT id FROM devices WHERE managed_hostname=ANY($1::text[])`, [record.names]);
      if (!manual && bindings.length === 1) { deviceId = bindings[0].id; method = 'hostname_binding'; }
      if (!manual && !deviceId && deviceAddress(record.ip)) {
        const existing = await findExistingDevice(db, { ips: [record.ip] });
        if (existing) { deviceId = existing.id; method = 'network_identity'; }
      }
      if (deviceId) await db.query(`UPDATE devices SET managed_hostname=$2 WHERE id=$1 AND managed_hostname IS NULL`, [deviceId, record.names[0]]);
      await db.query(`INSERT INTO device_sources(source,source_id,device_id,raw_data,last_seen,link_method)
        VALUES('dns_platform',$1,$2,$3,NOW(),$4) ON CONFLICT(source,source_id) DO UPDATE SET
        device_id=EXCLUDED.device_id,raw_data=EXCLUDED.raw_data,last_seen=NOW(),link_method=EXCLUDED.link_method`,
      [sourceId, deviceId, { friendly_name: record.names[0], names: record.names, active: true, identity: { ips: [record.ip], mac: null } }, method]);
    }
    await db.query('UPDATE dns_platform_state SET revision=$1,zone=$2,capabilities=$3,last_sync=NOW(),error=NULL WHERE id=1', [snapshot.revision,snapshot.zone,JSON.stringify(snapshot.capabilities)]);
    await db.query('COMMIT');
    return snapshot;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

export async function fetchDns(db, request = controllerRequest) {
  try { return await importDnsSnapshot(db, await request({ operation: 'records.list' })); }
  catch (error) { await db.query('UPDATE dns_platform_state SET error=$1 WHERE id=1', [error.message]); throw error; }
}
async function main() {
  const db = await getDbClient();
  try { await ensureDeviceSchema(db); const result = await fetchDns(db); console.log(`Imported ${result.records.length} DNS records.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message);process.exitCode=1; });
