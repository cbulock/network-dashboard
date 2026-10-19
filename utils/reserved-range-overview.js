import { compareIpAddresses } from './network-match.js';

const compare = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { numeric: true });

// Membership comes from the normalized inventory API, including secondary IPs
// and its deterministic overlap rules. Presentation never assigns IP ownership.
export function reservedRangeOverview(ranges = [], devices = []) {
  const groups = new Map(ranges.map(range => [String(range.id), { ...range, devices: [], ipCount: 0 }]));
  for (const device of devices) {
    for (const membership of device.reservedRanges || []) {
      const group = groups.get(String(membership.id));
      if (!group) continue;
      const ips = [...new Set(membership.ips || [])].sort(compareIpAddresses);
      if (!ips.length) continue;
      group.devices.push({ ...device, rangeIps: ips });
      group.ipCount += ips.length;
    }
  }
  return [...groups.values()].map(group => ({
    ...group,
    devices: group.devices.sort((a, b) => compareIpAddresses(a.rangeIps[0], b.rangeIps[0]) || compare(a.name, b.name) || compare(a.id, b.id)),
  })).sort((a, b) => (a.startIp ? b.startIp ? compareIpAddresses(a.startIp, b.startIp) : -1 : b.startIp ? 1 : 0) || compare(a.name, b.name));
}
