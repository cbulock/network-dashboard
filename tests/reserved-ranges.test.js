import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIpRange, ipInRange, matchVlanForRange, matchReservedRangeForIp, getDeviceReservedRanges } from "../utils/network-match.js";
import { createReservedRange, createVirtualSubnet, listInventoryLookups, listInventoryDevices, createInventoryDevice, ensureDeviceSchema } from "../scripts/device-registry.js";

const vlans = [
  { id: 1, vlanId: 10, name: "LAN", subnet: "192.168.0.0/16" },
  { id: 2, vlanId: 20, name: "Servers", subnet: "192.168.10.0/24" },
  { id: 3, vlanId: 30, name: "IPv6", subnet: "2001:db8::/32" },
];
const range = { id: 7, name: "Servers", startIp: "192.168.10.10", endIp: "192.168.10.50", vlanId: 999 };

function fixture() {
  return {
    queries: [],
    networks: vlans,
    ranges: [{ ...range }],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      const bindings = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(0, ...bindings), values.length);
      if (/FROM vlans/.test(sql)) return { rows: this.networks };
      if (/INSERT INTO virtual_subnets/.test(sql)) {
        const [slug, name, description, vlanId, isLogical, startIp, endIp] = values;
        this.ranges = [{ id: 7, slug, name, description, vlanId, isLogical, startIp, endIp }];
        return { rows: this.ranges };
      }
      if (/FROM virtual_subnets/.test(sql)) {
        if (/WHERE vlan_id =/.test(sql)) return { rows: this.ranges.filter((range) =>
          range.vlanId === values[0] && !range.startIp && !range.endIp,
        ) };
        return { rows: /family\(start_ip\)/.test(sql)
          ? this.ranges.filter((range) => ipInRange(values[0], range.startIp, range.endIp))
          : this.ranges };
      }
      if (/INSERT INTO devices/.test(sql)) return { rows: [{ id: 1 }] };
      if (/FROM devices d/.test(sql)) return { rows: [{
        id: 1, primary_ip: "192.168.10.20", unifi_records:[{ip:"192.168.10.20",kind:"client"}],
        assigned_ips: [
          { ip: "192.168.10.20", virtualSubnetId: null },
          { ip: "192.168.10.51", virtualSubnetId: 7, virtualSubnetName: "Old range" },
        ],
      }] };
      return { rows: [] };
    },
  };
}

test("range validation handles single addresses, whitespace, IPv6, and invalid bounds", () => {
  assert.deepEqual(normalizeIpRange(" 192.168.10.10 ", "192.168.10.10"), { startIp: "192.168.10.10", endIp: "192.168.10.10" });
  assert.ok(normalizeIpRange("2001:db8::1", "2001:db8::ffff"));
  for (const [start, end] of [
    ["", ""], ["192.168.10.256", "192.168.10.50"], ["host.local", "192.168.10.50"],
    ["192.168.10.10/24", "192.168.10.50"], ["192.168.10.51", "192.168.10.50"],
    ["192.168.10.10", "::1"], ["2001:db8::ff", "2001:db8::1"],
  ]) assert.throws(() => normalizeIpRange(start, end));
});

test("VLAN matching contains the entire interval and supports overlapping subnets", () => {
  assert.equal(matchVlanForRange(range.startIp, range.endIp, vlans).id, 2);
  assert.equal(matchVlanForRange("192.168.10.1", "192.168.11.1", vlans).id, 1);
  assert.equal(matchVlanForRange("192.168.10.1", "192.168.11.1", [vlans[1]]), null);
  assert.equal(matchVlanForRange("10.0.0.1", "10.0.0.10", vlans), null);
  assert.equal(matchVlanForRange("2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", vlans).id, 3);
  assert.equal(matchVlanForRange(range.endIp, range.startIp, vlans), null);
});

