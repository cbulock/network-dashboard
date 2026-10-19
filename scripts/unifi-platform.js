import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { normalizeMac, normalizeSourceIps } from './source-identity.js';
import { matchVlanForIp } from '../utils/network-match.js';

export const ACTIVE_IP_STATES = ['pending', 'applying', 'waiting', 'dns_pending', 'dns_failed'];
export const siteName = () => process.env.UNIFI_SITE || 'default';
export function unifiUrl() {
  try { const url=new URL(process.env.UNIFI_HOST); return ['http:','https:'].includes(url.protocol) ? `${url.origin}/network/${encodeURIComponent(siteName())}/clients` : null; } catch { return null; }
}
export const unifiPath = (path, site = siteName()) => `/proxy/network/api/s/${encodeURIComponent(site)}/${path}`;
export const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, statusMessage: message });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export const settingsRevision = value => createHash('sha256').update(JSON.stringify(canonical(
  value?.config?.type === 'dhcp' ? {...value,config:{type:'dhcp'}} : value
))).digest('hex');

export async function connectUnifi() {
  if (!process.env.UNIFI_HOST || !process.env.UNIFI_USER || !process.env.UNIFI_PASS) throw problem('UniFi connection is not configured.', 503);
  const client = wrapper(axios.create({ baseURL: process.env.UNIFI_HOST, jar: new CookieJar(), withCredentials: true, timeout: 15000 }));
  try {
    const response = await client.post('/api/auth/login', { username: process.env.UNIFI_USER, password: process.env.UNIFI_PASS });
    const token = response.headers['x-csrf-token'];
    if (token) client.defaults.headers.common['X-CSRF-Token'] = token;
    return client;
  } catch { throw problem('Unable to sign in to UniFi. Check the server connection and account permissions.', 502); }
}

export async function readUnifi(client, path, site) {
  try {
    const { data } = await client.get(unifiPath(path, site));
    if (data?.meta?.rc !== 'ok' || !Array.isArray(data.data)) throw new Error();
    return data.data;
  } catch { throw problem(`Unable to read UniFi ${path}. No settings were changed.`, 502); }
}

export const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export function safeNetwork(network) {
  return pick(network, ['_id', 'name', 'vlan', 'purpose', 'ip_subnet', 'dhcpd_enabled', 'dhcpd_start', 'dhcpd_stop', 'dhcpd_gateway', 'dhcpd_gateway_enabled', 'dhcpd_dns_1', 'dhcpd_dns_2']);
}
export function safeRecord(record, kind) {
  const result = pick(record, ['_id', 'mac', 'ip', 'last_ip', 'ipv6_addresses', 'name', 'hostname', 'type', 'model', 'version', 'adopted', 'state', 'last_seen', 'uptime', 'is_wired', 'ap_mac', 'essid', 'signal', 'use_fixedip', 'fixed_ip', 'network_id', 'last_connection_network_id', 'mgmt_network_id', 'connection_network_id', 'connected', 'userId']);
  result.kind = kind;
  if (typeof record.device_type === 'string') result.device_type = record.device_type;
  if (record.config_network) result.config_network = pick(record.config_network, ['type', 'ip', 'netmask', 'gateway', 'dns1', 'dns2', 'dnssuffix']);
  return result;
}

export async function readInventory(client, site = siteName()) {
  const [clients, devices, users, networks] = await Promise.all(['stat/sta', 'stat/device', 'rest/user', 'rest/networkconf'].map(path => readUnifi(client, path, site)));
  const online = new Map(clients.map(row => [normalizeMac(row.mac), row]));
  const known = new Map(users.map(row => [normalizeMac(row.mac), row]));
  const hardware = new Set(devices.map(row => normalizeMac(row.mac)));
  const records = [];
  for (const mac of new Set([...online.keys(), ...known.keys()])) {
    if (!mac || hardware.has(mac)) continue;
    const user = known.get(mac), active = online.get(mac);
    records.push({ device: safeRecord({ ...user, ...active, _id: user?._id || active?._id, userId: user?._id, ip: active?.ip || user?.last_ip, connected: normalizeSourceIps(active?.ip).length > 0 }, 'client'), kind: 'client' });
  }
  for (const row of devices) records.push({ device: safeRecord({ ...row, connected: row.state === 1 }, 'managed_device'), kind: 'managed_device' });
  return { site, records, networks: networks.map(safeNetwork), checkedAt: new Date().toISOString() };
}

