import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDeviceSchema, findExistingDevice, getDbClient } from "./device-registry.js";
import { homeAssistantIdentity } from "./source-identity.js";

export async function planHomeAssistantRepairs(db) {
  const { rows } = await db.query(`
    SELECT ds.source_id, ds.device_id, to_jsonb(ds)->>'link_method' AS link_method,
           to_jsonb(ds)->>'mapped_device_key' AS mapped_device_key,
           (SELECT count(*) = 1 FROM device_sources siblings WHERE siblings.device_id = ds.device_id) AS is_single_source,
           COALESCE(NULLIF(to_jsonb(ds)->'raw_data', 'null'::jsonb), NULLIF(to_jsonb(ds)->'details', 'null'::jsonb), '{}'::jsonb) AS snapshot,
           to_jsonb(h) AS ha_snapshot
    FROM device_sources ds LEFT JOIN ha_data h ON h.entity_id = ds.source_id
    WHERE ds.source = 'home_assistant' ORDER BY ds.source_id
  `);
  const changes = [];
  for (const row of rows) {
    if (row.link_method === "manual" || row.mapped_device_key) continue;
    // Prefer the HA snapshot table where populated, including legacy installs.
    const snapshot = { ...row.snapshot, ...row.ha_snapshot?.raw_data, ...row.ha_snapshot };
    const identity = homeAssistantIdentity(snapshot);
    // A standalone legacy entity has not merged unrelated source records.
    // Preserve it; this repair corrects associations, not inventory ownership.
    if (!identity.mac && !identity.ips.length && row.is_single_source) continue;
    const target = await findExistingDevice(db, identity);
    const nextDeviceId = target?.id ?? null;
    if (row.device_id !== nextDeviceId) {
      changes.push({ sourceId: row.source_id, previousDeviceId: row.device_id,
        nextDeviceId, previousLinkMethod: row.link_method });
    }
  }
  return changes;
}

export async function applyHomeAssistantRepairs(db, changes) {
  for (const change of changes) {
    const result = await db.query(`
      UPDATE device_sources SET device_id = $1, link_method = $2
      WHERE source = 'home_assistant' AND source_id = $3
        AND device_id IS NOT DISTINCT FROM $4::integer
        AND mapped_device_key IS NULL AND link_method IS DISTINCT FROM 'manual'
    `, [change.nextDeviceId, change.nextDeviceId ? "network_identity" : null,
      change.sourceId, change.previousDeviceId]);
    if (result.rowCount !== 1) throw new Error(`Mapping changed during repair: ${change.sourceId}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDbClient();
  try {
    await db.query("BEGIN");
    if (apply) {
      await ensureDeviceSchema(db);
      await db.query("LOCK TABLE device_sources, devices, device_ip_assignments, ha_data IN SHARE ROW EXCLUSIVE MODE");
    }
    const changes = await planHomeAssistantRepairs(db);
    let backupPath = null;
    if (apply && changes.length) {
      await mkdir(".data/repairs", { recursive: true });
      backupPath = resolve(`.data/repairs/ha-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      // Recovery manifest contains only mapping IDs, never tokens or snapshots.
      await writeFile(backupPath, JSON.stringify({ createdAt: new Date(), changes }, null, 2), { flag: "wx" });
      await applyHomeAssistantRepairs(db, changes);
    }
    await db.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", changes: changes.length,
      detached: changes.filter((change) => change.nextDeviceId === null).length,
      relinked: changes.filter((change) => change.nextDeviceId !== null).length,
      backupPath, sample: changes.slice(0, 12) }, null, 2));
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
