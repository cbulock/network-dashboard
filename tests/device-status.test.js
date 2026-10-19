import assert from "node:assert/strict";
import test from "node:test";
import {
  createInventoryDevice,
  getInventoryDeviceDetails,
  listInventoryDevices,
  updateInventoryDevice,
  upsertDeviceFromSource,
} from "../scripts/device-registry.js";

function fixture(sources = []) {
  const row = { id: 1, device_key: "manual:router", name: "Router", status: "online", sources };
  return {
    row,
    queries: [],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      const bindings = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(0, ...bindings), values.length, "SQL bindings match placeholders");
      if (/FROM devices d/.test(sql) && /JOIN device_sources ds/.test(sql)) {
        return { rows: row.sources.some((source) => source.source === values[0] && source.sourceId === values[1]) ? [row] : [] };
      }
      if (/FROM devices d|SELECT \* FROM devices|SELECT id, device_key FROM devices/.test(sql)) return { rows: [row] };
      if (/INSERT INTO devices/.test(sql)) return { rows: [{ id: 1 }] };
      if (/INSERT INTO device_sources/.test(sql)) {
        const [source, sourceId, , , status] = values;
        row.sources = row.sources.filter((entry) => entry.source !== source || entry.sourceId !== sourceId);
        row.sources.push({ source, sourceId, status });
      }
      return { rows: [] };
    },
  };
}

test("inventory status ignores legacy/manual and other integration values", async () => {
  for (const sources of [[], [{ source: "unifi", status: "up" }], [{ source: "home_assistant", status: "down" }], [{ source: "uptime_kuma" }]]) {
    const db = fixture(sources);
    assert.equal((await listInventoryDevices(db))[0].status, "unknown");
    assert.equal((await getInventoryDeviceDetails(db, 1)).status, "unknown");
  }
});

test("Kuma readings exclusively determine health, including multiple mappings", async () => {
  for (const [readings, expected] of [
    [["up"], "up"], [["down"], "down"], [["unknown"], "unknown"],
    [["up", "down"], "down"], [["up", "up"], "up"], [["up", null], "unknown"],
  ]) {
    const db = fixture([
      { source: "home_assistant", status: "down" },
      ...readings.map((status) => ({ source: "uptime_kuma", status })),
    ]);
    assert.equal((await getInventoryDeviceDetails(db, 1)).status, expected);
  }
});

test("create and patch cannot persist supplied status or overwrite collector health", async () => {
  const db = fixture([{ source: "uptime_kuma", status: "down" }]);
  const payload = { displayName: "Renamed router", status: "up" };
  assert.equal((await createInventoryDevice(db, payload)).status, "down");
  assert.equal((await updateInventoryDevice(db, 1, payload)).status, "down");
  const writes = db.queries.filter(({ sql }) => /INSERT INTO devices|UPDATE devices/.test(sql));
  assert.equal(writes.length, 2);
  for (const { sql, values } of writes) {
    assert.doesNotMatch(sql, /\bstatus\b/);
    assert.ok(!values.includes("up"));
  }
});

test("collector order cannot replace Kuma status and refresh preserves source remapping", async () => {
  const db = fixture([{ source: "uptime_kuma", sourceId: "router-host", status: "down" }]);
  await upsertDeviceFromSource(db, {
    source: "uptime_kuma", sourceId: "router-host", name: "Different hostname", status: "up", rawData: { status: 1 },
  });
  assert.equal((await getInventoryDeviceDetails(db, 1)).status, "up");
  for (const source of ["unifi", "home_assistant"]) {
    await upsertDeviceFromSource(db, { source, sourceId: source, name: "Router", ips: ["192.0.2.1"], status: "down" });
    assert.equal((await getInventoryDeviceDetails(db, 1)).status, "up");
  }
  const inserts = db.queries.filter(({ sql }) => /INSERT INTO devices/.test(sql));
  assert.equal(inserts[0].values[0], "manual:router", "Kuma sync retains explicitly mapped device");
  assert.ok(inserts.every(({ sql }) => !/\bstatus\b/.test(sql)));
  const sourceWrites = db.queries.filter(({ sql }) => /INSERT INTO device_sources/.test(sql));
  assert.deepEqual(sourceWrites.map(({ values }) => values[4]), ["up", null, null]);
});
