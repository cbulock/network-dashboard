import { createHash } from 'node:crypto';
import { snapshotColumns } from './source-snapshots.js';
import { problem, ACTIVE_IP_STATES } from './unifi-platform.js';

const relations = {
  device_sources: 'device_id', device_tag_assignments: 'device_id',
  device_ip_assignments: 'device_id', subnet_allocations: 'assigned_device_id',
  dns_platform_jobs: 'device_id', unifi_ip_jobs: 'device_id', device_merge_aliases: 'device_id',
};
const fields = ['display_name', 'hostname', 'managed_hostname', 'dns_target_ip', 'primary_ip', 'device_type', 'device_role'];
export function mergedFields(target, other) {
  return Object.fromEntries([
    ...fields.map(key => [key, target[key] || other[key] || null]),
    ['notes', [...new Set([target.notes, other.notes].filter(Boolean))].join('\n\n') || null],
    ['keep_current', Boolean(target.keep_current || other.keep_current)],
  ]);
}

export async function previewDeviceMerge(db, targetId, otherId) {
  if (![targetId, otherId].every(id => Number.isSafeInteger(id) && id > 0) || targetId === otherId)
    throw problem('Choose two different devices.');
  const { rows } = await db.query('SELECT * FROM devices WHERE id=ANY($1::int[]) ORDER BY id', [[targetId, otherId]]);
  const target = rows.find(row => row.id === targetId), other = rows.find(row => row.id === otherId);
  if (!target || !other) throw problem('A selected device no longer exists. Refresh the device list.', 404);
  const snapshot = { devices: rows };
  for (const [table, column] of Object.entries(relations)) {
    snapshot[table] = (await db.query(`SELECT * FROM ${table} WHERE ${column}=ANY($1::int[]) ORDER BY to_jsonb(${table})::text`, [[targetId, otherId]])).rows;
  }
  for (const table of ['ha_data', 'uptime_kuma_data']) {
    if ((await snapshotColumns(db, table)).has('source_device_key')) {
      snapshot[table] = (await db.query(`SELECT * FROM ${table} WHERE source_device_key=ANY($1::text[]) ORDER BY source_device_key`, [[target.device_key, other.device_key]])).rows;
    }
  }
  const blockers = [];
  if (snapshot.unifi_ip_jobs.some(job => ACTIVE_IP_STATES.includes(job.state)) ||
      snapshot.dns_platform_jobs.some(job => ['pending', 'deploying'].includes(job.state)))
    blockers.push('Wait for network and DNS operations on both devices to finish.');
  // Two managed hostnames represent independent DNS ownership; resolve explicitly first.
  if (target.managed_hostname && other.managed_hostname && target.managed_hostname !== other.managed_hostname)
    blockers.push('These devices manage different DNS hostnames. Reconcile their DNS ownership before merging.');
  const result = mergedFields(target, other);
  const conflicts = fields.filter(key => target[key] && other[key] && String(target[key]) !== String(other[key]));
  return { target, other, result, conflicts, blockers, snapshot,
    revision: createHash('sha256').update(JSON.stringify({ targetId, otherId, snapshot })).digest('hex') };
}

// Caller owns the transaction. The locks also serialize collector writes with a merge.
export async function applyDeviceMerge(db, targetId, otherId, revision) {
  await db.query(`LOCK TABLE devices, device_sources, device_tag_assignments, device_ip_assignments,
    subnet_allocations, dns_platform_jobs, unifi_ip_jobs, device_merge_aliases,
    ha_data, uptime_kuma_data IN SHARE ROW EXCLUSIVE MODE`);
  const plan = await previewDeviceMerge(db, targetId, otherId);
  if (!revision || revision !== plan.revision) throw problem('Device data changed. Review a fresh merge preview.', 409);
  if (plan.blockers.length) throw problem(plan.blockers.join(' '), 409);
  const { target, other, result } = plan;
  await db.query('INSERT INTO device_merge_history(target_id,removed_id,snapshot) VALUES($1,$2,$3)', [targetId, otherId, plan.snapshot]);
  await db.query(`UPDATE device_sources SET device_id=$1, mapped_device_key=$3, link_method='manual'
    WHERE device_id=$2`, [targetId, otherId, target.device_key]);
  await db.query(`INSERT INTO device_tag_assignments(device_id,tag_id)
    SELECT $1,tag_id FROM device_tag_assignments WHERE device_id=$2 ON CONFLICT DO NOTHING`, [targetId, otherId]);
  // Conflicting address annotations stay with the kept record; originals remain in history.
  await db.query(`DELETE FROM device_ip_assignments a USING device_ip_assignments b
    WHERE a.device_id=$2 AND b.device_id=$1 AND a.ip=b.ip`, [targetId, otherId]);
  await db.query(`UPDATE device_ip_assignments SET device_id=$1, is_primary=false WHERE device_id=$2`, [targetId, otherId]);
  for (const table of ['subnet_allocations', 'dns_platform_jobs', 'unifi_ip_jobs', 'device_merge_aliases']) {
    const column = relations[table];
    await db.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column}=$2`, [targetId, otherId]);
  }
  if (plan.snapshot.ha_data) await db.query('UPDATE ha_data SET source_device_key=$1 WHERE source_device_key=$2', [target.device_key, other.device_key]);
  if (plan.snapshot.uptime_kuma_data) {
    // This legacy aggregate has one row per device. Keep the newest; full originals are archived above.
    await db.query(`DELETE FROM uptime_kuma_data WHERE source_device_key=$1 AND EXISTS
      (SELECT 1 FROM uptime_kuma_data WHERE source_device_key=$2 AND last_seen >=
        (SELECT last_seen FROM uptime_kuma_data WHERE source_device_key=$1))`, [target.device_key, other.device_key]);
    await db.query(`DELETE FROM uptime_kuma_data WHERE source_device_key=$2 AND EXISTS
      (SELECT 1 FROM uptime_kuma_data WHERE source_device_key=$1)`, [target.device_key, other.device_key]);
    await db.query('UPDATE uptime_kuma_data SET source_device_key=$1 WHERE source_device_key=$2', [target.device_key, other.device_key]);
  }
  const entries = Object.entries(result);
  await db.query('UPDATE devices SET mac=NULL WHERE id=$1', [otherId]);
  await db.query(`UPDATE devices SET ${entries.map(([key], i) => `${key}=$${i + 3}`).join(',')},
    mac=COALESCE(mac,$${entries.length + 3}::macaddr),
    ips=ARRAY(SELECT DISTINCT unnest(COALESCE(ips,'{}') || $${entries.length + 4}::inet[])),
    last_seen=GREATEST(last_seen,$${entries.length + 5}), updated_at=NOW() WHERE id=$1 AND id<>$2`,
  [targetId, otherId, ...entries.map(([, value]) => value), other.mac, other.ips || [], other.last_seen]);
  await db.query('DELETE FROM devices WHERE id=$1', [otherId]);
  await db.query(`INSERT INTO device_merge_aliases(old_id,device_key,mac,device_id) VALUES($1,$2,$3,$4)`,
    [otherId, other.device_key, plan.snapshot.device_merge_aliases.some(a => a.mac === other.mac) ? null : other.mac, targetId]);
  return { deviceId: targetId };
}
