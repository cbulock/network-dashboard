import { matchesDeviceSearch, DEVICE_TYPES, DEVICE_ROLES } from './inventory-model.js';
import { healthPresentation } from './device-presentation.js';

export const defaultInventoryFilters = (cleanup = false) => ({ search: '', scope: cleanup ? 'all' : 'current', networks: [], ranges: [], types: [], roles: [], health: [], tags: [], withIpOnly: false, dnsMismatch: false, sortBy: 'name', sortDir: 'asc' });
export function inventoryFiltersFromQuery(query) {
  const ids = value => (Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string' && /^[1-9]\d*$/.test(value));
  const networks = ids(query.vlanId), ranges = ids(query.reservedRangeId);
  return networks.length || ranges.length ? { ...defaultInventoryFilters(), scope: 'all', networks, ranges } : null;
}
export function restoreInventoryFilters(saved, cleanup = false) {
  const result = defaultInventoryFilters(cleanup);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return result;
  for (const key of ['networks', 'ranges', 'types', 'roles', 'health', 'tags'])
    if (Array.isArray(saved[key])) result[key] = [...new Set(saved[key].filter(value => typeof value === 'string'))];
  if (typeof saved.search === 'string') result.search = saved.search;
  if (['current', 'history', 'all'].includes(saved.scope)) result.scope = saved.scope;
  if (['name', 'lastSeen', 'type', 'health', 'network'].includes(saved.sortBy)) result.sortBy = saved.sortBy;
  if (['asc', 'desc'].includes(saved.sortDir)) result.sortDir = saved.sortDir;
  for (const key of ['withIpOnly', 'dnsMismatch']) result[key] = saved[key] === true;
  // Upgrade the old single-select filters. Integration-specific filtering is retired.
  if (saved.vlanId && !result.networks.length) result.networks = [String(saved.vlanId)];
  if (!result.health.length && ['online', 'offline', 'unknown'].includes(saved.status))
    result.health = [{ online: 'Healthy', offline: 'Failing', unknown: 'Unknown' }[saved.status]];
  result.types = result.types.filter(value => DEVICE_TYPES.includes(value));
  result.roles = result.roles.filter(value => DEVICE_ROLES.includes(value));
  result.health = result.health.filter(value => ['Healthy', 'Failing', 'Not monitored', 'Unknown'].includes(value));
  return result;
}
export function filterInventory(devices, filters) {
  const selected = (key, value) => !filters[key]?.length || filters[key].includes(value);
  return devices.filter(device => (filters.scope === 'all' || (device.lifecycle?.scope || 'current') === filters.scope)
    && matchesDeviceSearch(device, filters.search)
    && (!filters.networks.length || (device.vlans?.length ? device.vlans.some(network => filters.networks.includes(String(network.id))) : filters.networks.includes('none')))
    && (!filters.ranges?.length || device.reservedRanges?.some(range => filters.ranges.includes(String(range.id))))
    && selected('types', device.deviceType || 'Unknown') && selected('roles', device.role || 'Unassigned')
    && selected('health', healthPresentation(device).label)
    && (!filters.tags.length || device.tags?.some(tag => filters.tags.includes(tag.name)))
    && (!filters.withIpOnly || Boolean(device.primaryIp || device.allIps?.length))
    && (!filters.dnsMismatch || device.dnsComparison?.hasMismatch));
}
export function sortInventory(devices, filters) {
  const direction = filters.sortDir === 'desc' ? -1 : 1;
  const value = device => filters.sortBy === 'type' ? device.deviceType || 'Unknown'
    : filters.sortBy === 'health' ? healthPresentation(device).label
      : filters.sortBy === 'network' ? device.vlans?.map(network => network.name).join(', ') || '' : device.name || '';
  return [...devices].sort((a, b) => {
    if (filters.sortBy === 'lastSeen') {
      const left = Date.parse(a.lastSeen), right = Date.parse(b.lastSeen);
      if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : a.id - b.id;
      if (!Number.isFinite(right)) return -1;
      return direction * (left - right) || a.id - b.id;
    }
    return direction * value(a).localeCompare(value(b), undefined, { numeric: true }) || a.id - b.id;
  });
}
