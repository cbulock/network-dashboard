import assert from "node:assert/strict";
import test from "node:test";
import { getUnreservedDeviceIps } from "../utils/network-match.js";

const ranges = [
  { id: 1, startIp: "192.168.10.10", endIp: "192.168.10.50" },
  { id: 2, startIp: "2001:db8::10", endIp: "2001:db8::50" },
];

test("cleanup excludes devices without valid IP addresses", () => {
  for (const device of [{}, { primaryIp: null, allIps: [] }, {
    primaryIp: "host.local", allIps: ["", null, "192.168.10.256", ":::"]
  }]) {
    assert.deepEqual(getUnreservedDeviceIps(device, ranges), []);
  }
});

test("cleanup checks inclusive bounds across all ranges and address families", () => {
  const device = { allIps: [
    "192.168.10.9", "192.168.10.10/32", "192.168.10.50", "192.168.10.51",
    "2001:db8::f", "2001:db8::10/128", "2001:db8::50", "2001:db8::51",
  ] };
  assert.deepEqual(getUnreservedDeviceIps(device, ranges), [
    "192.168.10.9", "192.168.10.51", "2001:db8::f", "2001:db8::51",
  ]);
  assert.deepEqual(getUnreservedDeviceIps({ allIps: ["192.168.10.20", "2001:db8::20"] }, ranges), []);
});

test("cleanup includes secondary discovered and manual IPs even with a reserved primary", () => {
  const device = {
    primaryIp: "192.168.10.20",
    allIps: ["192.168.10.20", "192.168.10.60"],
    discoveredIps: ["192.168.10.60", "192.168.10.61"],
    assignedIps: [{ ip: "192.168.10.62/32", reservedRangeId: 1 }],
  };
  assert.deepEqual(getUnreservedDeviceIps(device, ranges), ["192.168.10.60", "192.168.10.61", "192.168.10.62"]);
  assert.deepEqual(getUnreservedDeviceIps({ ips: ["10.0.0.1"] }, ranges), ["10.0.0.1"]);
  assert.deepEqual(getUnreservedDeviceIps({ assignedIps: [{ ip: "10.0.0.2" }] }, ranges), ["10.0.0.2"]);
});

test("cleanup deduplicates host masks and equivalent IPv6 spellings", () => {
  assert.deepEqual(getUnreservedDeviceIps({
    primaryIp: " 10.0.0.1/32 ",
    allIps: ["10.0.0.1", "2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001/128"],
    assignedIps: [{ ip: "10.0.0.1/32" }],
  }, ranges), ["10.0.0.1", "2001:db8::1"]);
});

test("cleanup requires bounded ranges and recalculates when boundaries change", () => {
  const device = { primaryIp: "192.168.10.20", vlan: { id: 3 }, assignedIps: [
    { ip: "192.168.10.20", reservedRangeId: 4 },
  ] };
  for (const unbounded of [[], [{ id: 4, vlanId: 3 }], [{ startIp: "192.168.10.1" }]]) {
    assert.deepEqual(getUnreservedDeviceIps(device, unbounded), ["192.168.10.20"]);
  }
  assert.deepEqual(getUnreservedDeviceIps(device, ranges), []);
  assert.deepEqual(getUnreservedDeviceIps(device, [{ ...ranges[0], endIp: "192.168.10.19" }]), ["192.168.10.20"]);
});
