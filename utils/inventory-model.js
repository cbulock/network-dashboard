// Shared normalized inventory semantics. Source payload interpretation happens here,
// before the UI sees a device; collectors never overwrite local classifications.
export const DEVICE_TYPES = ['Switch', 'Access point', 'Router', 'Server', 'Computer', 'Phone', 'Tablet', 'TV / media player', 'Camera', 'Printer', 'Smart-home device', 'Game console', 'Other', 'Unknown'];
export const DEVICE_ROLES = ['Infrastructure', 'Trusted', 'IoT', 'Guest', 'Other', 'Unassigned'];
export const HISTORY_DAYS = 90;
export const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const time = value => value ? new Date(value).getTime() : NaN;
const latest = values => values.map(time).filter(Number.isFinite).sort((a, b) => b - a)[0];

export function classificationValue(value, choices) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error('Choose a valid device type or role.');
  return value;
}

export function inventoryFacts(row, records = [], dnsRecords = [], now = Date.now()) {
  const active = records.filter(record => record && record.active !== false);
  const candidates = (active.length ? active : records.filter(Boolean)).toSorted((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  const preferred = candidates.find(record => record.kind === 'managed_device') || candidates[0];
  const hardwareTypes = { usw: 'Switch', uap: 'Access point', ugw: 'Router', udm: 'Router', uxg: 'Router' };
  // Only explicit classifications are evidence. Device names, OUI/vendor strings,
  // IP ranges and HA entity domains are not reliable hardware classifications.
  const namedTypes = { server: 'Server', computer: 'Computer', desktop: 'Computer', laptop: 'Computer', phone: 'Phone', smartphone: 'Phone', tablet: 'Tablet', camera: 'Camera', printer: 'Printer', tv: 'TV / media player', 'media player': 'TV / media player', 'game console': 'Game console', 'smart home': 'Smart-home device' };
  const suggestedType = (preferred?.kind === 'managed_device' && hardwareTypes[preferred.type])
    || namedTypes[String(preferred?.device_type || '').toLowerCase()] || 'Unknown';
  const deviceType = row.device_type || suggestedType;
  const suggestedRole = ['Switch', 'Access point', 'Router', 'Server'].includes(deviceType) ? 'Infrastructure'
    : ['Camera', 'Smart-home device'].includes(deviceType) ? 'IoT' : 'Unassigned';
  const role = row.device_role || suggestedRole;
  const monitors = (row.sources || []).filter(source => source.source === 'uptime_kuma');
  const stale = monitors.some(source => Number.isFinite(time(source.lastSeen)) && now - time(source.lastSeen) > HEALTH_MAX_AGE_MS);
  const missingCheckTime = monitors.some(source => !Number.isFinite(time(source.lastSeen)));
  const freshFailure = monitors.some(source => source.status === 'down' && Number.isFinite(time(source.lastSeen)) && now - time(source.lastSeen) <= HEALTH_MAX_AGE_MS);
  const health = !monitors.length ? 'Not monitored' : freshFailure ? 'Failing' : stale || missingCheckTime ? 'Unknown'
      : monitors.every(source => source.status === 'up') ? 'Healthy' : 'Unknown';
  // The oldest constituent check bounds the freshness of an aggregate result.
  const checks = monitors.map(source => time(source.lastSeen)).filter(Number.isFinite);
  const checked = checks.length && !missingCheckTime ? Math.min(...checks) : NaN;
  // Remembered client settings (including DHCP reservations and static IPs)
  // can outlive the physical device by years. They are not a retention choice.
  const configuredReason = row.keep_current ? 'Kept in Current'
    : String(row.device_key || '').startsWith('manual:') ? 'Manually added device'
      : row.managed_hostname ? 'Dashboard-managed hostname'
        : dnsRecords.length ? 'Active DNS record'
          : active.some(record => record.kind === 'managed_device' && record.adopted === true) ? 'Adopted network equipment' : null;
  const configured = Boolean(configuredReason);
  // Controller observations describe actual device presence. Collector ingestion
  // times and unrelated entity updates must not keep an old device recent.
  const observed = latest(records.filter(Boolean).map(record => Number(record.last_seen) > 0 ? Number(record.last_seen) * 1000 : null));
  const lastSeen = Number.isFinite(observed) ? new Date(observed).toISOString() : row.last_seen || null;
  const seen = time(lastSeen);
  const historical = !configured && !monitors.length && Number.isFinite(seen) && now - seen > HISTORY_DAYS * DAY;
  return {
    deviceType, role,
    classification: { typeOverride: row.device_type || null, roleOverride: row.device_role || null, suggestedType, suggestedRole },
    keepCurrent: Boolean(row.keep_current),
    lifecycle: { scope: historical ? 'history' : 'current', configured, reason: monitors.length ? 'Monitored device' : configuredReason || (!Number.isFinite(seen) ? 'Last seen is unknown' : historical ? 'Not seen for over 90 days' : 'Seen within 90 days') },
    lastSeen,
    hardware: { model: preferred?.model || null, firmware: preferred?.version || null },
    connection: preferred ? { kind: preferred.kind === 'managed_device' || preferred.is_wired === true ? 'Wired' : preferred.is_wired === false ? 'Wi-Fi' : null,
      wifi: preferred.essid || null, accessPointMac: preferred.ap_mac || null,
      connected: preferred.connected === true } : null,
    monitoring: { label: health, stale, count: monitors.length, checkedAt: Number.isFinite(checked) ? new Date(checked).toISOString() : null },
  };
}

export function matchesDeviceSearch(device, search) {
  const query = String(search || '').trim().toLowerCase();
  if (!query) return true;
  const macs = [device.mac, ...(device.macs || [])];
  const values = [device.name, device.displayName, device.hostname, device.legacyName, ...macs,
    device.primaryIp, ...(device.allIps || []), device.notes,
    ...(device.dnsComparison?.records || []).flatMap(record => record.names || [])];
  if (values.some(value => String(value || '').toLowerCase().includes(query))) return true;
  const compactMac = query.replace(/[:-]/g, '');
  return compactMac.length >= 6 && /^[a-f\d]+$/.test(compactMac)
    && macs.some(mac => String(mac || '').replace(/[:-]/g, '').toLowerCase().includes(compactMac));
}
