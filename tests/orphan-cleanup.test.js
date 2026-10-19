import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDbClient } from '../scripts/device-registry.js';
import { isEmptyImportedDevice, planOrphanCleanup } from '../scripts/cleanup-orphan-devices.js';

test('orphan cleanup preserves physical identity, manual devices and every local setting', () => {
  const empty = { device_key: 'uptime_kuma:nas6', ips: [], keep_current: false };
  assert.equal(isEmptyImportedDevice(empty), true);
  for (const patch of [{ device_key: 'manual:one' }, { device_key: 'new-source:one' },
    { keep_current: true }, { ips: ['10.0.0.30'] }, ...['mac', 'hostname', 'display_name',
      'primary_ip', 'notes', 'vlan_id', 'dns_target_ip', 'managed_hostname', 'device_type', 'device_role']
      .map(field => ({ [field]: 'retained' }))]) {
    assert.equal(isEmptyImportedDevice({ ...empty, ...patch }), false, JSON.stringify(patch));
  }
});

test('Postgres: orphan preview preserves cascade references, snapshots, manual mappings and history',
  { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
    const db = await getDbClient();
    try {
      await db.query('BEGIN');
      await db.query(`CREATE TEMP TABLE devices(id INT PRIMARY KEY, device_key TEXT, name TEXT);
        CREATE TEMP TABLE device_sources(device_id INT REFERENCES devices(id) ON DELETE CASCADE, mapped_device_key TEXT);
        CREATE TEMP TABLE ha_data(source_device_key TEXT);
        CREATE TEMP TABLE uptime_kuma_data(source_device_key TEXT);
        CREATE TEMP TABLE device_merge_history(target_id INT,removed_id INT);
        CREATE TEMP TABLE future_relation(device_id INT REFERENCES devices(id) ON DELETE SET NULL);
        INSERT INTO devices SELECT n, 'name:device-' || n, 'device-' || n FROM generate_series(1,7) n;
        INSERT INTO device_sources VALUES(2,NULL),(NULL,'name:device-3');
        INSERT INTO ha_data VALUES('name:device-4');
        INSERT INTO uptime_kuma_data VALUES('name:device-5');
        INSERT INTO device_merge_history VALUES(6,99);
        INSERT INTO future_relation VALUES(7);`);
      const plan = await planOrphanCleanup(db);
      assert.deepEqual(plan.removable.map(row => row.id), [1]);
      assert.deepEqual(plan.retained.map(row => row.id), [3,4,5,6,7]);
      assert.match(plan.retained.find(row => row.id === 7).reason, /future_relation/);
      await db.query('DELETE FROM devices WHERE id=$1', [1]);
      assert.deepEqual((await planOrphanCleanup(db)).removable, []);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM future_relation WHERE device_id=7')).rows[0].n, 1);
    } finally { await db.query('ROLLBACK'); await db.end(); }
  });
