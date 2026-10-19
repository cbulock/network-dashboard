import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  ensureDeviceSchema,
  getDbClient,
  upsertDeviceFromSource,
} from "./device-registry.js";
import { snapshotColumns, storeUnifiSnapshot } from "./source-snapshots.js";
import { normalizeMac, normalizeSourceIps } from "./source-identity.js";
import { connectUnifi, readInventory, safeRecord, ensureUnifiSchema, rebuildIpProjection } from './unifi-platform.js';

export async function fetchUnifiRecords(client, site = "default") {
  const records = await Promise.all(["sta", "device"].map(async (endpoint) => {
    const { data } = await client.get(`/proxy/network/api/s/${encodeURIComponent(site)}/stat/${endpoint}`);
    if (data?.meta?.rc !== "ok" || !Array.isArray(data.data)) {
      throw new Error(`Invalid UniFi ${endpoint} response`);
    }
    return data.data.map((device) => ({ device, kind: endpoint === "sta" ? "client" : "managed_device" }));
  }));
  return records.flat();
}

export function normalizeUnifiRecord(device, kind, now = new Date()) {
  const mac = normalizeMac(device.mac);
  // Names and management/uplink addresses are not stable device identities.
  if (!mac) return null;
  const managed = kind === "managed_device";
  const hostname = (managed ? device.name || device.hostname : device.hostname || device.name) || "Unknown";
  const [ip = null] = normalizeSourceIps(device.ip);
  const lastSeen = Number(device.last_seen) > 0 && Number.isFinite(Number(device.last_seen))
    ? new Date(Number(device.last_seen) * 1000) : now;
  // Managed-device responses include adoption and SSH secrets. Persist only
  // inventory metadata, never the full controller management payload.
  const snapshot = safeRecord(device, kind);
  const sourceId = device._id || mac;
  return {
    unifiId: sourceId, mac, hostname, ip, snapshot,
    source: {
      source: "unifi", sourceId, mac, ip, ips: normalizeSourceIps(device.ip, device.ipv6_addresses), name: hostname, lastSeen,
      rawData: { ...snapshot, kind },
    },
  };
}

export async function syncUnifiRecords(db, client, { site = "default", snapshot: providedSnapshot } = {}) {
  // Validate both responses before writing anything. A failed managed-device
  // request must not silently report a successful client-only import.
  const snapshot = providedSnapshot || await readInventory(client, site);
  const records = snapshot.records;
  await ensureDeviceSchema(db);
  await ensureUnifiSchema(db);
  const columns = await snapshotColumns(db, "unifi_data");
  const summary = { clients: 0, managedDevices: 0, skipped: 0 };
  await db.query("BEGIN");
  try {
    for (const { device, kind } of records) {
      const normalized = normalizeUnifiRecord(device, kind);
      if (!normalized) { summary.skipped++; continue; }
      await storeUnifiSnapshot(db, columns, normalized.snapshot, normalized);
      await upsertDeviceFromSource(db, normalized.source, { schemaReady: true });
      summary[kind === "client" ? "clients" : "managedDevices"]++;
    }
    // A complete snapshot retires observations absent from the controller.
    const ids = records.map(({device}) => device._id || normalizeMac(device.mac)).filter(Boolean);
    await db.query(`UPDATE device_sources SET raw_data=jsonb_set(COALESCE(raw_data,'{}'),'{active}','false')
      WHERE source='unifi' AND NOT(source_id=ANY($1::text[]))`, [ids]);
    await db.query(`INSERT INTO unifi_inventory_state(id,site,networks,last_sync,error) VALUES(1,$1,$2,$3,NULL)
      ON CONFLICT(id) DO UPDATE SET site=EXCLUDED.site,networks=EXCLUDED.networks,last_sync=EXCLUDED.last_sync,error=NULL`,
      [snapshot.site, JSON.stringify(snapshot.networks), snapshot.checkedAt]);
    await rebuildIpProjection(db);
    await db.query("COMMIT");
    return summary;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const db = await getDbClient();
  try {
    const client = await connectUnifi();
    const summary = await syncUnifiRecords(db, client, { site: process.env.UNIFI_SITE || "default" });
    console.log(`UniFi sync: ${summary.clients} clients, ${summary.managedDevices} managed devices, ${summary.skipped} skipped (missing/invalid MAC).`);
  } catch(error) {
    await ensureUnifiSchema(db);
    await db.query(`UPDATE unifi_inventory_state SET error=$1 WHERE id=1`, [error.message]);
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("UniFi sync failed:", error.message);
    process.exitCode = 1;
  });
}
