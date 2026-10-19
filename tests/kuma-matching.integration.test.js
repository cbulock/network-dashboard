import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { ensureDeviceSchema, findDeviceByKumaHostname, findDeviceByKumaTarget, getInventoryDeviceDetails, upsertDeviceFromSource } from "../scripts/device-registry.js";
import { planKumaRepairs, applyKumaRepairs } from "../scripts/repair-kuma-links.js";
import { snapshotColumns, storeKumaSnapshot } from "../scripts/source-snapshots.js";

test("Postgres: consolidate Kuma duplicate, preserve health and DNS identity, refresh both snapshot schemas", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = { query: (sql, values) => client.query(sql.replace(/CREATE TABLE /g, "CREATE TEMP TABLE "), values) };
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL search_path TO pg_temp");
    await ensureDeviceSchema(db);
    await db.query(`INSERT INTO devices(device_key,name,mac,ips,display_name,notes) VALUES
      ('name:switch','cameron-desk.switch',NULL,'{}',NULL,NULL),
      ('dns:switch','Desk Switch','74:83:c2:f7:ca:ff',ARRAY['10.0.0.35']::inet[],'Cameron Desk Switch','Keep notes');
      INSERT INTO device_sources(source,source_id,device_id,status,last_seen) VALUES
      ('uptime_kuma','cameron-desk.switch',1,'up','2025-12-18'),
      ('unifi','switch',2,NULL,'2025-12-18'),
      ('dns_platform','A:10.0.0.35',2,NULL,'2025-12-18');
      INSERT INTO dns_platform_records(ip,names,revision) VALUES
      ('10.0.0.35','["cameron-desk.switch","cameron-desk.switch.bulock"]','test');
      INSERT INTO uptime_kuma_data(source_device_key,status,raw_data)
      VALUES ('name:switch','up','{"hostname":"cameron-desk.switch","status":1}');`);
    assert.equal((await findDeviceByKumaHostname(db, " CAMERON-DESK.SWITCH. ")).id, 2);
    assert.equal((await findDeviceByKumaHostname(db, "cameron-desk.switch.bulock")).id, 2);
    assert.equal(await findDeviceByKumaHostname(db, "Cameron Desk Switch"), null);
    const changes = await planKumaRepairs(db, 'cameron-desk.switch');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].removeDevice, true);
    await applyKumaRepairs(db, changes);
    assert.deepEqual(await planKumaRepairs(db), []);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 1);
    assert.equal((await db.query('SELECT source_device_key FROM uptime_kuma_data')).rows[0].source_device_key, 'dns:switch');
    let device = await getInventoryDeviceDetails(db, 2);
    assert.equal(device.status, 'up');
    assert.equal(device.notes, 'Keep notes');
    assert.equal(device.displayName, 'Cameron Desk Switch');
    assert.equal(new Date(device.sources.find((s) => s.source === 'uptime_kuma').lastSeen).toISOString(), '2025-12-18T00:00:00.000Z');
    // A conflicting hostname on another device makes the match ambiguous.
    await db.query("INSERT INTO devices(device_key,hostname) VALUES ('conflict','cameron-desk.switch')");
    assert.equal(await findDeviceByKumaHostname(db, 'cameron-desk.switch'), null);
    await db.query("DELETE FROM devices WHERE device_key='conflict'");
    // Both installed snapshot schemas work without changing table ownership.
    const host = { hostname: 'cameron-desk.switch', status: 0, services: [] };
    for (const legacy of [false, true]) {
      if (legacy) {
        await db.query('ALTER TABLE uptime_kuma_data RENAME TO modern_kuma');
        await db.query('CREATE TEMP TABLE uptime_kuma_data (hostname TEXT PRIMARY KEY, status INTEGER, raw JSONB)');
      }
      const { deviceKey } = await upsertDeviceFromSource(db, { source: 'uptime_kuma', sourceId: host.hostname, name: host.hostname, status: 'down', rawData: host });
      assert.equal(deviceKey, 'dns:switch');
      await storeKumaSnapshot(db, await snapshotColumns(db, 'uptime_kuma_data'), deviceKey, host, 'down');
      device = await getInventoryDeviceDetails(db, 2);
      assert.equal(device.status, 'down');
      assert.equal(device.name, 'Cameron Desk Switch');
      assert.equal((await db.query("SELECT name FROM devices WHERE id=2")).rows[0].name, 'Desk Switch');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 1);
      assert.deepEqual(await planKumaRepairs(db), []);
    }
    // Curated duplicates and explicit mappings are never removed by repair.
    await db.query(`INSERT INTO devices(device_key,name,notes) VALUES ('curated','cameron-desk.switch','Preserve');
      UPDATE device_sources SET device_id=(SELECT id FROM devices WHERE device_key='curated'), link_method='source_id' WHERE source='uptime_kuma'`);
    assert.equal((await planKumaRepairs(db))[0].removeDevice, false);
    await db.query("UPDATE device_sources SET link_method='manual' WHERE source='uptime_kuma'");
    assert.deepEqual(await planKumaRepairs(db), []);
  } finally {
    await db.query("ROLLBACK");
    await client.end();
  }
});

