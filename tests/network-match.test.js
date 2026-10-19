import assert from "node:assert/strict";
import test from "node:test";
import { matchVlanForIp, matchDeviceNetworks } from "../utils/network-match.js";

const vlans = [
  { id: 1, vlanId: 10, subnet: "192.168.0.0/16" },
  { id: 2, vlanId: 20, subnet: "192.168.10.0/24" },
  { id: 3, vlanId: 30, subnet: "2001:db8:abcd::/48" },
];

test("uses the most specific range regardless of lookup order", () => {
  assert.equal(matchVlanForIp("192.168.10.42", vlans)?.id, 2);
  assert.equal(matchVlanForIp("192.168.10.42", [...vlans].reverse())?.id, 2);
  assert.equal(matchVlanForIp("192.168.11.42", vlans)?.id, 1);
  assert.equal(matchVlanForIp("192.168.10.42/32", vlans)?.id, 2);
  assert.equal(matchVlanForIp("10.0.0.42", vlans), null);
});

test("handles IPv4 boundaries, partial bytes, /0, and host ranges", () => {
  const ranges = [{ id: 4, vlanId: 40, subnet: "10.0.0.128/25" }];
  assert.equal(matchVlanForIp("10.0.0.127", ranges), null);
  assert.equal(matchVlanForIp("10.0.0.128", ranges)?.id, 4);
  assert.equal(matchVlanForIp("10.0.0.255", ranges)?.id, 4);
  assert.equal(matchVlanForIp("10.0.1.0", ranges), null);
  assert.ok(matchVlanForIp("255.255.255.255", [{ vlanId: 1, subnet: "0.0.0.0/0" }]));
  assert.ok(matchVlanForIp("192.168.10.42", [{ vlanId: 1, subnet: "192.168.10.42/32" }]));
});

test("supports compressed, expanded, and embedded IPv4 forms of IPv6", () => {
  assert.equal(matchVlanForIp("2001:DB8:abcd::42", vlans)?.id, 3);
  assert.equal(matchVlanForIp("2001:0db8:abcd:0000:0000:0000:0000:0042", vlans)?.id, 3);
  assert.equal(matchVlanForIp("2001:db8:abce::42", vlans), null);
  assert.ok(matchVlanForIp("::ffff:192.168.10.42", [{ vlanId: 1, subnet: "::ffff:c0a8:a00/120" }]));
  assert.equal(matchVlanForIp("::ffff:192.168.10.42", vlans), null);
  assert.ok(matchVlanForIp("::1", [{ vlanId: 1, subnet: "::1/128" }]));
  assert.ok(matchVlanForIp("ffff::", [{ vlanId: 1, subnet: "::/0" }]));
});

test("leaves missing or malformed addresses and ranges unmatched", () => {
  for (const ip of [null, "", "host.local", "192.168..1", "192.168.0.256", ":::", "1::2::3", "2001:db8::xyz", "1:2:3:4:5:6:7", "::ffff:999.1.1.1"]) {
    assert.equal(matchVlanForIp(ip, vlans), null, String(ip));
  }
  for (const subnet of [null, "", "192.168.0.0", "192.168.0.0/", "192.168.0.0/-1", "192.168.0.0/33", "192.168.0.0/24/1", "::/129"]) {
    assert.equal(matchVlanForIp("192.168.10.42", [{ subnet }]), null, String(subnet));
  }
});

test("breaks equal-prefix ties by VLAN number and deduplicates membership", () => {
  const tie = { id: 4, vlanId: 5, subnet: "192.168.10.0/24" };
  assert.equal(matchVlanForIp("192.168.10.1", [...vlans, tie])?.id, 4);
  assert.deepEqual(matchDeviceNetworks("192.168.10.1", ["192.168.10.2", "2001:db8:abcd::1", "10.0.0.1"], vlans).map((vlan) => vlan.id), [2, 3]);
});
