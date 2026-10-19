import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mergedFields, previewDeviceMerge, applyDeviceMerge } from '../scripts/merge-devices.js';
import { ensureDeviceSchema, findExistingDevice, getInventoryDeviceDetails, upsertDeviceFromSource } from '../scripts/device-registry.js';
import { matchesDeviceSearch } from '../utils/inventory-model.js';
import { deviceFromSnapshot } from '../scripts/unifi-availability.js';

test('merged MACs remain searchable and refresh combines interface addresses using primary settings', () => {
  const device = { mac: '02:00:00:00:00:01', macs: ['02:00:00:00:00:01', '02:00:00:00:00:02'], dns: { records: [] } };
  assert.ok(matchesDeviceSearch(device, '02-00-00-00-00-02'));
  const refreshed = deviceFromSnapshot(device, { networks: [], records: [
    { device: { mac: device.macs[1], ip: '192.0.2.2', userId: 'secondary' } },
    { device: { mac: device.mac, ip: '192.0.2.1', userId: 'primary' } },
  ] });
  assert.deepEqual(refreshed.allIps, ['192.0.2.1', '192.0.2.2']);
  assert.equal(refreshed.unifi.settings.id, 'primary');
});

test('merge keeps chosen metadata, fills blanks, and preserves both notes', () => {
  const merged = mergedFields({ display_name: 'Keep', notes: 'First' },
    { display_name: 'Other', notes: 'Second', device_type: 'Server', keep_current: true });
  assert.equal(merged.display_name, 'Keep');
  assert.equal(merged.device_type, 'Server');
  assert.equal(merged.notes, 'First\n\nSecond');
  assert.equal(merged.keep_current, true);
  assert.equal(mergedFields({ notes: 'Same' }, { notes: 'Same' }).notes, 'Same');
});

test('merge refuses invalid selections before database access', async () => {
  const db = { query() { throw new Error('Unexpected query'); } };
  for (const id of [1, 0, -1, NaN, 1.5]) await assert.rejects(previewDeviceMerge(db, 1, id), /different devices/);
});

test('Postgres: merge preserves associations, records recovery history, follows aliases, and survives reimport',
  { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = { query: (sql, values) => client.query(sql.replace(/CREATE TABLE /g, 'CREATE TEMP TABLE '), values) };
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL search_path TO pg_temp');
      await ensureDeviceSchema(db);
      const a = await upsertDeviceFromSource(db, { source: 'unifi', sourceId: 'a', mac: '02:00:00:00:00:01', name: 'NAS', ip: '192.0.2.1', rawData: { mac: '02:00:00:00:00:01', ip: '192.0.2.1', connected: true } });
      const b = await upsertDeviceFromSource(db, { source: 'unifi', sourceId: 'b', mac: '02:00:00:00:00:02', name: 'NAS', ip: '192.0.2.2', rawData: { mac: '02:00:00:00:00:02', ip: '192.0.2.2' } });
      await db.query("UPDATE devices SET notes=CASE WHEN id=$1 THEN 'First' ELSE 'Second' END", [a.deviceId]);
      await db.query("INSERT INTO device_tags(slug,name) VALUES('test','Test')");
      await db.query('INSERT INTO device_tag_assignments(device_id,tag_id) SELECT $1,id FROM device_tags', [b.deviceId]);
      await db.query("INSERT INTO device_ip_assignments(device_id,ip,label) VALUES($1,'192.0.2.99','keep'),($2,'192.0.2.99','duplicate'),($2,'192.0.2.100','move')", [a.deviceId, b.deviceId]);
      await db.query("INSERT INTO uptime_kuma_data(source_device_key,status) VALUES($1,'up'),($2,'down')", [a.deviceKey, b.deviceKey]);
      let plan = await previewDeviceMerge(db, a.deviceId, b.deviceId);
      await db.query("UPDATE devices SET display_name='Updated' WHERE id=$1", [a.deviceId]);
      await assert.rejects(applyDeviceMerge(db, a.deviceId, b.deviceId, plan.revision), /changed/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 2);
      // Active jobs block even with a fresh revision.
      await db.query("INSERT INTO dns_platform_jobs(id,device_id,hostname,ip,expected_revision) VALUES('00000000-0000-0000-0000-000000000001',$1,'nas','192.0.2.1','test')", [b.deviceId]);
      plan = await previewDeviceMerge(db, a.deviceId, b.deviceId);
      assert.ok(plan.blockers.length);
      await assert.rejects(applyDeviceMerge(db, a.deviceId, b.deviceId, plan.revision), /finish/);
      await db.query("UPDATE dns_platform_jobs SET state='completed'");
      plan = await previewDeviceMerge(db, a.deviceId, b.deviceId);
      await applyDeviceMerge(db, a.deviceId, b.deviceId, plan.revision);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 1);
      assert.equal((await findExistingDevice(db, { mac: '02:00:00:00:00:02' })).id, a.deviceId);
      assert.equal((await getInventoryDeviceDetails(db, b.deviceId)).id, a.deviceId);
      assert.equal((await db.query('SELECT notes FROM devices')).rows[0].notes, 'First\n\nSecond');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM device_ip_assignments WHERE device_id=$1', [a.deviceId])).rows[0].n, 2);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM device_tag_assignments WHERE device_id=$1', [a.deviceId])).rows[0].n, 1);
      assert.equal((await db.query('SELECT device_id FROM dns_platform_jobs')).rows[0].device_id, a.deviceId);
      assert.equal((await db.query('SELECT snapshot FROM device_merge_history')).rows[0].snapshot.devices.length, 2);
      for (const sourceId of ['b', 'new-id']) {
        const refreshed = await upsertDeviceFromSource(db, { source: 'unifi', sourceId, mac: '02:00:00:00:00:02', ip: '192.0.2.2' });
        assert.equal(refreshed.deviceId, a.deviceId);
      }
      assert.equal((await db.query('SELECT mac::text AS mac FROM devices')).rows[0].mac, '02:00:00:00:00:01');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 1);
      const c = await upsertDeviceFromSource(db, { source: 'unifi', sourceId: 'c', name: 'Kept without MAC' });
      plan = await previewDeviceMerge(db, c.deviceId, a.deviceId);
      await applyDeviceMerge(db, c.deviceId, a.deviceId, plan.revision);
      assert.equal((await getInventoryDeviceDetails(db, b.deviceId)).id, c.deviceId, 'old links follow chained merges');
      assert.equal((await findExistingDevice(db, { mac: '02:00:00:00:00:02' })).id, c.deviceId);
      assert.equal((await db.query('SELECT mac::text AS mac FROM devices')).rows[0].mac, '02:00:00:00:00:01', 'blank target inherits primary MAC');
      const d = await upsertDeviceFromSource(db, { source: 'unifi', sourceId: 'd' });
      plan = await previewDeviceMerge(db, d.deviceId, c.deviceId);
      await applyDeviceMerge(db, d.deviceId, c.deviceId, plan.revision);
      assert.equal((await findExistingDevice(db, { mac: '02:00:00:00:00:01' })).id, d.deviceId, 'chained merges allow an inherited MAC already stored as an alias');
    } finally { await db.query('ROLLBACK'); await client.end(); }
  });
