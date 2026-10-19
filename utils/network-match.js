// Shared by inventory reads, collectors' inventory helpers, and the editor preview.
function parseAddress(value) {
  const address = String(value ?? "").trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const octets = address.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets;
  }
  if (!address.includes(":")) return null;

  // Expand an embedded IPv4 tail before expanding IPv6's zero compression.
  let expanded = address;
  if (address.includes(".")) {
    const tail = address.slice(address.lastIndexOf(":") + 1);
    const ipv4 = parseAddress(tail);
    if (!ipv4 || ipv4.length !== 4) return null;
    expanded = `${address.slice(0, address.lastIndexOf(":") + 1)}${(ipv4[0] * 256 + ipv4[1]).toString(16)}:${(ipv4[2] * 256 + ipv4[3]).toString(16)}`;
  }
  const halves = expanded.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return null;
  return groups.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >> 8, number & 255];
  });
}

export function compareIpAddresses(left, right) {
  const a = parseAddress(String(left ?? '').split('/')[0]);
  const b = parseAddress(String(right ?? '').split('/')[0]);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function matchVlanForIp(ip, vlans = []) {
  // Host masks may be present in Postgres INET output; membership uses the host.
  const address = parseAddress(String(ip ?? "").split("/")[0]);
  if (!address) return null;

  let best = null;
  let bestPrefix = -1;
  for (const vlan of vlans) {
    const parts = String(vlan.subnet ?? "").split("/");
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) continue;
    const network = parseAddress(parts[0]);
    const prefix = Number(parts[1]);
    if (!network || network.length !== address.length || prefix > address.length * 8) continue;
    const wholeBytes = Math.floor(prefix / 8);
    const remainingBits = prefix % 8;
    if (address.slice(0, wholeBytes).some((byte, index) => byte !== network[index])) continue;
    const mask = (255 << (8 - remainingBits)) & 255;
    if (remainingBits && (address[wholeBytes] & mask) !== (network[wholeBytes] & mask)) continue;
    if (prefix > bestPrefix || (prefix === bestPrefix && Number(vlan.vlanId) < Number(best.vlanId))) {
      best = vlan;
      bestPrefix = prefix;
    }
  }
  return best;
}

export function matchDeviceNetworks(primaryIp, ips, vlans) {
  const matches = new Map();
  for (const ip of [primaryIp, ...ips]) {
    const vlan = matchVlanForIp(ip, vlans);
    if (vlan) matches.set(vlan.id, vlan);
  }
  return [...matches.values()];
}

function addressNumber(address) {
  return address.reduce((number, byte) => (number << BigInt(8)) + BigInt(byte), BigInt(0));
}

export function normalizeIpRange(startIp, endIp) {
  const start = String(startIp ?? "").trim();
  const end = String(endIp ?? "").trim();
  const first = parseAddress(start);
  const last = parseAddress(end);
  if (!first || !last) throw new Error("Enter valid start and end IP addresses.");
  if (first.length !== last.length) throw new Error("Start and end IPs must use the same address family.");
  if (addressNumber(first) > addressNumber(last)) throw new Error("Start IP must be before or equal to end IP.");
  return { startIp: start, endIp: end };
}

export function ipInRange(ip, startIp, endIp) {
  const address = parseAddress(String(ip ?? "").split("/")[0]);
  const start = parseAddress(startIp);
  const end = parseAddress(endIp);
  if (!address || !start || !end || address.length !== start.length || start.length !== end.length) return false;
  const number = addressNumber(address);
  return number >= addressNumber(start) && number <= addressNumber(end);
}

export function matchVlanForRange(startIp, endIp, vlans = []) {
  try {
    normalizeIpRange(startIp, endIp);
  } catch {
    return null;
  }
  // Only networks containing the entire interval are eligible.
  return matchVlanForIp(startIp, vlans.filter((vlan) => matchVlanForIp(endIp, [vlan])));
}

export function matchReservedRangeForIp(ip, ranges = [], vlanId = null) {
  const matches = ranges.filter((range) => ipInRange(ip, range.startIp, range.endIp));
  // Narrower ranges win; equal ranges use the stable database ID.
  matches.sort((a, b) => {
    const sizeA = addressNumber(parseAddress(a.endIp)) - addressNumber(parseAddress(a.startIp));
    const sizeB = addressNumber(parseAddress(b.endIp)) - addressNumber(parseAddress(b.startIp));
    return sizeA < sizeB ? -1 : sizeA > sizeB ? 1 : a.id - b.id;
  });
  if (matches.length) return matches[0];
  // Preserve the legacy VLAN-only grouping for records without range rules.
  const legacy = ranges.filter((range) => !range.startIp && !range.endIp && vlanId != null && range.vlanId === vlanId);
  return legacy.length === 1 ? legacy[0] : null;
}

// Include every known address once, regardless of source or host-mask spelling.
export function getDeviceIps(device) {
  const addresses = new Map();
  for (const value of [
    device.primaryIp,
    ...(device.allIps ?? []),
    ...(device.discoveredIps ?? device.ips ?? []),
    ...(device.assignedIps ?? []).map((assignment) => assignment.ip),
  ]) {
    const ip = String(value ?? "").trim().split("/")[0];
    const address = parseAddress(ip);
    if (!address) continue;
    const key = `${address.length}:${addressNumber(address)}`;
    if (!addresses.has(key)) addresses.set(key, ip);
  }
  return [...addresses.values()];
}

export function getDeviceReservedRanges(device, ranges = []) {
  const matches = new Map();
  for (const ip of getDeviceIps(device)) {
    let range = matchReservedRangeForIp(ip, ranges);
    if (!range) {
      // Preserve explicit legacy grouping only for ranges without boundaries.
      const assignment = (device.assignedIps ?? []).find((row) =>
        ipInRange(row.ip, ip, ip),
      );
      const storedId = assignment?.reservedRangeId ?? assignment?.virtualSubnetId;
      range = ranges.find((candidate) => candidate.id === storedId && !candidate.startIp && !candidate.endIp);
    }
    if (!range) continue;
    if (!matches.has(range.id)) matches.set(range.id, { id: range.id, name: range.name, ips: [] });
    matches.get(range.id).ips.push(ip);
  }
  return [...matches.values()];
}

// Legacy labels and VLAN membership alone do not reserve an address for cleanup.
export function getUnreservedDeviceIps(device, ranges = []) {
  return getDeviceIps(device).filter(
    (ip) => !ranges.some((range) => ipInRange(ip, range.startIp, range.endIp)),
  );
}

export function rangesOverlap(a, b) {
  return ipInRange(a.startIp, b.startIp, b.endIp) || ipInRange(a.endIp, b.startIp, b.endIp)
    || ipInRange(b.startIp, a.startIp, a.endIp);
}

export function validateVlanSubnet(value) {
  const subnet = String(value ?? '').trim();
  if (!subnet) return null;
  const parts = subnet.split('/');
  const address = parseAddress(parts[0]);
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]) || !address || prefix > address.length * 8) {
    throw new Error('Enter a valid IPv4 or IPv6 network in CIDR notation.');
  }
  const hostBits = BigInt(address.length * 8 - prefix);
  if ((addressNumber(address) >> hostBits << hostBits) !== addressNumber(address)) {
    throw new Error('Use the network address for the VLAN subnet, without host bits.');
  }
  return subnet;
}

export function vlanSubnetsOverlap(a, b) {
  if (!a || !b) return false;
  return Boolean(matchVlanForIp(a.split('/')[0], [{ subnet: b }])
    || matchVlanForIp(b.split('/')[0], [{ subnet: a }]));
}