export async function ensureUnifiSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS unifi_inventory_state (
    id INTEGER PRIMARY KEY CHECK(id=1), site TEXT NOT NULL, networks JSONB NOT NULL DEFAULT '[]', last_sync TIMESTAMPTZ, error TEXT);
    CREATE TABLE IF NOT EXISTS unifi_ip_jobs (
      id UUID PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id), site TEXT NOT NULL,
      mac TEXT NOT NULL, desired JSONB NOT NULL, baseline JSONB NOT NULL, ip INET,
      hostname TEXT, old_ip INET, dns_revision TEXT, dns_job_id UUID,
      state TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE unifi_ip_jobs ADD COLUMN IF NOT EXISTS dns_from INET;
    CREATE UNIQUE INDEX IF NOT EXISTS unifi_one_active_device ON unifi_ip_jobs(device_id)
      WHERE state IN ('pending','applying','waiting','dns_pending','dns_failed');
    CREATE UNIQUE INDEX IF NOT EXISTS unifi_one_active_address ON unifi_ip_jobs(site,ip)
      WHERE state IN ('pending','applying','waiting','dns_pending','dns_failed');`);
}

export function assignmentFor(record, networks = []) {
  if (!record) return { mode: 'unknown', ips: [], configuredIp: null, editable: false, reason: 'No device record reported by UniFi.', revision: null };
  const ips = normalizeSourceIps(record.ip, record.ipv6_addresses);
  const id = record.network_id || record.connection_network_id || record.mgmt_network_id || record.last_connection_network_id;
  const network = networks.find(n => n._id === id) || matchVlanForIp(ips[0], networks.map(n => ({ ...n, subnet: n.ip_subnet })));
  const managed = record.kind === 'managed_device';
  const config = record.config_network;
  const mode = managed ? config?.type === 'static' ? 'static' : config?.type === 'dhcp' ? 'automatic' : 'unknown'
    : record.use_fixedip === true ? 'fixed' : record.use_fixedip === false ? 'automatic' : 'unknown';
  const settings = managed ? { kind: record.kind, id: record._id, config: config || null, networkId: network?._id || null }
    : { kind: 'client', id: record.userId || null, fixed: Boolean(record.use_fixedip), ip: record.use_fixedip ? record.fixed_ip || null : null, networkId: record.network_id || network?._id || null };
  const editable = Boolean(network?.ip_subnet && (managed ? ['uap', 'usw'].includes(record.type) && ['static','dhcp'].includes(config?.type) && record.adopted === true : record.userId && typeof record.use_fixedip === 'boolean'));
  const seen = new Date(Number(record.last_seen) * 1000);
  return { mode, ips, configuredIp: mode === 'static' ? config.ip || null : mode === 'fixed' ? record.fixed_ip || null : null,
    network: network || null, lastSeen: Number(record.last_seen) > 0 && !Number.isNaN(seen.getTime()) ? seen.toISOString() : null,
    connected: record.connected === true, editable, reason: editable ? null : 'This device does not expose supported IP settings. Manage it in UniFi.',
    settings, revision: settingsRevision(settings), kind: record.kind };
}

export function dnsComparison({ hostname, records = [], ips = [], unifiError, dnsError, lastSync, unifiSync, operation, ipOperation }) {
  const normalize = value => String(value || '').toLowerCase().replace(/\.$/, '');
  const managed = hostname ? records.filter(r => r.names.some(name => normalize(name) === normalize(hostname))) : [];
  const mismatches = managed.filter(r => !ips.includes(r.ip));
  let state = !ips.length || !lastSync || !unifiSync || unifiError || dnsError ? 'unknown' : !managed.length ? 'missing' : mismatches.length ? 'mismatch' : 'matched';
  if (operation?.state === 'failed' || ipOperation?.state === 'dns_failed') state = 'failed';
  else if (['pending','deploying'].includes(operation?.state) || ipOperation?.state === 'dns_pending') state = 'pending';
  return { state, hostname: hostname || null, unifiIps: ips, records: managed, mismatches, lastSync, unifiSync,
    error: unifiError || dnsError || operation?.error || ipOperation?.error || null,
    hasMismatch: Boolean(ips.length && lastSync && unifiSync && !unifiError && !dnsError && mismatches.length) };
}

export const ipv4Number = ip => isIP(ip) === 4 ? ip.split('.').reduce((value, part) => value * 256 + Number(part), 0) : null;
export const numberIp = n => [24,16,8,0].map(shift => Math.floor(n / 2 ** shift) % 256).join('.');
export function subnetBounds(subnet) {
  const [address, prefix] = String(subnet || '').split('/');
  const n = ipv4Number(address), bits = Number(prefix);
  if (n === null || prefix === undefined || !Number.isInteger(bits) || bits < 1 || bits > 30) throw problem('UniFi network does not expose a supported IPv4 subnet.');
  const size = 2 ** (32 - bits), start = Math.floor(n / size) * size;
  return { start, end: start + size - 1, gateway: address, netmask: numberIp(2 ** 32 - size) };
}

export function addressConflicts(snapshot, mac, pending = []) {
  const blocked = new Map();
  for (const { device } of snapshot.records) {
    if (normalizeMac(device.mac) === normalizeMac(mac)) continue;
    for (const ip of normalizeSourceIps(device.ip, device.connected ? device.last_ip : null,
      device.use_fixedip ? device.fixed_ip : null, device.config_network?.type === 'static' ? device.config_network.ip : null)) blocked.set(ip, 'In use or reserved in UniFi');
  }
  for (const n of snapshot.networks) {
    const gateway = n.ip_subnet?.split('/')[0];
    for (const ip of [gateway, n.dhcpd_gateway]) if (isIP(ip || '') === 4) blocked.set(ip, 'Network gateway');
  }
  for (const row of pending) if (normalizeMac(row.mac) !== normalizeMac(mac) && row.ip) blocked.set(row.ip.split('/')[0], 'Assignment in progress');
  return blocked;
}

export function availableAddresses(snapshot, assignment, mac, range, pending = [], offset = 0) {
  const bounds = subnetBounds(assignment.network?.ip_subnet);
  const start = ipv4Number(range?.startIp), end = ipv4Number(range?.endIp);
  if (start === null || end === null || start > end || start <= bounds.start || end >= bounds.end) throw problem('This range is not contained in the device’s UniFi network.');
  const blocked = addressConflicts(snapshot, mac, pending);
  // Count by subtracting conflicts rather than enumerating potentially huge ranges.
  const unavailable = [...blocked.keys()].map(ipv4Number).filter(n => n !== null && n >= start && n <= end);
  const total = end - start + 1 - unavailable.length;
  const addresses = []; let skipped = 0;
  for (let n = start; n <= end && addresses.length < 50; n++) {
    const ip = numberIp(n);
    if (blocked.has(ip)) continue;
    if (skipped++ < offset) continue;
    addresses.push({ ip, current: assignment.ips.includes(ip), reserved: assignment.configuredIp === ip });
  }
  return { addresses, total, offset, nextOffset: offset + addresses.length < total ? offset + addresses.length : null, checkedAt: snapshot.checkedAt };
}

export function desiredSettings(assignment, mode, ip, snapshot, mac, pending = []) {
  if (!assignment.editable) throw problem(assignment.reason, 409);
  if (!['automatic', 'fixed'].includes(mode)) throw problem('Select Automatic or Fixed IP.');
  if (mode === 'fixed') {
    const bounds = subnetBounds(assignment.network.ip_subnet), n = ipv4Number(ip);
    if (n === null || n <= bounds.start || n >= bounds.end) throw problem('Choose a host IPv4 address inside this device’s UniFi network.');
    if (addressConflicts(snapshot, mac, pending).has(ip)) throw problem('This address is already in use or reserved.', 409);
  } else if (!assignment.network.dhcpd_enabled) throw problem('DHCP is not enabled on this UniFi network.');
  if (assignment.kind === 'client') return { ...assignment.settings, fixed: mode === 'fixed', ip: mode === 'fixed' ? ip : null };
  const config = { ...assignment.settings.config, type: mode === 'fixed' ? 'static' : 'dhcp' };
  if (mode === 'fixed') Object.assign(config, { ip, netmask: subnetBounds(assignment.network.ip_subnet).netmask,
    gateway: config.gateway || assignment.network.dhcpd_gateway || assignment.network.ip_subnet.split('/')[0],
    dns1: config.dns1 || assignment.network.dhcpd_dns_1 || assignment.network.ip_subnet.split('/')[0] });
  return { ...assignment.settings, config };
}

export async function writeSettings(client, settings, site) {
  const managed = settings.kind === 'managed_device';
  const payload = managed ? { config_network: settings.config } : { use_fixedip: settings.fixed, ...(settings.fixed ? { fixed_ip: settings.ip, network_id: settings.networkId } : {}) };
  const { data } = await client.put(unifiPath(`rest/${managed ? 'device' : 'user'}/${encodeURIComponent(settings.id)}`, site), payload);
  if (data?.meta?.rc !== 'ok') throw problem('UniFi did not confirm the update. Refresh to reconcile its settings.', 502);
}

export async function rebuildIpProjection(db) {
  // Idempotent: retain legacy/manual evidence but never use it as current ownership.
  await db.query(`UPDATE devices d SET ips=ARRAY(
    SELECT DISTINCT address::inet FROM device_sources s,
      LATERAL jsonb_array_elements_text(COALESCE(s.raw_data#>'{identity,ips}', '[]'::jsonb)) address
    WHERE s.source='unifi' AND s.device_id=d.id AND COALESCE(s.raw_data->>'active','true')='true'), primary_ip=NULL`);
}

export async function enqueueIpChange(db, device, snapshot, input) {
  const record = snapshot.records.find(r => normalizeMac(r.device.mac) === normalizeMac(device.mac))?.device;
  const assignment = assignmentFor(record, snapshot.networks);
  if (!input.expectedRevision || assignment.revision !== input.expectedRevision) throw problem('UniFi settings changed. Refresh before applying.', 409);
  const { rows: pending } = await db.query(`SELECT mac,host(ip) AS ip FROM unifi_ip_jobs WHERE state=ANY($1::text[])`, [ACTIVE_IP_STATES]);
  const desired = desiredSettings(assignment, input.mode, input.ip, snapshot, device.mac, pending);
  if (settingsRevision(desired) === assignment.revision) throw problem('These UniFi settings are already applied.');
  const hostname = device.dnsComparison?.records?.length === 1 ? device.hostname : null;
  if (device.dns?.operation && ['pending','deploying'].includes(device.dns.operation.state)) throw problem('Wait for the existing DNS update to finish.', 409);
  const id = randomUUID();
  await db.query(`INSERT INTO unifi_ip_jobs(id,device_id,site,mac,desired,baseline,ip,hostname,old_ip,dns_revision,dns_from)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, device.id, snapshot.site, normalizeMac(device.mac), desired, assignment.settings,
    input.mode === 'fixed' ? input.ip : null, hostname, device.primaryIp, device.dns?.revision,hostname?device.dnsComparison.records[0].ip:null]);
  return id;
}
