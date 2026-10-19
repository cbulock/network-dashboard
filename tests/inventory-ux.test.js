import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFacts, matchesDeviceSearch, DEVICE_TYPES, classificationValue } from '../utils/inventory-model.js';
import { defaultInventoryFilters, restoreInventoryFilters, inventoryFiltersFromQuery, filterInventory, sortInventory } from '../utils/inventory-view.js';
import { sectionValues, sectionPayload, acceptSectionSave } from '../utils/device-presentation.js';
const now = Date.parse('2026-10-18T12:00:00Z');
const day = 86400000;
const row = { device_key: 'unifi:old', last_seen: new Date(now - 91 * day).toISOString(), sources: [] };

test('90-day history boundary retains configured, monitored, and unknown-age devices', () => {
  assert.equal(inventoryFacts(row, [], [], now).lifecycle.scope, 'history');
  assert.equal(inventoryFacts({ ...row, last_seen: new Date(now - 90 * day).toISOString() }, [], [], now).lifecycle.scope, 'current');
  for (const change of [{ keep_current: true }, { device_key: 'manual:one' }, { managed_hostname: 'configured' }, { sources: [{ source: 'uptime_kuma', status: 'down' }] }, { last_seen: null }, { last_seen: 'bad date' }])
    assert.equal(inventoryFacts({ ...row, ...change }, [], [], now).lifecycle.scope, 'current');
  assert.equal(inventoryFacts(row, [{ kind: 'managed_device', adopted: true }], [], now).lifecycle.scope, 'current');
  assert.equal(inventoryFacts(row, [], [{ names: ['configured'] }], now).lifecycle.scope, 'current');
  assert.equal(inventoryFacts(row, [{ active: true, kind: 'client' }], [], now).lifecycle.scope, 'history', 'a remembered controller client is not configuration');
  assert.equal(inventoryFacts(row, [{ use_fixedip: true, active: false }], [], now).lifecycle.scope, 'history');
});
test('old remembered fixed/static clients enter History unless explicitly retained', () => {
  const oldClient = { active: true, kind: 'client', connected: false, last_seen: Date.parse('2019-06-02T20:17:23Z') / 1000 };
  // A fresh collector import and an extant reservation do not mean the device
  // itself is current (Brett Laundry Button regression).
  const imported = { ...row, name: 'Brett Laundry Button', last_seen: new Date(now).toISOString() };
  for (const settings of [{ use_fixedip: true, fixed_ip: '10.0.3.124' }, { config_network: { type: 'static' } }]) {
    const records = [{ ...oldClient, ...settings }];
    const facts = inventoryFacts(imported, records, [], now);
    assert.equal(facts.lastSeen, '2019-06-02T20:17:23.000Z');
    assert.deepEqual(facts.lifecycle, { scope: 'history', configured: false, reason: 'Not seen for over 90 days' });
    assert.equal(inventoryFacts({ ...imported, keep_current: true }, records, [], now).lifecycle.reason, 'Kept in Current');
    assert.equal(inventoryFacts({ ...imported, sources: [{ source: 'uptime_kuma' }] }, records, [], now).lifecycle.scope, 'current');
    assert.equal(inventoryFacts(imported, [{ ...records[0], last_seen: (now - day) / 1000 }], [], now).lifecycle.scope, 'current');
  }
});
test('collector timestamps do not rejuvenate old network observations and new sightings restore Current', () => {
  assert.equal(inventoryFacts({ ...row, last_seen: new Date(now).toISOString() }, [{ last_seen: (now - 91 * day) / 1000 }], [], now).lifecycle.scope, 'history');
  assert.equal(inventoryFacts(row, [{ last_seen: (now - day) / 1000 }], [], now).lifecycle.scope, 'current');
});
test('classification uses explicit metadata and preserves corrections', () => {
  const record = { kind: 'managed_device', type: 'usw', model: 'USMINI' };
  assert.equal(inventoryFacts(row, [record], [], now).deviceType, 'Switch');
  assert.equal(inventoryFacts(row, [record], [], now).role, 'Infrastructure');
  const corrected = inventoryFacts({ ...row, device_type: 'Game console', device_role: 'Trusted' }, [record], [], now);
  assert.equal(corrected.deviceType, 'Game console'); assert.equal(corrected.role, 'Trusted');
  assert.equal(corrected.classification.suggestedType, 'Switch');
  assert.equal(inventoryFacts({ ...row, name: 'Nintendo Switch' }, [{ name: 'switch', kind: 'client', type: 'usw' }], [], now).deviceType, 'Unknown');
  assert.equal(classificationValue('', DEVICE_TYPES), null);
  assert.throws(() => classificationValue('Made up', DEVICE_TYPES));
});
test('health differentiates absent monitoring, unknown results and stale readings without changing connectivity', () => {
  assert.equal(inventoryFacts(row, [], [], now).monitoring.label, 'Not monitored');
  for (const [status, label] of [['up', 'Healthy'], ['down', 'Failing'], [null, 'Unknown']])
    assert.equal(inventoryFacts({ ...row, sources: [{ source: 'uptime_kuma', status, lastSeen: new Date(now).toISOString() }] }, [], [], now).monitoring.label, label);
  const stale = inventoryFacts({ ...row, sources: [{ source: 'uptime_kuma', status: 'up', lastSeen: new Date(now - 2 * day).toISOString() }] }, [], [], now);
  assert.equal(stale.monitoring.label, 'Unknown'); assert.equal(stale.lifecycle.scope, 'current');
  const mixed = inventoryFacts({ ...row, sources: [
    { source: 'uptime_kuma', status: 'down', lastSeen: new Date(now).toISOString() },
    { source: 'uptime_kuma', status: 'up', lastSeen: new Date(now - 2 * day).toISOString() },
  ] }, [], [], now);
  assert.equal(mixed.monitoring.label, 'Failing', 'stale data never hides a confirmed current failure');
  assert.equal(inventoryFacts({ ...row, sources: [{ source: 'uptime_kuma', status: 'up' }] }, [], [], now).monitoring.label, 'Unknown');
});
test('search handles aliases, secondary addresses, normalized MAC and literal punctuation', () => {
  const device = { name: 'Desktop', mac: 'aa:bb:cc:dd:ee:ff', allIps: ['10.0.0.2', '2001:db8::2'], dnsComparison: { records: [{ names: ['workstation.bulock'] }] } };
  for (const query of ['DESK', '10.0.0.2', '2001:db8', 'aa-bb-cc-dd-ee-ff', 'aabbcc', 'workstation.bulock']) assert.ok(matchesDeviceSearch(device, query), query);
  assert.equal(matchesDeviceSearch(device, '%'), false);
});
test('filters union within a category, intersect across categories, and keep stable sorting', () => {
  const devices = [
    { id: 1, name: 'Switch 10', deviceType: 'Switch', role: 'Infrastructure', vlans: [{ id: 1 }, { id: 2 }], monitoring: { label: 'Healthy' }, lifecycle: { scope: 'current' } },
    { id: 2, name: 'Switch 2', deviceType: 'Switch', role: 'Infrastructure', vlans: [{ id: 2 }], monitoring: { label: 'Failing' }, lifecycle: { scope: 'current' } },
    { id: 3, name: 'Phone', deviceType: 'Phone', role: 'Trusted', vlans: [], lifecycle: { scope: 'history' } },
  ];
  const filters = { ...defaultInventoryFilters(), networks: ['1', '2'], types: ['Switch'], health: ['Healthy', 'Failing'] };
  assert.deepEqual(sortInventory(filterInventory(devices, filters), filters).map(d => d.id), [2, 1]);
  assert.deepEqual(filterInventory(devices, { ...filters, health: ['Failing'] }).map(d => d.id), [2]);
  assert.deepEqual(filterInventory(devices, { ...defaultInventoryFilters(), scope: 'history', networks: ['none'] }).map(d => d.id), [3]);
});
test('saved filters validate and migrate without retaining a hidden source restriction', () => {
  const saved = restoreInventoryFilters({ vlanId: '2', status: 'offline', source: 'unifi', sortBy: 'bogus', tags: ['x', 4], types: null });
  assert.deepEqual(saved.networks, ['2']); assert.deepEqual(saved.health, ['Failing']);
  assert.deepEqual(saved.tags, ['x']); assert.equal(saved.sortBy, 'name'); assert.equal(saved.scope, 'current');
  assert.equal('source' in saved, false);
  assert.equal(defaultInventoryFilters(true).scope, 'all');
});
test('network links select exact VLAN or range membership across current and historical records', () => {
  const devices = [
    { id: 1, vlans: [{ id: 2 }], reservedRanges: [{ id: 7, ips: ['10.0.0.2'] }] },
    { id: 2, vlans: [{ id: 2 }], reservedRanges: [{ id: 8, ips: ['10.0.0.3'] }], lifecycle: { scope: 'history' } },
    { id: 3, vlans: [{ id: 3 }], reservedRanges: [] },
  ];
  assert.deepEqual(filterInventory(devices, inventoryFiltersFromQuery({ vlanId: '2' })).map(d => d.id), [1, 2]);
  const range = inventoryFiltersFromQuery({ reservedRangeId: '7' });
  assert.deepEqual(filterInventory(devices, range).map(d => d.id), [1]);
  assert.deepEqual(restoreInventoryFilters(range).ranges, ['7']);
  assert.deepEqual(filterInventory(devices, { ...range, ranges: ['7', '8'] }).map(d => d.id), [1, 2]);
  assert.deepEqual(filterInventory(devices, inventoryFiltersFromQuery({ reservedRangeId: '99' })), []);
  for (const query of [{}, { vlanId: 'invalid' }, { reservedRangeId: '-1' }, { vlanId: null }]) assert.equal(inventoryFiltersFromQuery(query), null);
});
test('classification corrections save only edited organization fields and accept their persisted result', () => {
  const baseline = sectionValues({ tags: [], classification: {} }, 'organization');
  const draft = { ...baseline, deviceType: 'Camera', role: 'IoT', keepCurrent: true };
  assert.deepEqual(sectionPayload('organization', draft, baseline), { deviceType: 'Camera', role: 'IoT', keepCurrent: true });
  const saved = acceptSectionSave({ primaryIp: '10.0.0.2' }, { primaryIp: 'old', deviceType: 'Camera', role: 'IoT', classification: { typeOverride: 'Camera' } }, 'organization');
  assert.equal(saved.primaryIp, '10.0.0.2'); assert.equal(saved.classification.typeOverride, 'Camera');
});
