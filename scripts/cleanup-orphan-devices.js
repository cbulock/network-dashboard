import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDbClient } from './device-registry.js';

// Source absence alone is insufficient: keep manual devices, physical identity,
// local edits, snapshots, operation history and every declared FK association.
export function isEmptyImportedDevice(row) {
  return /^(name|uptime_kuma|home_assistant):/.test(row.device_key || '')
    && !row.keep_current && !(row.ips || []).length
    && ['mac', 'hostname', 'display_name', 'primary_ip', 'notes', 'vlan_id',
      'dns_target_ip', 'managed_hostname', 'device_type', 'device_role']
      .every(field => row[field] == null || row[field] === '');
}

const quote = value => '"' + value.replaceAll('"', '""') + '"';

export async function planOrphanCleanup(db) {
  const { rows: orphans } = await db.query(`SELECT d.* FROM devices d
    WHERE NOT EXISTS (SELECT 1 FROM device_sources s WHERE s.device_id=d.id) ORDER BY d.id`);
  // Discover references, including cascade/set-null constraints, rather than
  // assuming a successful DELETE means there was nothing worth preserving.
  const { rows: references } = await db.query(`SELECT n.nspname AS schema, t.relname AS table,
      a.attname AS column, b.attname AS target
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(local_col,target_col)
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.local_col
    JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=k.target_col
    WHERE c.contype='f' AND c.confrelid='devices'::regclass`);
  const removable = [], retained = [];
  for (const row of orphans) {
    let reason = isEmptyImportedDevice(row) ? null : 'Identity, local configuration, or non-imported device';
    for (const ref of references) {
      if (reason) break;
      const result = await db.query(`SELECT 1 FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${quote(ref.column)}=$1 LIMIT 1`, [row[ref.target]]);
      if (result.rows.length) reason = `Referenced by ${ref.table}`;
    }
    if (!reason) {
      const result = await db.query(`SELECT 1 FROM device_sources WHERE mapped_device_key=$1
        UNION ALL SELECT 1 FROM ha_data h WHERE to_jsonb(h)->>'source_device_key'=$1
        UNION ALL SELECT 1 FROM uptime_kuma_data k WHERE to_jsonb(k)->>'source_device_key'=$1
        UNION ALL SELECT 1 FROM device_merge_history WHERE target_id=$2 OR removed_id=$2 LIMIT 1`, [row.device_key, row.id]);
      if (result.rows.length) reason = 'Retained mapping, snapshot, or merge history';
    }
    if (reason) retained.push({ id: row.id, name: row.name, reason });
    else removable.push(row);
  }
  return { removable, retained };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await getDbClient();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    // Lock before planning; concurrent collectors cannot reattach a candidate.
    const { rows } = await db.query(`SELECT DISTINCT conrelid::regclass::text AS relation
      FROM pg_constraint WHERE contype='f' AND confrelid='devices'::regclass`);
    const tables = [...new Set(['devices', 'device_sources', 'ha_data', 'uptime_kuma_data',
      'device_merge_history', ...rows.map(row => row.relation)])];
    await db.query(`LOCK TABLE ${tables.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    const plan = await planOrphanCleanup(db);
    let backupPath = null;
    if (apply && plan.removable.length) {
      await mkdir('.data/repairs', { recursive: true });
      backupPath = resolve(`.data/repairs/orphan-devices-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeFile(backupPath, JSON.stringify({ createdAt: new Date(), devices: plan.removable }, null, 2), { flag: 'wx' });
      const result = await db.query(`DELETE FROM devices WHERE id=ANY($1::int[])
        AND NOT EXISTS(SELECT 1 FROM device_sources WHERE device_id=devices.id)`, [plan.removable.map(row => row.id)]);
      if (result.rowCount !== plan.removable.length) throw new Error('Cleanup count changed; rolling back');
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', removable: plan.removable.length,
      retained: plan.retained.length, backupPath,
      devices: plan.removable.map(({ id, name }) => ({ id, name })), retainedDevices: plan.retained }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
