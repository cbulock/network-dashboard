import assert from "node:assert/strict";
import test from "node:test";
import { findExistingDevice, upsertDeviceFromSource } from "../scripts/device-registry.js";
import { homeAssistantIdentity } from "../scripts/source-identity.js";
import { applyHomeAssistantRepairs, planHomeAssistantRepairs } from "../scripts/repair-ha-links.js";

function fixture({ macRows = [], ipRows = [], mapped = [], entities = [] } = {}) {
  return {
    queries: [],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(0, ...placeholders), values.length);
      if (/SELECT ds.source_id/.test(sql)) return { rows: entities };
      if (/JOIN device_sources ds/.test(sql)) return { rows: mapped };
      if (/SELECT \* FROM devices WHERE mac/.test(sql)) return { rows: macRows };
      if (/SELECT d\.\* FROM devices d/.test(sql)) return { rows: ipRows };
      if (/SELECT id, device_key/.test(sql)) return { rows: [{ id: 1, device_key: values[0] }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test("shared friendly names never supply device identity", async () => {
  const db = fixture();
  for (const name of ["Basement", "Unknown", "Router"]) {
    assert.equal(await findExistingDevice(db, { name }), null);
  }
  assert.equal(db.queries.length, 0);
});

test("MAC wins over reused addresses; IPs must have one owner and no MAC conflict", async () => {
  const device = { id: 184, mac: "44:61:32:96:55:8f" };
  assert.equal(await findExistingDevice(fixture({ macRows: [device] }), { mac: "44-61-32-96-55-8F", ips: ["192.0.2.1"] }), device);
  assert.equal(await findExistingDevice(fixture({ ipRows: [device] }), { ips: ["192.0.2.1/32"] }), device);
  assert.equal(await findExistingDevice(fixture({ ipRows: [device] }), { mac: "00:11:22:33:44:55", ips: ["192.0.2.1"] }), null);
  assert.equal(await findExistingDevice(fixture({ ipRows: [device, { id: 2 }] }), { ips: ["192.0.2.1", "192.0.2.2"] }), null);
});

test("HA identity uses entity addresses, including IPv6, and excludes AP/gateway identifiers", () => {
  assert.deepEqual(homeAssistantIdentity({ attributes: { friendly_name: "Basement", ap_mac: "44:61:32:96:55:8f", gateway: "192.0.2.1" } }), { mac: null, ips: [] });
  assert.deepEqual(homeAssistantIdentity({ attributes: { mac_address: "44-61-32-96-55-8F", ip: "192.0.2.1/32", ipv6: "2001:db8::1", ipv4: "invalid" } }), { mac: "44:61:32:96:55:8f", ips: ["192.0.2.1", "2001:db8::1"] });
});

test("unidentified HA entities stay unlinked without creating or renaming devices", async () => {
  const db = fixture({ mapped: [{ id: 184, device_key: "name:basement" }] });
  assert.deepEqual(await upsertDeviceFromSource(db, { source: "home_assistant", sourceId: "climate.basement", name: "Basement", details: { entity_id: "climate.basement" } }), { deviceId: null, deviceKey: null });
  assert.ok(!db.queries.some(({ sql }) => /INSERT INTO devices\s*\(/.test(sql)));
  const write = db.queries.find(({ sql }) => /INSERT INTO device_sources/.test(sql));
  assert.match(write.sql, /device_id = NULL/);
  assert.deepEqual(write.values[2], { entity_id: "climate.basement", identity: { mac: null, ips: [] } });
});

test("explicit remaps and standalone legacy entities survive HA refresh", async () => {
  for (const extra of [{ link_method: "manual" }, { mapped_device_key: "manual:wap" }, { is_single_source: true }]) {
    const db = fixture({ mapped: [{ id: 184, device_key: "manual:wap", ...extra }] });
    await upsertDeviceFromSource(db, { source: "home_assistant", sourceId: "climate.basement", name: "Basement" });
    const write = db.queries.find(({ sql }) => /INSERT INTO device_sources/.test(sql));
    assert.equal(write.values[2], 1);
    assert.equal(write.values[6], extra.is_single_source ? "legacy_entity" : "manual");
  }
});

test("collector aliases retain addresses, snapshots, and observation timestamps", async () => {
  const db = fixture();
  const seenAt = "2025-12-17T22:19:17Z";
  await upsertDeviceFromSource(db, { source: "unifi", sourceId: "ap-1", name: "WAP", ip: "192.0.2.1", details: { signal: -40 }, lastSeen: seenAt });
  const device = db.queries.find(({ sql }) => /INSERT INTO devices\s*\(/.test(sql));
  assert.deepEqual(device.values[3], ["192.0.2.1"]);
  assert.equal(device.values[4], seenAt);
  assert.match(device.sql, /name = COALESCE\(devices.name, EXCLUDED.name\)/);
  const source = db.queries.find(({ sql }) => /INSERT INTO device_sources/.test(sql));
  assert.deepEqual(source.values[3], { signal: -40, identity: { mac: null, ips: ["192.0.2.1"] } });
  assert.equal(source.values[5], seenAt);
  assert.equal(source.values[6], "source_id");
});

test("repair removes unsupported merged links, keeps manual/standalone links, and relinks proven identity", async () => {
  const entities = [
    { source_id: "climate.basement", device_id: 184, snapshot: { attributes: { friendly_name: "Basement" } } },
    { source_id: "light.manual", device_id: 2, link_method: "manual" },
    { source_id: "light.legacy_manual", device_id: 2, mapped_device_key: "manual:light" },
    { source_id: "weather.standalone", device_id: 3, is_single_source: true },
    { source_id: "device_tracker.wap", device_id: 2, ha_snapshot: { mac: "44:61:32:96:55:8f" } },
    { source_id: "notify.unlinked", device_id: null },
  ];
  const db = fixture({ entities, macRows: [{ id: 184 }] });
  const changes = await planHomeAssistantRepairs(db);
  assert.deepEqual(changes.map(({ sourceId, previousDeviceId, nextDeviceId }) => ({ sourceId, previousDeviceId, nextDeviceId })), [
    { sourceId: "climate.basement", previousDeviceId: 184, nextDeviceId: null },
    { sourceId: "device_tracker.wap", previousDeviceId: 2, nextDeviceId: 184 },
  ]);
  assert.ok(!db.queries.some(({ sql }) => /UPDATE|INSERT|DELETE/.test(sql)));
  await applyHomeAssistantRepairs(db, changes);
  assert.equal(db.queries.filter(({ sql }) => /UPDATE device_sources/.test(sql)).length, 2);
  await assert.rejects(applyHomeAssistantRepairs({ query: async () => ({ rowCount: 0 }) }, changes), /changed during repair/);
});
