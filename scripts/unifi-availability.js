import { connectUnifi, readInventory, assignmentFor, availableAddresses, dnsComparison, problem, ACTIVE_IP_STATES, siteName } from './unifi-platform.js';
import { normalizeSourceIps } from './source-identity.js';

// Availability reads never import inventory. Coalesce controller reads and reuse
// them briefly across range selections; writes always request a new snapshot.
export function createSnapshotCache(read, { now = Date.now, ttl = 20000 } = {}) {
  let cached, expires = 0, pending, generation = 0;
  return {
    get({ fresh = false } = {}) {
      if (!fresh && cached && now() < expires) return Promise.resolve(cached);
      if (!fresh && pending) return pending;
      const ticket = ++generation;
      const request = Promise.resolve().then(read).then(value => {
        if (ticket === generation) { cached = value; expires = now() + ttl; }
        return value;
      }).catch(error => {
        if (ticket === generation) { cached = null; expires = 0; }
        throw error;
      }).finally(() => { if (pending === request) pending = null; });
      pending = request;
      return request;
    },
  };
}

let controllerKey, controllerCache;
export function availabilitySnapshot(options) {
  const key = `${process.env.UNIFI_HOST}|${process.env.UNIFI_USER}|${siteName()}`;
  if (!controllerCache || key !== controllerKey) {
    controllerKey = key;
    controllerCache = createSnapshotCache(async () => readInventory(await connectUnifi()));
  }
  return controllerCache.get(options);
}

export function deviceFromSnapshot(device, snapshot) {
  const record = device.mac ? snapshot.records.find(row => row.device.mac?.toLowerCase() === device.mac.toLowerCase())?.device : null;
  const assignment = assignmentFor(record, snapshot.networks);
  const macs = device.macs || [device.mac];
  const ips = normalizeSourceIps(assignment.ips, snapshot.records
    .filter(row => macs.includes(row.device.mac?.toLowerCase()))
    .flatMap(row => [row.device.ip, ...(row.device.ipv6_addresses || [])]));
  return {
    ...device,
    allIps: ips,
    ips,
    discoveredIps: ips,
    primaryIp: ips.find(ip => !ip.includes(':')) || ips[0] || null,
    unifi: { ...assignment, checkedAt: snapshot.checkedAt, error: null, operation: device.unifi?.operation || null },
    dnsComparison: dnsComparison({ hostname: device.hostname, records: device.dns.records, ips,
      dnsError: device.dns.error, lastSync: device.dns.lastSync, unifiSync: snapshot.checkedAt,
      operation: device.dns.operation, ipOperation: device.unifi?.operation }),
  };
}

export async function getIpAvailability(db, device, snapshot, input = {}) {
  const offset = Number(input.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw problem('Invalid address page.');
  const { rows: ranges } = await db.query('SELECT id,name,host(start_ip) AS "startIp",host(end_ip) AS "endIp" FROM virtual_subnets ORDER BY name');
  const { rows: pending } = await db.query('SELECT mac,host(ip) AS ip FROM unifi_ip_jobs WHERE state=ANY($1::text[])', [ACTIVE_IP_STATES]);
  const liveDevice = deviceFromSnapshot(device, snapshot);
  const choices = ranges.map(range => {
    try {
      const page = availableAddresses(snapshot, liveDevice.unifi, device.mac, range, pending);
      return { ...range, compatible: true, total: page.total, availability: page };
    } catch (error) { return { ...range, compatible: false, reason: error.message }; }
  });
  const range = ranges.find(row => row.id === Number(input.rangeId));
  if (input.rangeId && !range) throw problem('Reserved range not found.', 404);
  return { device: liveDevice, ranges: choices, checkedAt: snapshot.checkedAt,
    ...(range ? availableAddresses(snapshot, liveDevice.unifi, device.mac, range, pending, offset)
      : { addresses: [], total: 0, offset: 0, nextOffset: null }) };
}
