import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { ensureDeviceSchema, findExistingDevice, getInventoryDeviceDetails, upsertDeviceFromSource } from "../scripts/device-registry.js";
import { applyHomeAssistantRepairs, planHomeAssistantRepairs } from "../scripts/repair-ha-links.js";
import { snapshotColumns, storeHomeAssistantSnapshot, storeUnifiSnapshot } from "../scripts/source-snapshots.js";

test("Postgres: migrate legacy schema, repair links, reimport, and preserve curated inventory", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Force registry-created tables into the session's temporary namespace too.
  const db = { query: (sql, values) => client.query(sql.replace(/CREATE TABLE /g, "CREATE TEMP TABLE "), values) };
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL search_path TO pg_temp");
    // Same legacy columns as the live database. Everything is rolled back.
    await db.query(`CREATE TABLE devices (id SERIAL PRIMARY KEY, device_key TEXT UNIQUE NOT NULL,
      mac MACADDR UNIQUE, name TEXT, ips INET[], status TEXT, last_seen TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE device_sources (source TEXT, source_id TEXT, device_id INTEGER REFERENCES devices(id),
      status TEXT, last_seen TIMESTAMPTZ, details JSONB, mapped_device_key TEXT, PRIMARY KEY(source, source_id));
      CREATE TABLE ha_data (entity_id TEXT PRIMARY KEY, friendly_name TEXT, ip TEXT, mac TEXT, status TEXT, attributes JSONB, last_updated TIMESTAMPTZ);
      CREATE TABLE unifi_data (unifi_id TEXT PRIMARY KEY, mac MACADDR, hostname TEXT, ip INET, raw JSONB);`);
    await ensureDeviceSchema(db);
    await db.query(`INSERT INTO devices(device_key, mac, name, display_name, ips, notes)
      VALUES ('wap','44:61:32:96:55:8f','Basement','Basement WAP',ARRAY['192.0.2.1/24']::inet[],'Keep my notes'),
      ('other','00:11:22:33:44:55','Other',NULL,ARRAY['192.0.2.2']::inet[],NULL)`);
    await db.query(`INSERT INTO device_sources(source, source_id, device_id, details, status, last_seen) VALUES
      ('unifi','wap',1,'{}',NULL,'2025-12-17'),
      ('uptime_kuma','basement.wap',1,'{}','up','2025-12-17'),
      ('home_assistant','climate.basement',1,'{"attributes":{"friendly_name":"Basement"}}',NULL,'2025-12-17'),
      ('home_assistant','device_tracker.wap',1,'{"attributes":{"mac":"44:61:32:96:55:8f"}}',NULL,'2025-12-17')`);
    await db.query(`UPDATE device_sources SET raw_data='{"kind":"client","ip":"192.0.2.1","identity":{"ips":["192.0.2.1"],"mac":"44:61:32:96:55:8f"}}' WHERE source='unifi'`);
    const plan = await planHomeAssistantRepairs(db);
    assert.deepEqual(plan.map((change) => change.sourceId), ['climate.basement']);
    await applyHomeAssistantRepairs(db, plan);
    assert.deepEqual(await planHomeAssistantRepairs(db), []);
    // Both supported collector snapshot schemas work without altering ownership.
    const ha = { entityId: 'sensor.test', friendlyName: 'Test', ip: '192.0.2.1', mac: '44:61:32:96:55:8f', status: 'on', attributes: { friendly_name: 'Test' }, lastUpdated: '2025-12-17' };
    const unifi = { unifiId: 'test', mac: ha.mac, hostname: 'Test', ip: ha.ip };
    for (const legacy of [true, false]) {
      const haColumns = await snapshotColumns(db, 'ha_data');
      const unifiColumns = await snapshotColumns(db, 'unifi_data');
      assert.equal(haColumns.has('attributes'), legacy);
      assert.equal(unifiColumns.has('unifi_id'), legacy);
      await storeHomeAssistantSnapshot(db, haColumns, ha);
      await storeUnifiSnapshot(db, unifiColumns, { name: 'Test' }, unifi);
      assert.equal((await db.query("SELECT friendly_name FROM ha_data WHERE entity_id='sensor.test'")).rows[0].friendly_name, 'Test');
      assert.equal((await db.query("SELECT hostname FROM unifi_data WHERE mac='44:61:32:96:55:8f'")).rows[0].hostname, 'Test');
      if (legacy) {
        await db.query('ALTER TABLE ha_data RENAME TO legacy_ha_data');
        await db.query('ALTER TABLE unifi_data RENAME TO legacy_unifi_data');
        await ensureDeviceSchema(db);
      }
    }
    await upsertDeviceFromSource(db, { source: 'home_assistant', sourceId: 'climate.basement', name: 'Basement', details: { attributes: { friendly_name: 'Basement' } } });
    const unlinked = await db.query("SELECT device_id FROM device_sources WHERE source_id='climate.basement'");
    assert.equal(unlinked.rows[0].device_id, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 2);
    // Host masks, IPv6 canonicalization, contradictory MACs and ambiguous IPs.
    assert.equal((await findExistingDevice(db, { ips: ['192.0.2.1'] })).id, 1);
    assert.equal(await findExistingDevice(db, { ips: ['192.0.2.1'], mac: 'aa:bb:cc:dd:ee:ff' }), null);
    await db.query("INSERT INTO device_ip_assignments(device_id,ip) VALUES (2,'192.0.2.1'),(2,'2001:db8::1')");
    assert.equal((await findExistingDevice(db, { ips: ['192.0.2.1'] })).id, 1, 'manual records do not establish ownership');
    assert.equal(await findExistingDevice(db, { ips: ['2001:db8::1'] }), null);
    await db.query(`INSERT INTO device_sources(source,source_id,device_id,raw_data) VALUES('unifi','other',2,
      '{"kind":"client","ip":"192.0.2.1","identity":{"ips":["192.0.2.1","2001:db8::1"]}}')`);
    assert.equal(await findExistingDevice(db, { ips: ['192.0.2.1'] }), null);
    assert.equal((await findExistingDevice(db, { ips: ['2001:0db8:0:0:0:0:0:1'] })).id, 2);
    await upsertDeviceFromSource(db, { source: 'home_assistant', sourceId: 'device_tracker.wap', name: 'Basement', mac: '44:61:32:96:55:8f', ip: '192.0.2.1', lastSeen: '2025-12-17' });
    const device = await getInventoryDeviceDetails(db, 1);
    assert.equal(device.displayName, 'Basement WAP');
    assert.equal(device.notes, 'Keep my notes');
    assert.equal(device.status, 'up');
    assert.equal(device.sources.filter((source) => source.source === 'home_assistant').length, 1);
    assert.equal(device.sources.find((source) => source.source === 'home_assistant').linkMethod, 'network_identity');
    // Manual remapping explicitly opts in and survives entity refresh.
    await db.query("UPDATE device_sources SET device_id=1, link_method='manual', mapped_device_key='wap' WHERE source_id='climate.basement'");
    await upsertDeviceFromSource(db, { source: 'home_assistant', sourceId: 'climate.basement', name: 'Basement' });
    assert.equal((await db.query("SELECT device_id FROM device_sources WHERE source_id='climate.basement'")).rows[0].device_id, 1);
    assert.deepEqual(await planHomeAssistantRepairs(db), []);
  } finally {
    await db.query("ROLLBACK");
    await client.end();
  }
});