test("reserved matching includes boundaries and deterministically prefers narrower ranges", () => {
  for (const ip of [range.startIp, "192.168.10.20/32", range.endIp]) {
    assert.equal(matchReservedRangeForIp(ip, [range]).id, 7);
  }
  for (const ip of ["192.168.10.9", "192.168.10.51", "::1", "bad"]) {
    assert.equal(matchReservedRangeForIp(ip, [range], 999), null);
  }
  const narrow = { ...range, id: 8, endIp: "192.168.10.20" };
  const tie = { ...narrow, id: 4 };
  assert.equal(matchReservedRangeForIp("192.168.10.15", [range, narrow, tie]).id, 4);
  assert.ok(ipInRange("2001:db8::abcd", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"));
  const legacy = { id: 9, vlanId: 2 };
  assert.equal(matchReservedRangeForIp("192.168.10.100", [range, legacy], 2), legacy);
});

test("create persists both boundaries and ignores manual VLAN selections on both API helpers", async () => {
  for (const create of [createReservedRange, createVirtualSubnet]) {
    const db = fixture();
    db.ranges = [];
    const saved = await create(db, { ...range, vlanId: 999999 });
    assert.equal(saved.vlanId, 2);
    assert.equal(saved.startIp, range.startIp);
    assert.equal(saved.endIp, range.endIp);
    assert.equal(db.queries.some(({ values }) => values.includes(999999)), false);
    const write = db.queries.find(({ sql }) => /INSERT INTO/.test(sql));
    assert.doesNotMatch(write.sql, /ON CONFLICT/);
  }
  const saved = await createReservedRange(fixture(), { name: "Unmatched", startIp: "10.0.0.1", endIp: "10.0.0.50" });
  assert.equal(saved.vlanId, null);
  const db = fixture();
  await assert.rejects(createReservedRange(db, { name: "Missing boundaries" }), /valid start and end/);
  assert.equal(db.queries.length, 0);
});

test("lookups expose boundaries, rematch VLAN changes, and retain the legacy response alias", async () => {
  const db = fixture();
  const first = await listInventoryLookups(db);
  assert.equal(first.reservedRanges[0].vlanId, 2);
  assert.equal(first.reservedRanges[0].startIp, range.startIp);
  assert.deepEqual(first.virtualSubnets, first.reservedRanges);
  db.networks = [];
  assert.equal((await listInventoryLookups(db)).reservedRanges[0].vlanId, null);
});

test('range reads use UniFi addresses and exclude legacy manual assignments',async()=>{
 const db=fixture(); const [device]=await listInventoryDevices(db);
 assert.deepEqual(device.assignedIps,[]);
 assert.deepEqual(device.reservedRanges,[{id:7,name:'Servers',ips:['192.168.10.20']}]);
 assert.ok(db.queries.every(q=>!/INSERT|UPDATE|DELETE/.test(q.sql)));
});

test('local assignment writes are rejected before persistence',async()=>{
 const db=fixture(); await assert.rejects(createInventoryDevice(db,{displayName:'test',assignedIps:[{ip:'192.168.10.20'}]}),/managed in UniFi/);
 assert.equal(db.queries.length,0);
});

test("discovered devices in 10.0.0.30–39 match without manual assignments and rematch on refresh", async () => {
  const db = fixture();
  const reserved = { id: 8, name: "Network hardware", startIp: "10.0.0.30", endIp: "10.0.0.39" };
  db.ranges = [reserved];
  const originalQuery = db.query.bind(db);
  db.query = async (sql, values) => /FROM devices d/.test(sql)
    ? { rows: [
      { id: 1, primary_ip: "10.0.0.30/32", discovered_ips: ["10.0.0.30", "10.0.0.35"], unifi_records:[{kind:"client",ip:"10.0.0.30",ipv6_addresses:["10.0.0.35"]}], assigned_ips: [] },
      { id: 2, unifi_records:[{ip:"10.0.0.39",kind:"client"}], assigned_ips: [] },
      { id: 3, primary_ip: "10.0.0.29", discovered_ips: ["10.0.0.40"], assigned_ips: [] },
      { id: 4, dns_records: [{ ip: "10.0.0.34", names: ["switch.bulock"] }], assigned_ips: [] },
    ] }
    : originalQuery(sql, values);
  const devices = await listInventoryDevices(db);
  assert.deepEqual(devices.find(d => d.id === 1).reservedRanges, [
    { id: 8, name: reserved.name, ips: ["10.0.0.30", "10.0.0.35"] },
  ]);
  assert.deepEqual(devices.find(d => d.id === 2).reservedRanges[0].ips, ["10.0.0.39"]);
  assert.deepEqual(devices.find(d => d.id === 3).reservedRanges, []);
  assert.deepEqual(devices.find(d => d.id === 4).reservedRanges, []);
  assert.ok(devices.every(d => d.assignedIps.length === 0), "discovery must not create manual IP ownership");
  assert.equal(devices.reduce((sum, d) => sum + (d.reservedRanges[0]?.ips.length ?? 0), 0), 3);
  db.ranges = [{ ...reserved, startIp: "10.0.0.36" }];
  const refreshed = await listInventoryDevices(db);
  assert.deepEqual(refreshed.find(d => d.id === 1).reservedRanges, []);
  assert.deepEqual(refreshed.find(d => d.id === 2).reservedRanges[0].ips, ["10.0.0.39"]);
  assert.ok(db.queries.every(({ sql }) => !/INSERT|UPDATE|DELETE/.test(sql)));
});

test("device range membership deduplicates IPs, resolves overlaps, and preserves explicit legacy groups", () => {
  const broad = { id: 10, name: "Broad", startIp: "10.0.0.30", endIp: "10.0.0.39" };
  const narrow = { id: 11, name: "Narrow", startIp: "10.0.0.35", endIp: "10.0.0.36" };
  const ipv6 = { id: 12, name: "IPv6", startIp: "2001:db8::30", endIp: "2001:db8::39" };
  const legacy = { id: 13, name: "Legacy", vlanId: 1 };
  const ranges = [broad, narrow, ipv6, legacy];
  assert.deepEqual(getDeviceReservedRanges({
    primaryIp: "10.0.0.35/32",
    discoveredIps: ["10.0.0.35", "10.0.0.39", "2001:db8::30", "bad"],
    assignedIps: [
      { ip: "10.0.0.35", reservedRangeId: 10 },
      { ip: "10.0.0.31", virtualSubnetId: 11 },
      { ip: "2001:0db8:0000:0000:0000:0000:0000:0030/128" },
      { ip: "10.0.0.100", virtualSubnetId: 13 },
      { ip: "10.0.0.101", reservedRangeId: 10 },
    ],
  }, ranges), [
    { id: 11, name: "Narrow", ips: ["10.0.0.35"] },
    { id: 10, name: "Broad", ips: ["10.0.0.39", "10.0.0.31"] },
    { id: 12, name: "IPv6", ips: ["2001:db8::30"] },
    { id: 13, name: "Legacy", ips: ["10.0.0.100"] },
  ]);
  assert.deepEqual(getDeviceReservedRanges({}, ranges), []);
  assert.deepEqual(getDeviceReservedRanges({ primaryIp: "10.0.0.35" }, []), []);
  assert.deepEqual(getDeviceReservedRanges({ primaryIp: "10.0.0.100", vlan: { id: 1 } }, [legacy]), []);
});

test("schema upgrades add nullable boundaries without removing existing records", async () => {
  const db = fixture();
  await ensureDeviceSchema(db);
  assert.ok(db.queries.some(({ sql }) => /ALTER TABLE virtual_subnets ADD COLUMN IF NOT EXISTS start_ip INET/.test(sql)));
  assert.ok(db.queries.some(({ sql }) => /ALTER TABLE virtual_subnets ADD COLUMN IF NOT EXISTS end_ip INET/.test(sql)));
  assert.ok(db.queries.every(({ sql }) => !/^\s*(DROP|DELETE|TRUNCATE)\b/.test(sql)));
});
