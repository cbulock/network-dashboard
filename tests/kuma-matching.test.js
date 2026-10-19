import assert from "node:assert/strict";
import test from "node:test";
import { findDeviceByKumaHostname, findDeviceByKumaTarget, upsertDeviceFromSource } from "../scripts/device-registry.js";
import { normalizeHostname, normalizeKumaTarget } from "../scripts/source-identity.js";

test('Kuma targets distinguish bare IP literals from exact hostnames without guessing', () => {
  assert.deepEqual(normalizeKumaTarget(' 10.0.0.50 '), { kind: 'ip', value: '10.0.0.50' });
  assert.deepEqual(normalizeKumaTarget('2001:DB8::50'), { kind: 'ip', value: '2001:db8::50' });
  assert.deepEqual(normalizeKumaTarget(' NAS6. '), { kind: 'hostname', value: 'nas6' });
  for (const value of ['', 'https://10.0.0.50/', '10.0.0.50/24', '[2001:db8::50]', 'NAS 6'])
    assert.equal(normalizeKumaTarget(value), null);
});

test("Kuma hostname normalization accepts exact DNS names without guessing domains", () => {
  assert.equal(normalizeHostname(" Cameron-Desk.Switch. "), "cameron-desk.switch");
  for (const name of ["", "https://switch/", "10.0.0.35", "::1", "Desk Switch", "a..b"]) {
    assert.equal(normalizeHostname(name), null);
  }
  assert.equal(normalizeHostname("switch.bulock"), "switch.bulock");
});

function fixture({ candidates = [], previous = [] } = {}) {
  return {
    queries: [],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      const bindings = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(0, ...bindings), values.length);
      if (/jsonb_array_elements_text/.test(sql)) return { rows: candidates };
      if (/JOIN device_sources ds ON ds.device_id/.test(sql)) return { rows: previous };
      if (/SELECT id, device_key FROM devices/.test(sql)) return { rows: [{ id: 3618, device_key: values[0] }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test("hostname matching requires one device and never uses labels", async () => {
  const target = { id: 3618, device_key: "dns:switch" };
  assert.equal(await findDeviceByKumaHostname(fixture({ candidates: [target] }), "SWITCH."), target);
  assert.equal(await findDeviceByKumaHostname(fixture({ candidates: [target, { id: 2 }] }), "switch"), null);
  const db = fixture();
  assert.equal(await findDeviceByKumaHostname(db, "Desk Switch"), null);
  assert.equal(db.queries.length, 0);
});

test("Kuma refresh matches an existing monitor to DNS without renaming the physical device", async () => {
  const db = fixture({ candidates: [{ id: 3618, device_key: "dns:switch" }], previous: [{ id: 3579, device_key: "name:switch" }] });
  await upsertDeviceFromSource(db, { source: "uptime_kuma", sourceId: "switch", status: "up", rawData: { hostname: "SWITCH." } });
  const device = db.queries.find(({ sql }) => /INSERT INTO devices \(/.test(sql));
  assert.equal(device.values[0], "dns:switch");
  const source = db.queries.find(({ sql }) => /INSERT INTO device_sources/.test(sql));
  assert.equal(source.values[2], 3618);
  assert.equal(source.values[6], "hostname");
});

test("Kuma manual mappings survive hostname matches; ambiguous hosts retain their mapping", async () => {
  for (const manual of [true, false]) {
    const db = fixture({ candidates: manual ? [{ id: 8 }] : [{ id: 8 }, { id: 9 }], previous: [{ id: 3618, device_key: "manual:switch", link_method: manual ? "manual" : "source_id" }] });
    await upsertDeviceFromSource(db, { source: "uptime_kuma", sourceId: "switch", status: "down" });
    assert.equal(db.queries.find(({ sql }) => /INSERT INTO devices \(/.test(sql)).values[0], "manual:switch");
    assert.equal(db.queries.some(({ sql }) => /jsonb_array_elements_text/.test(sql)), !manual);
  }
});

test('IP targets match network identity on first import and replace existing automatic placeholders', async () => {
  for (const previous of [[], [{ id: 6879, device_key: 'uptime_kuma:10.0.0.50' }]]) {
    const target = { id: 1738, device_key: 'physical' };
    const db = fixture({ candidates: [target], previous });
    assert.equal(await findDeviceByKumaTarget(db, '10.0.0.50'), target);
    await upsertDeviceFromSource(db, { source: 'uptime_kuma', sourceId: '10.0.0.50', rawData: { hostname: '10.0.0.50' }, status: 'up' });
    assert.equal(db.queries.find(({ sql }) => /INSERT INTO devices \(/.test(sql)).values[0], 'physical');
    const source = db.queries.find(({ sql }) => /INSERT INTO device_sources/.test(sql));
    assert.equal(source.values[6], 'network_identity');
    assert.deepEqual(source.values[3].identity.ips, ['10.0.0.50']);
  }
});

test('IP matching preserves explicit mappings and does not guess between shared IP owners', async () => {
  for (const manual of [true, false]) {
    const db = fixture({ candidates: [{ id: 1 }, { id: 2 }], previous: [{ id: 6879,
      device_key: 'previous', link_method: manual ? 'manual' : 'source_id' }] });
    await upsertDeviceFromSource(db, { source: 'uptime_kuma', sourceId: '10.0.0.50', status: 'down' });
    assert.equal(db.queries.find(({ sql }) => /INSERT INTO devices \(/.test(sql)).values[0], 'previous');
    assert.equal(db.queries.some(({ sql }) => /jsonb_array_elements_text/.test(sql)), !manual);
  }
});
