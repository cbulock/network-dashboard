import assert from "node:assert/strict";
import test from "node:test";
import {
  createInventoryDevice,
  getInventoryDeviceDetails,
  listInventoryDevices,
  updateInventoryDevice,
} from "../scripts/device-registry.js";

const vlans = [
  { id: 1, vlanId: 10, name: "LAN", subnet: "192.168.0.0/16" },
  { id: 2, vlanId: 20, name: "Servers", subnet: "192.168.10.0/24" },
  { id: 3, vlanId: 30, name: "IPv6", subnet: "2001:db8::/32" },
];

function fixture(rows, networks = vlans) {
  return {
    queries: [],
    networks,
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(0, ...placeholders), values.length, "SQL bindings match placeholders");
      if (/FROM vlans/.test(sql)) return { rows: this.networks };
      if (/FROM devices d/.test(sql)) {
        assert.doesNotMatch(sql, /d\.vlan_id|dia\.vlan_id/, "reads ignore stored VLAN choices");
        return { rows: /WHERE d.id =/.test(sql) ? rows.filter((row) => row.id === values[0]) : rows };
      }
      if (/SELECT \* FROM devices/.test(sql)) return { rows: rows.filter((row) => row.id === values[0]) };
      if (/INSERT INTO devices/.test(sql)) return { rows: [{ id: rows[0].id }] };
      return { rows: [] };
    },
  };
}

function device(overrides = {}) {
  return {
    id: 1,
    device_key: "test:router",
    name: "Router",
    primary_ip: "192.168.10.42",
    discovered_ips: ["192.168.10.42", "2001:db8::1"],
    unifi_records: [{kind:'client',ip:overrides.primary_ip || '192.168.10.42',ipv6_addresses: ['2001:db8::1']}],
    assigned_ips: [{ ip: "192.168.10.43", vlanId: 999, vlanNumber: 999, vlanName: "Old choice" }],
    vlan: { id: 999, vlanId: 999 },
    vlan_id: 999,
    ...overrides,
  };
}

test("inventory and detail derive networks only from UniFi addresses", async () => {
  const db = fixture([device()]);
  const [result] = await listInventoryDevices(db);
  assert.equal(result.vlan.id, 2);
  assert.deepEqual(result.vlans.map((vlan) => vlan.id), [2, 3]);
  assert.deepEqual(result.assignedIps, []);
  assert.deepEqual(await getInventoryDeviceDetails(db, 1), result);
});

test("VLAN filters include secondary networks and exclude stored manual choices", async () => {
  const db = fixture([device()]);
  assert.equal((await listInventoryDevices(db, { vlanId: 3 })).length, 1);
  assert.equal((await listInventoryDevices(db, { vlanId: 999 })).length, 0);
  assert.equal((await listInventoryDevices(db, { vlanId: 1 })).length, 0);
});

test('detail hardware adds MAC registration while preserving UniFi model and firmware', async () => {
  const row = device({ mac: '00:00:0c:12:34:56' });
  row.unifi_records[0] = { ...row.unifi_records[0], model: 'Reported model', version: '1.2.3' };
  const db = fixture([row]);
  const detail = await getInventoryDeviceDetails(db, 1);
  assert.equal(detail.hardware.model, 'Reported model');
  assert.equal(detail.hardware.firmware, '1.2.3');
  assert.match(detail.hardware.manufacturer, /Cisco/i);
  row.mac = '02:00:0c:12:34:56';
  const changed = await getInventoryDeviceDetails(db, 1);
  assert.equal(changed.hardware.manufacturer, null);
  assert.match(changed.hardware.addressType, /Locally administered/);
  assert.equal(await getInventoryDeviceDetails(db, 999), null);
});

test("changing network ranges rematches existing devices without writes", async () => {
  const db = fixture([device()]);
  assert.equal((await getInventoryDeviceDetails(db, 1)).vlan.id, 2);
  db.networks = [{ ...vlans[1], subnet: "10.0.0.0/24" }];
  const refreshed = await getInventoryDeviceDetails(db, 1);
  assert.equal(refreshed.vlan, null);
  assert.deepEqual(refreshed.vlans, []);
  assert.deepEqual(refreshed.assignedIps, []);
  assert.ok(db.queries.every(({ sql }) => !/INSERT|UPDATE|DELETE/.test(sql)));
});

test("VLAN sorting uses inferred primary network", async () => {
  const db = fixture([device(), device({ id: 2, primary_ip: "192.168.1.1", name: "AP" })]);
  assert.deepEqual((await listInventoryDevices(db, { sortBy: "vlan", sortDir: "asc" })).map((row) => row.id), [2, 1]);
  assert.deepEqual((await listInventoryDevices(db, { sortBy: "vlan", sortDir: "desc" })).map((row) => row.id), [1, 2]);
});

test('metadata writes ignore VLAN selections and reject local IP ownership', async () => {
 const db=fixture([device()]);
 for (const write of [payload=>createInventoryDevice(db,payload),payload=>updateInventoryDevice(db,1,payload)]) {
   await assert.rejects(write({assignedIps:[{ip:'192.168.10.99'}]}),/managed in UniFi/);
   await assert.rejects(write({primaryIp:'192.168.10.99'}),/managed in UniFi/);
   assert.equal((await write({displayName:'Test',vlanId:999999})).vlan.id,2);
 }
 assert.ok(db.queries.filter(q=>/INSERT INTO devices|UPDATE devices/.test(q.sql)).every(q=>!q.values.includes(999999)));
});

test('legacy addresses cannot supply current IP or network context',async()=>{
 const db=fixture([device({unifi_records:[]})]);
 const result=await getInventoryDeviceDetails(db,1);
 assert.equal(result.primaryIp,null); assert.deepEqual(result.allIps,[]); assert.deepEqual(result.assignedIps,[]); assert.equal(result.vlan,null);
});
