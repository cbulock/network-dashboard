import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { ensureDeviceSchema, getInventoryDeviceDetails } from "../scripts/device-registry.js";
import { importDnsSnapshot } from "../scripts/fetch-dns-platform.js";
import { syncUnifiRecords } from "../scripts/fetch-unifi.js";

for (const legacy of [false, true]) {
  test(`Postgres: UniFi managed devices join DNS inventory, reimport, and roll back (${legacy ? "legacy" : "current"} snapshots)`, { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
    const connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    const db = { query: (sql, values) => connection.query(sql.replace(/CREATE TABLE /g, "CREATE TEMP TABLE "), values) };
    try {
      await connection.query("SET search_path TO pg_temp");
      if (legacy) await db.query(`CREATE TABLE unifi_data (unifi_id TEXT PRIMARY KEY, mac MACADDR, hostname TEXT, ip INET, raw JSONB)`);
      await ensureDeviceSchema(db);
      await importDnsSnapshot(db, { zone: "bulock", revision: "a".repeat(64), records: [{ type: "A", value: "10.0.0.35", names: ["desk.switch"] }] });
      await db.query("INSERT INTO devices(device_key,mac) VALUES('switch','74:83:c2:f7:ca:ff')");
      const { rows: [original] } = await db.query("SELECT * FROM devices");
      await db.query("UPDATE devices SET display_name='My switch', notes='Keep notes' WHERE id=$1", [original.id]);
      await db.query("INSERT INTO device_sources(source, source_id, device_id, status) VALUES('uptime_kuma','switch-health',$1,'down')", [original.id]);
      const switchRecord = { _id: "switch-id", mac: "74:83:c2:f7:ca:ff", name: "Desk Switch", ip: "10.0.0.35", type: "usw", model: "USMINI", state: 1, adopted: true, x_authkey: "secret", last_seen: 1700000000 };
      const laptop = { _id: "client-id", mac: "00:11:22:33:44:55", ip: "10.0.0.99", hostname: "laptop" };
      const http = { async get(url) { return { data: { meta: { rc: "ok" }, data: url.endsWith('/sta') ? [laptop] : url.endsWith('/device') ? [switchRecord, {name:'No identity'}] : [] } }; } };
      for (let pass = 0; pass < 2; pass++) {
        assert.deepEqual(await syncUnifiRecords(db, http), { clients: 1, managedDevices: 1, skipped: 1 });
        await importDnsSnapshot(db, { zone:'bulock',revision:'a'.repeat(64),records:[{type:'A',value:'10.0.0.35',names:['desk.switch']}] });
        const view = await getInventoryDeviceDetails(db, original.id);
        assert.equal(view.name, "My switch");
        assert.equal(view.hostname, "desk.switch");
        assert.equal(view.notes, "Keep notes");
        assert.equal(view.mac, switchRecord.mac);
        assert.equal(view.status, "down");
        assert.deepEqual(view.allIps, ["10.0.0.35"]);
        assert.deepEqual(view.sources.map(s => s.source).sort(), ["dns_platform", "unifi", "uptime_kuma"]);
        assert.equal(view.sources.find(s => s.source === "unifi").linkMethod, "network_identity");
        assert.equal((await db.query("SELECT count(*)::int AS n FROM devices")).rows[0].n, 2);
        const { rows: [source] } = await db.query("SELECT raw_data,status FROM device_sources WHERE source='unifi' AND source_id='switch-id'");
        assert.equal(source.raw_data.kind, "managed_device");
        assert.equal(source.raw_data.model, "USMINI");
        assert.equal(source.status, null);
        const { rows: [snapshot] } = await db.query(`SELECT ${legacy ? "raw" : "raw_data"} AS payload FROM unifi_data WHERE mac=$1`, [switchRecord.mac]);
        assert.equal(snapshot.payload.model, "USMINI");
        assert.ok(!JSON.stringify(snapshot).includes("secret"));
      }
      // A later source conflict must roll back earlier client/snapshot writes.
      laptop.ip = "10.0.0.100";
      switchRecord.mac = "aa:bb:cc:dd:ee:ff";
      await assert.rejects(syncUnifiRecords(db, http), /Conflicting MAC/);
      const { rows: [client] } = await db.query("SELECT ips FROM devices WHERE mac='00:11:22:33:44:55'");
      assert.deepEqual(client.ips, ["10.0.0.99"]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM unifi_data")).rows[0].n, 2);
    } finally {
      await connection.end();
    }
  });
}
