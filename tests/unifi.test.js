import assert from "node:assert/strict";
import test from "node:test";
import { fetchUnifiRecords, normalizeUnifiRecord, syncUnifiRecords } from "../scripts/fetch-unifi.js";

test("UniFi fetch combines clients and managed devices for the configured site", async () => {
  const calls = [];
  const client = { async get(url) {
    calls.push(url);
    return { data: { meta: { rc: "ok" }, data: [{ _id: url.endsWith("/sta") ? "client" : "switch" }] } };
  } };
  assert.deepEqual(await fetchUnifiRecords(client, "custom site"), [
    { device: { _id: "client" }, kind: "client" },
    { device: { _id: "switch" }, kind: "managed_device" },
  ]);
  assert.deepEqual(calls, ["/proxy/network/api/s/custom%20site/stat/sta", "/proxy/network/api/s/custom%20site/stat/device"]);
});

test("failed or malformed managed inventory cannot write a partial client import", async () => {
  for (const response of [new Error("Forbidden"), { meta: { rc: "error" }, data: [] }, { meta: { rc: "ok" } }]) {
    const client = { async get(url) {
      if (url.endsWith("/sta")) return { data: { meta: { rc: "ok" }, data: [{ mac: "00:11:22:33:44:55" }] } };
      if (response instanceof Error) throw response;
      return { data: response };
    } };
    let queries = 0;
    await assert.rejects(syncUnifiRecords({ query: async () => { queries++; } }, client));
    assert.equal(queries, 0);
  }
});

test("managed switch retains its own identity and metadata without management secrets", () => {
  const record = normalizeUnifiRecord({
    _id: "switch-id", mac: "74-83-C2-F7-CA-FF", ip: "10.0.0.35", name: "Desk Switch",
    hostname: "default-hostname", type: "usw", model: "USMINI", version: "2.1", adopted: true,
    state: 1, last_seen: 1700000000, x_authkey: "secret", x_ssh_hostkey_fingerprint: "secret",
    config_network: { password: "secret" }, uplink: { mac: "00:11:22:33:44:55", ip: "10.0.0.1" },
  }, "managed_device");
  assert.equal(record.source.sourceId, "switch-id");
  assert.equal(record.source.mac, "74:83:c2:f7:ca:ff");
  assert.equal(record.source.ip, "10.0.0.35");
  assert.equal(record.source.name, "Desk Switch");
  assert.equal(record.source.rawData.kind, "managed_device");
  assert.equal(record.source.rawData.model, "USMINI");
  assert.equal(record.source.lastSeen.toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(record.source.status, undefined);
  assert.ok(!JSON.stringify(record).includes("secret"));
  assert.ok(!JSON.stringify(record).includes("10.0.0.1"));
});

test("client IDs, names, MAC fallback, and Wi-Fi metadata remain available", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  const record = normalizeUnifiRecord({ mac: "00:11:22:33:44:55", hostname: "laptop", name: "alias", ip: "invalid", is_wired: false, essid: "Home", signal: -40 }, "client", now);
  assert.equal(record.source.sourceId, "00:11:22:33:44:55");
  assert.equal(record.source.name, "laptop");
  assert.equal(record.source.ip, null);
  assert.equal(record.source.lastSeen, now);
  assert.equal(record.source.rawData.essid, "Home");
  assert.equal(record.source.rawData.signal, -40);
  assert.equal(record.source.rawData.kind, "client");
  assert.equal(normalizeUnifiRecord({ name: "Unknown", mac: "invalid", ap_mac: "00:11:22:33:44:55" }, "client"), null);
});
