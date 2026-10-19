import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDeviceSchema, findDeviceByKumaTarget, getDbClient } from "./device-registry.js";
import { normalizeKumaTarget } from "./source-identity.js";
import { previewDeviceMerge, applyDeviceMerge } from './merge-devices.js';

export async function planKumaRepairs(db, sourceId = null) {
  const { rows } = await db.query(`
    SELECT ds.source_id, ds.device_id, ds.link_method, ds.mapped_device_key,
           to_jsonb(ds) AS previous_source,
           COALESCE(ds.raw_data->>'hostname', to_jsonb(ds)#>>'{details,hostname}', ds.source_id) AS hostname,
           to_jsonb(d) AS device,
           (d.mac IS NULL AND d.hostname IS NULL AND d.display_name IS NULL
             AND d.primary_ip IS NULL AND d.dns_target_ip IS NULL AND d.notes IS NULL
             AND d.managed_hostname IS NULL AND d.device_type IS NULL AND d.device_role IS NULL AND NOT d.keep_current
             AND cardinality(COALESCE(d.ips, '{}'::inet[])) = 0
             AND NOT EXISTS (SELECT 1 FROM device_sources s WHERE s.device_id=d.id AND (s.source <> 'uptime_kuma' OR s.source_id <> ds.source_id))
             AND NOT EXISTS (SELECT 1 FROM device_tag_assignments t WHERE t.device_id=d.id)
             AND NOT EXISTS (SELECT 1 FROM device_ip_assignments a WHERE a.device_id=d.id)
             AND NOT EXISTS (SELECT 1 FROM ha_data h WHERE to_jsonb(h)->>'source_device_key'=d.device_key)
             AND NOT EXISTS (SELECT 1 FROM subnet_allocations a WHERE a.assigned_device_id=d.id)
             AND NOT EXISTS (SELECT 1 FROM dns_platform_jobs j WHERE j.device_id=d.id)
             AND NOT EXISTS (SELECT 1 FROM unifi_ip_jobs j WHERE j.device_id=d.id)
             AND NOT EXISTS (SELECT 1 FROM device_merge_aliases a WHERE a.device_id=d.id)) AS disposable
    FROM device_sources ds LEFT JOIN devices d ON d.id=ds.device_id
    WHERE ds.source='uptime_kuma' AND ($1::text IS NULL OR ds.source_id=$1)
    ORDER BY ds.source_id
  `, [sourceId]);
  const changes = [];
  for (const row of rows) {
    if (row.link_method === "manual" || row.mapped_device_key) continue;
    const identity = normalizeKumaTarget(row.hostname);
    const target = await findDeviceByKumaTarget(db, row.hostname);
    if (!target || target.id === row.device_id) continue;
    const previousName = normalizeKumaTarget(row.device?.name);
    const removeDevice = Boolean(row.disposable && identity && previousName?.kind === identity.kind && previousName.value === identity.value);
    if (removeDevice && (await previewDeviceMerge(db, target.id, row.device_id)).blockers.length) continue;
    changes.push({ sourceId: row.source_id, previousDeviceId: row.device_id,
      nextDeviceId: target.id, nextDeviceKey: target.device_key,
      previousLinkMethod: row.link_method, removeDevice,
      nextLinkMethod: identity.kind === 'ip' ? 'network_identity' : 'hostname',
      previousSource: row.previous_source, previousDevice: row.device });
  }
  return changes;
}

// The caller owns the transaction and table locks. A fresh plan must match the
// preview, and the recovery manifest must be saved before applying it.
export async function applyKumaRepairs(db, changes) {
  for (const change of changes) {
    if (change.removeDevice) {
      const plan = await previewDeviceMerge(db, change.nextDeviceId, change.previousDeviceId);
      await applyDeviceMerge(db, change.nextDeviceId, change.previousDeviceId, plan.revision);
      // This is an automatic identity repair, not an explicit manual override.
      const result = await db.query(`UPDATE device_sources SET link_method=$1, mapped_device_key=NULL
        WHERE source='uptime_kuma' AND source_id=$2 AND device_id=$3`,
      [change.nextLinkMethod, change.sourceId, change.nextDeviceId]);
      if (result.rowCount !== 1) throw new Error(`Mapping changed during repair: ${change.sourceId}`);
      continue;
    }
    const result = await db.query(`UPDATE device_sources SET device_id=$1, link_method=$5
      WHERE source='uptime_kuma' AND source_id=$2 AND device_id IS NOT DISTINCT FROM $3::integer
        AND mapped_device_key IS NULL AND link_method IS NOT DISTINCT FROM $4::text`,
    [change.nextDeviceId, change.sourceId, change.previousDeviceId, change.previousLinkMethod, change.nextLinkMethod]);
    if (result.rowCount !== 1) throw new Error(`Mapping changed during repair: ${change.sourceId}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sourceIndex = process.argv.indexOf("--source-id");
  const sourceId = sourceIndex < 0 ? null : process.argv[sourceIndex + 1];
  if (sourceIndex >= 0 && (!sourceId || sourceId.startsWith("--"))) throw new Error("--source-id requires a hostname or IP");
  const db = await getDbClient();
  try {
    await db.query("BEGIN");
    if (apply) {
      await ensureDeviceSchema(db);
      await db.query(`LOCK TABLE devices, device_sources, device_tag_assignments,
        device_ip_assignments, subnet_allocations, dns_platform_jobs,
        dns_platform_records, unifi_data, ha_data, uptime_kuma_data,
        device_merge_aliases, unifi_ip_jobs IN SHARE ROW EXCLUSIVE MODE`);
    }
    const changes = await planKumaRepairs(db, sourceId);
    let backupPath = null;
    if (apply && changes.length) {
      await mkdir(".data/repairs", { recursive: true });
      backupPath = resolve(`.data/repairs/kuma-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(backupPath, JSON.stringify({ createdAt: new Date(), changes }, null, 2), { flag: "wx" });
      await applyKumaRepairs(db, changes);
    }
    await db.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", changes: changes.length,
      removedDuplicates: changes.filter((c) => c.removeDevice).length, backupPath,
      sample: changes.slice(0, 12).map(({ previousDevice, previousSource, ...change }) => change) }, null, 2));
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