for (const legacy of [false, true]) {
  test(`Postgres: Kuma IP reconciliation preserves snapshots, health, old links, and safe matching (${legacy ? 'legacy' : 'modern'} snapshots)`,
    { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const db = { query: (sql, values) => client.query(sql.replace(/CREATE TABLE /g, 'CREATE TEMP TABLE '), values) };
      try {
        await db.query('BEGIN');
        await db.query('SET LOCAL search_path TO pg_temp');
        await ensureDeviceSchema(db);
        if (legacy) {
          await db.query('ALTER TABLE uptime_kuma_data RENAME TO modern_kuma');
          await db.query('CREATE TEMP TABLE uptime_kuma_data(hostname TEXT PRIMARY KEY,status INTEGER,raw JSONB)');
        }
        await db.query(`INSERT INTO devices(device_key,name,mac,notes) VALUES
          ('physical','Router','02:00:00:00:00:50','Keep notes'),
          ('uptime_kuma:192.0.2.50','192.0.2.50',NULL,NULL),
          ('other','Other','02:00:00:00:00:51',NULL);
          INSERT INTO device_sources(source,source_id,device_id,raw_data,status) VALUES
          ('unifi','router',1,'{"ip":"192.0.2.50","identity":{"ips":["192.0.2.50","2001:db8::50"]}}',NULL),
          ('uptime_kuma','192.0.2.50',2,'{"hostname":"192.0.2.50","services":[{"name":"Ping"}]}','up'),
          ('uptime_kuma','router',1,'{"hostname":"router"}','down');`);
        const columns = await snapshotColumns(db, 'uptime_kuma_data');
        await storeKumaSnapshot(db, columns, 'physical', { hostname: 'router', status: 0 }, 'down');
        await storeKumaSnapshot(db, columns, 'uptime_kuma:192.0.2.50', { hostname: '192.0.2.50', status: 1, services: [{ name: 'Ping' }] }, 'up');
        assert.equal((await findDeviceByKumaTarget(db, ' 192.0.2.50 ')).id, 1);
        assert.equal((await findDeviceByKumaTarget(db, '2001:0DB8:0:0:0:0:0:50')).id, 1);
        // A second UniFi owner is ambiguous even when one record lacks a MAC.
        await db.query(`INSERT INTO device_sources(source,source_id,device_id,raw_data) VALUES
          ('unifi','other',3,'{"identity":{"ips":["192.0.2.50"]}}')`);
        assert.equal(await findDeviceByKumaTarget(db, '192.0.2.50'), null);
        assert.deepEqual(await planKumaRepairs(db, '192.0.2.50'), []);
        await db.query("UPDATE device_sources SET raw_data=jsonb_set(raw_data,'{active}','false') WHERE source_id='other'");
        // Manual mappings must survive even an unambiguous match.
        await db.query("UPDATE device_sources SET mapped_device_key='uptime_kuma:192.0.2.50' WHERE source_id='192.0.2.50'");
        assert.deepEqual(await planKumaRepairs(db, '192.0.2.50'), []);
        await db.query("UPDATE device_sources SET mapped_device_key=NULL WHERE source_id='192.0.2.50'");
        // Curated classification and retention prevent removal, even with otherwise empty metadata.
        await db.query("UPDATE devices SET device_role='Infrastructure',keep_current=true WHERE id=2");
        assert.equal((await planKumaRepairs(db, '192.0.2.50'))[0].removeDevice, false);
        await db.query('UPDATE devices SET device_role=NULL,keep_current=false WHERE id=2');
        const changes = await planKumaRepairs(db, '192.0.2.50');
        assert.equal(changes.length, 1);
        assert.equal(changes[0].removeDevice, true);
        await applyKumaRepairs(db, changes);
        assert.deepEqual(await planKumaRepairs(db, '192.0.2.50'), []);
        assert.equal((await getInventoryDeviceDetails(db, 2)).id, 1, 'old duplicate URL resolves to target');
        const device = await getInventoryDeviceDetails(db, 1);
        assert.equal(device.notes, 'Keep notes');
        assert.equal(device.status, 'down', 'both existing and moved monitor readings survive');
        assert.equal(device.sources.filter(s => s.source === 'uptime_kuma').length, 2);
        const source = (await db.query("SELECT * FROM device_sources WHERE source_id='192.0.2.50'")).rows[0];
        assert.equal(source.device_id, 1);
        assert.equal(source.link_method, 'network_identity');
        assert.equal(source.mapped_device_key, null);
        assert.equal(source.raw_data.services[0].name, 'Ping');
        const history = (await db.query('SELECT snapshot FROM device_merge_history')).rows[0].snapshot;
        if (!legacy) assert.equal(history.uptime_kuma_data.length, 2, 'colliding aggregate snapshots are archived');
        for (const hostname of ['192.0.2.50', '2001:db8::50']) {
          const result = await upsertDeviceFromSource(db, { source: 'uptime_kuma', sourceId: hostname, rawData: { hostname }, status: 'up' });
          assert.equal(result.deviceId, 1);
          await storeKumaSnapshot(db, columns, result.deviceKey, { hostname, status: 1 }, 'up');
        }
        assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 2, 'imports do not recreate the duplicate');
        assert.deepEqual(await planKumaRepairs(db), []);
      } finally { await db.query('ROLLBACK'); await client.end(); }
    });
}
