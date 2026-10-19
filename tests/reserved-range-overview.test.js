import test from 'node:test';
import assert from 'node:assert/strict';
import { reservedRangeOverview } from '../utils/reserved-range-overview.js';

test('overview keeps empty ranges, sorts by address, and groups each device once per range', () => {
  const ranges = [
    { id: 2, name: 'Servers', startIp: '10.0.0.100', endIp: '10.0.0.110' },
    { id: 1, name: 'Switches', startIp: '10.0.0.2', endIp: '10.0.0.20' },
    { id: 3, name: 'Empty', startIp: '10.0.0.200', endIp: '10.0.0.210' },
  ];
  const devices = [
    { id: 1, displayName: 'Multiple addresses', hostname: 'switch', mac: 'aa:bb:cc:dd:ee:ff', primaryIp: '10.0.0.250', reservedRanges: [
      { id: 1, ips: ['10.0.0.10', '10.0.0.3', '10.0.0.3'] },
      { id: 2, ips: ['10.0.0.101'] },
    ] },
    { id: 2, lifecycle: { scope: 'history' }, reservedRanges: [{ id: 1, ips: ['10.0.0.2'] }] },
    { id: 3, reservedRanges: [{ id: 1, ips: [] }, { id: 999, ips: ['10.0.0.9'] }] },
    { id: 4 },
  ];
  const before = JSON.stringify({ ranges, devices });
  const groups = reservedRangeOverview(ranges, devices);
  assert.deepEqual(groups.map(group => group.id), [1, 2, 3]);
  assert.deepEqual(groups[0].devices.map(device => device.id), [2, 1]);
  assert.deepEqual(groups[0].devices[1].rangeIps, ['10.0.0.3', '10.0.0.10']);
  assert.equal(groups[0].devices[1].hostname, 'switch');
  assert.equal(groups[0].ipCount, 3);
  assert.deepEqual(groups[1].devices[0].rangeIps, ['10.0.0.101']);
  assert.deepEqual(groups[2].devices, []);
  assert.equal(groups[2].ipCount, 0);
  assert.equal(JSON.stringify({ ranges, devices }), before);
});

test('overview handles missing data, string lookup IDs, and unbounded legacy groups', () => {
  assert.deepEqual(reservedRangeOverview(), []);
  const groups = reservedRangeOverview([{ id: 1, name: 'Legacy' }], [
    { id: 1, reservedRanges: [{ id: '1', ips: ['2001:db8::1'] }] },
  ]);
  assert.deepEqual(groups[0].devices[0].rangeIps, ['2001:db8::1']);
});

test('overview sorts IPv6 by address value, including compressed forms', () => {
  const [group] = reservedRangeOverview([{ id: 1 }], [
    { id: 1, reservedRanges: [{ id: 1, ips: ['2001:db8::100', '2001:db8::ff', '2001:db8::a'] }] },
    { id: 2, reservedRanges: [{ id: 1, ips: ['2001:db8:0:0:0:0:0:2'] }] },
  ]);
  assert.deepEqual(group.devices.map(device => device.id), [2, 1]);
  assert.deepEqual(group.devices[1].rangeIps, ['2001:db8::a', '2001:db8::ff', '2001:db8::100']);
});
