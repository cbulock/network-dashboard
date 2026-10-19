import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMacHardware } from '../scripts/mac-hardware.js';
import { parseCsv } from '../scripts/update-mac-vendors.js';

const database = {
  updatedAt: '2026-10-18T00:00:00.000Z',
  entries: {
    '001122': ['Large vendor', 'Large address', 'MA-L'],
    '0011223': ['Medium vendor', 'Medium address', 'MA-M'],
    '001122334': ['Small vendor', 'Small address', 'MA-S'],
    '0050C2001': ['Legacy vendor', '', 'IAB'],
    '021122': ['Must not match private MAC', '', 'MA-L'],
  },
};

test('longest IEEE assignment wins across 24, 28 and 36 bit prefixes', () => {
  for (const [mac, vendor, prefix] of [
    ['00:11:22:AA:BB:CC', 'Large vendor', '00:11:22:00:00:00/24'],
    ['00-11-22-3a-bb-cc', 'Medium vendor', '00:11:22:30:00:00/28'],
    ['001122334455', 'Small vendor', '00:11:22:33:40:00/36'],
    ['00:50:c2:00:1f:ff', 'Legacy vendor', '00:50:C2:00:10:00/36'],
  ]) {
    const hardware = resolveMacHardware(mac, database);
    assert.equal(hardware.manufacturer, vendor);
    assert.equal(hardware.prefix, prefix);
    assert.equal(hardware.updatedAt, database.updatedAt);
  }
});

test('private, group and placeholder addresses do not claim a manufacturer', () => {
  for (const [mac, type] of [
    ['02:11:22:33:44:55', 'Locally administered (private or virtual)'],
    ['01:11:22:33:44:55', 'Multicast'],
    ['ff:ff:ff:ff:ff:ff', 'Broadcast'],
    ['00:00:00:00:00:00', 'Unspecified'],
  ]) {
    const hardware = resolveMacHardware(mac, database);
    assert.equal(hardware.addressType, type);
    assert.equal(hardware.manufacturer, null);
    assert.equal(hardware.prefix, null);
  }
});

test('missing/invalid and unregistered MACs are handled without invented hardware', () => {
  for (const value of [null, '', 'invalid', '00:11:22:33:44']) assert.equal(resolveMacHardware(value), null);
  const unknown = resolveMacHardware('00:99:88:77:66:55', database);
  assert.equal(unknown.manufacturer, null);
  assert.equal(unknown.addressType, 'Universally administered');
});

test('bundled IEEE snapshot resolves an established allocation', () => {
  const hardware = resolveMacHardware('00:00:0c:00:00:01');
  assert.match(hardware.manufacturer, /Cisco/i);
  assert.equal(hardware.registry, 'MA-L');
  assert.ok(hardware.registeredAddress);
});

test('IEEE CSV parser preserves commas, escaped quotes, CRLF and multiline UTF-8 addresses', () => {
  assert.deepEqual(parseCsv('Registry,Assignment,Organization Name,Organization Address\r\nMA-L,001122,"Café, ""Inc""","First line\r\nSecond line"\r\n'), [
    ['Registry', 'Assignment', 'Organization Name', 'Organization Address'],
    ['MA-L', '001122', 'Café, "Inc"', 'First line\r\nSecond line'],
  ]);
  assert.throws(() => parseCsv('"truncated'), /Incomplete/);
});
