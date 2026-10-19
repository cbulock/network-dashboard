import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ensureDeviceSchema, listInventoryDevices, updateInventoryDevice, upsertDeviceFromSource } from '../scripts/device-registry.js';

test('Postgres: lifecycle, address search and classification corrections survive collection', { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
  const connection = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=pg_temp' });
  await connection.connect();
  const db = { query: (sql, values) => {
    assert.doesNotMatch(sql, /\b(public\.|SET\s+search_path|CREATE\s+SCHEMA|DROP\s+SCHEMA)/i, 'test queries cannot reach a persistent schema');
    return connection.query(sql.replace(/CREATE TABLE /g, 'CREATE TEMP TABLE '), values);
  } };
  try {
    await connection.query('SET search_path TO pg_temp');
    assert.equal((await connection.query('SHOW search_path')).rows[0].search_path, 'pg_temp');
    await ensureDeviceSchema(db);
    await ensureDeviceSchema(db);
    await db.query(`INSERT INTO devices(device_key,mac,name,last_seen) VALUES('unifi:old','02:00:00:00:00:01','Old device',NOW()-INTERVAL '91 days'),('unifi:monitored','02:00:00:00:00:02','Monitored',NOW()-INTERVAL '200 days')`);
    const { rows } = await db.query('SELECT id FROM devices ORDER BY id');
    const id = rows[0].id;
    await db.query(`INSERT INTO device_sources(source,source_id,device_id,status,last_seen) VALUES('uptime_kuma','monitor',$1,'down',NOW())`, [rows[1].id]);
    let devices = await listInventoryDevices(db, { sortDir: 'asc' });
    assert.equal(devices.find(d => d.id === id).lifecycle.scope, 'history');
    assert.equal(devices.find(d => d.id === rows[1].id).lifecycle.scope, 'current');
    const saved = await updateInventoryDevice(db, id, { deviceType: 'Camera', role: 'IoT', keepCurrent: true });
    assert.equal(saved.deviceType, 'Camera'); assert.equal(saved.role, 'IoT'); assert.equal(saved.lifecycle.scope, 'current');
    await upsertDeviceFromSource(db, { source: 'unifi', sourceId: 'old', mac: '02:00:00:00:00:01', name: 'Source name', ip: '192.0.2.2', rawData: { kind: 'client', ip: '192.0.2.2', device_type: 'computer' } });
    devices = await listInventoryDevices(db, { search: '192.0.2.2' });
    assert.equal(devices.length, 1); assert.equal(devices[0].deviceType, 'Camera'); assert.equal(devices[0].role, 'IoT');
    assert.equal((await listInventoryDevices(db, { search: '020000000001' })).length, 1);
    const automatic = await updateInventoryDevice(db, id, { deviceType: '', role: '', keepCurrent: false });
    assert.equal(automatic.deviceType, 'Computer'); assert.equal(automatic.role, 'Unassigned'); assert.equal(automatic.classification.typeOverride, null);
    await assert.rejects(updateInventoryDevice(db, id, { deviceType: 'invalid' }), /valid device type/);
  } finally { await connection.end(); }
});
