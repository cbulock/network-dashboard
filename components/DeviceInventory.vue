<script setup>
import { formatTimestamp } from '~/utils/format-date.js';
import { getUnreservedDeviceIps } from '~/utils/network-match.js';
import { devicePresentation, healthPresentation, hostIp } from '~/utils/device-presentation.js';
import { DEVICE_TYPES, DEVICE_ROLES } from '~/utils/inventory-model.js';
import { defaultInventoryFilters, restoreInventoryFilters, inventoryFiltersFromQuery, filterInventory, sortInventory } from '~/utils/inventory-view.js';
const route = useRoute();
const props = defineProps({ cleanup: { type: Boolean, default: false } });
const isCleanup = props.cleanup;
const pageTitle = isCleanup ? 'Device cleanup' : 'Device inventory';
useHead({ title: pageTitle });
const stateKey = isCleanup ? 'cleanup' : 'inventory';
const storageKey = `network-dashboard:${stateKey}-filters:v2`;
const state = useState(`inventory-view:${stateKey}`, () => ({ filters: defaultInventoryFilters(isCleanup), page: 1, pageSize: 25, expanded: [], scroll: 0, initialized: false }));
const filters = computed(() => state.value.filters);
const page = computed({ get: () => state.value.page, set: value => { state.value.page = value; } });
const showMore = ref(false), refreshing = ref(false), lastRefreshed = ref('');
let restoring = false;
// Start both requests together and render the destination before client data arrives.
const { data: devicesData, pending, error, refresh: refreshDevices } = useFetch('/api/inventory/devices', { lazy: true, default: () => ({ devices: [] }) });
const { data: lookups, pending: lookupsPending, error: lookupsError, refresh: refreshLookups } = useFetch('/api/inventory/lookups', { lazy: true, default: () => ({ tags: [], vlans: [], reservedRanges: [] }) });
const viewError = computed(() => error.value || (isCleanup && lookupsError.value));
const viewPending = computed(() => pending.value || (isCleanup && lookupsPending.value));
const ranges = computed(() => lookups.value?.reservedRanges || lookups.value?.virtualSubnets || []);
const devices = computed(() => {
  const all = devicesData.value?.devices || [];
  if (!isCleanup) return all;
  if (lookupsError.value || lookupsPending.value) return [];
  return all.map(device => ({ ...device, cleanupIps: getUnreservedDeviceIps(device, ranges.value) })).filter(device => device.cleanupIps.length);
});
const visibleDevices = computed(() => sortInventory(filterInventory(devices.value, filters.value), filters.value));
const totalPages = computed(() => Math.max(1, Math.ceil(visibleDevices.value.length / state.value.pageSize)));
const pagedDevices = computed(() => visibleDevices.value.slice((page.value - 1) * state.value.pageSize, page.value * state.value.pageSize));
const networkOptions = computed(() => {
  const known = new Map((lookups.value?.vlans || []).map(network => [String(network.id), { value: String(network.id), label: network.name, color: network.color }]));
  for (const device of devices.value) for (const network of device.vlans || [])
    if (!known.has(String(network.id))) known.set(String(network.id), { value: String(network.id), label: network.name, color: network.color });
  for (const id of filters.value.networks) if (id !== 'none' && !known.has(id)) known.set(id, { value: id, label: `Unavailable network (${id})` });
  return [...known.values(), { value: 'none', label: 'No matching network' }];
});
const typeOptions = DEVICE_TYPES.map(value => ({ value, label: value }));
const roleOptions = DEVICE_ROLES.map(value => ({ value, label: value }));
const healthOptions = ['Healthy', 'Failing', 'Not monitored', 'Unknown'].map(value => ({ value, label: value }));
const tagOptions = computed(() => [...new Set([...(lookups.value?.tags || []).map(tag => tag.name), ...filters.value.tags])].sort().map(value => ({ value, label: value })));
const rangeOptions = computed(() => {
  const known = new Map(ranges.value.map(range => [String(range.id), { value: String(range.id), label: range.name }]));
  for (const id of filters.value.ranges || []) if (!known.has(id)) known.set(id, { value: id, label: `Unavailable range (${id})` });
  return [...known.values()];
});
const activeFilters = computed(() => {
  const chips = [];
  if (filters.value.search) chips.push({ key: 'search', value: filters.value.search, label: `Search: ${filters.value.search}` });
  for (const key of ['networks', 'ranges', 'types', 'roles', 'health', 'tags']) for (const value of filters.value[key] || [])
    chips.push({ key, value, color: key === 'networks' ? networkOptions.value.find(option => option.value === value)?.color : null, label: key === 'networks' ? networkOptions.value.find(option => option.value === value)?.label || value : key === 'ranges' ? `Range: ${rangeOptions.value.find(option => option.value === value)?.label || value}` : value });
  if (filters.value.withIpOnly) chips.push({ key: 'withIpOnly', label: 'Has IP address' });
  if (filters.value.dnsMismatch) chips.push({ key: 'dnsMismatch', label: 'DNS mismatch' });
  return chips;
});
function removeFilter(chip) {
  if (Array.isArray(filters.value[chip.key])) filters.value[chip.key] = filters.value[chip.key].filter(value => value !== chip.value);
  else filters.value[chip.key] = chip.key === 'search' ? '' : false;
}
function clearFilters() { state.value.filters = { ...defaultInventoryFilters(isCleanup), scope: filters.value.scope }; }
function toggleRow(id) { state.value.expanded = state.value.expanded.includes(id) ? state.value.expanded.filter(value => value !== id) : [...state.value.expanded, id]; }
function rowClick(event, id) { if (!event.target.closest('a,button,input,select,summary') && !window.getSelection()?.toString()) toggleRow(id); }
const subtitle = device => device.hostname && device.hostname.trim().toLowerCase() !== device.name?.trim().toLowerCase() ? device.hostname : '';
const preview = device => devicePresentation(device, lookups.value);
const detailLink = device => ({ path: `/devices/${device.id}`, query: isCleanup ? { from: 'cleanup' } : {} });

const connectionLabel = device => [device.connection?.kind, device.connection?.wifi].filter(Boolean).join(' · ');
function relativeTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
  const days = Math.floor((Date.now() - Date.parse(value)) / 86400000);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes >= 60) { const hours = Math.floor(minutes / 60); return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`; }
  return minutes ? `${minutes} min ago` : 'Just now';
}
async function refreshAll() {
  refreshing.value = true;
  try { await Promise.all([refreshDevices(), refreshLookups()]); if (!error.value && !lookupsError.value) lastRefreshed.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  finally { refreshing.value = false; }
}
function persist() {
  if (restoring || !state.value.initialized || !import.meta.client) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ ...filters.value, pageSize: state.value.pageSize })); } catch { /* Storage is optional. */ }
}
watch(filters, () => { if (!restoring) { page.value = 1; state.value.expanded = []; } persist(); }, { deep: true, flush: 'sync' });
watch(() => state.value.pageSize, () => { page.value = 1; persist(); });
watch([totalPages, viewPending], () => { if (!viewPending.value) page.value = Math.min(page.value, totalPages.value); });
function applyRouteFilters() {
  if (isCleanup) return;
  const queryFilters = inventoryFiltersFromQuery(route.query);
  const queryKey = JSON.stringify(queryFilters);
  if (queryFilters && state.value.networkQuery !== queryKey) {
    state.value.filters = queryFilters;
    state.value.scroll = 0;
  }
  state.value.networkQuery = queryKey;
}
watch(() => route.query, () => { if (state.value.initialized) applyRouteFilters(); });
onMounted(async () => {
  if (!state.value.initialized) {
    restoring = true;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(`network-dashboard:${stateKey}-filters:v1`) || 'null');
      state.value.filters = restoreInventoryFilters(saved, isCleanup);
      if ([25, 50, 100].includes(saved?.pageSize)) state.value.pageSize = saved.pageSize;
    } catch { /* Invalid saved settings do not block the inventory. */ }
    state.value.initialized = true;
    restoring = false;
  }
  applyRouteFilters();
  if (!viewPending.value) page.value = Math.min(page.value, totalPages.value);
  const restoreScroll = async () => {
    await nextTick();
    window.requestAnimationFrame(() => window.scrollTo({ top: state.value.scroll, behavior: 'instant' }));
  };
  if (viewPending.value) {
    const stop = watch(viewPending, loading => {
      if (!loading) { stop(); restoreScroll(); }
    });
  } else {
    restoreScroll();
  }
});
onBeforeRouteLeave(to => {
  state.value.scroll = window.scrollY;
  if (!to.path.startsWith('/devices/')) state.value.networkQuery = null;
});
</script>

<template>
  <div class="inventory-page">
    <header class="page-heading"><div><h1>{{ pageTitle }}</h1><p v-if="isCleanup" class="muted">Devices with IP addresses outside your reserved ranges.</p></div><div class="heading-actions"><button class="ui-button" :disabled="refreshing || viewPending" @click="refreshAll"><AppIcon name="refresh" :size="16" />{{ refreshing ? 'Refreshing…' : 'Refresh' }}</button><NuxtLink v-if="isCleanup" class="ui-button" to="/network">Manage ranges</NuxtLink><NuxtLink v-else class="ui-button" to="/devices/new"><AppIcon name="plus" :size="16" />New device</NuxtLink></div></header>
    <section class="inventory-panel surface" aria-label="Devices" :aria-busy="viewPending">
      <div class="inventory-toolbar">
        <div class="scope-controls" role="group" aria-label="Inventory scope"><button v-for="scope in [{ id: 'current', label: 'Current' }, { id: 'history', label: 'History' }, { id: 'all', label: 'All records' }]" :key="scope.id" :aria-pressed="filters.scope === scope.id" @click="filters.scope = scope.id">{{ scope.label }}</button></div>
        <label class="search-field"><AppIcon name="search" :size="17" /><span class="sr-only">Search devices by name, IP or MAC</span><input v-model="filters.search" type="search" placeholder="Search name, IP, MAC…"></label>
      </div>
      <div class="primary-filters">
        <InventoryFilter v-model="filters.networks" label="Networks" :options="networkOptions" />
        <InventoryFilter v-model="filters.types" label="Device types" :options="typeOptions" />
        <InventoryFilter v-model="filters.roles" label="Roles" :options="roleOptions" />
        <InventoryFilter v-model="filters.health" label="Monitoring health" all-label="All health states" :options="healthOptions" />
      </div>
      <div class="view-controls"><button class="text-button" :aria-expanded="showMore" aria-controls="more-inventory-filters" @click="showMore = !showMore">More filters<AppIcon name="chevron" :size="13" :class="{ rotated: showMore }" /></button><div class="sort-controls"><label>Sort by <select v-model="filters.sortBy"><option value="name">Name</option><option value="type">Device type</option><option value="health">Health</option><option value="network">Network</option><option value="lastSeen">Last seen</option></select></label><button class="text-button" :aria-label="`Sort ${filters.sortDir === 'asc' ? 'descending' : 'ascending'}`" @click="filters.sortDir = filters.sortDir === 'asc' ? 'desc' : 'asc'">{{ filters.sortDir === 'asc' ? 'Ascending ↑' : 'Descending ↓' }}</button></div></div>
      <div v-show="showMore" id="more-inventory-filters" class="more-filters"><InventoryFilter v-model="filters.ranges" label="Reserved ranges" :options="rangeOptions" /><InventoryFilter v-model="filters.tags" label="Tags" :options="tagOptions" /><label class="check"><input v-model="filters.withIpOnly" type="checkbox">Has an IP address</label><label class="check"><input v-model="filters.dnsMismatch" type="checkbox">DNS mismatch</label></div>
      <div v-if="activeFilters.length" class="active-filters"><button v-for="chip in activeFilters" :key="`${chip.key}:${chip.value}`" class="filter-chip" :aria-label="`Remove ${chip.label} filter`" @click="removeFilter(chip)"><VlanColorIndicator :color="chip.color" />{{ chip.label }}<AppIcon name="close" :size="12" /></button><button class="text-button" @click="clearFilters">Clear filters</button></div>
      <p v-if="filters.scope === 'history'" class="scope-note">Not seen for over 90 days. Configured and monitored devices remain in Current.</p>
      <p v-if="lookupsError && !isCleanup" class="lookup-warning" role="status">Network and tag options may be incomplete. <button class="text-button" @click="refreshAll">Retry</button></p>
      <div class="result-count" role="status">{{ viewPending ? 'Loading devices…' : viewError ? 'Device records unavailable' : `${visibleDevices.length} ${visibleDevices.length === 1 ? 'device' : 'devices'}` }}</div>
      <div v-if="viewError" class="empty-state" role="alert"><h2>{{ isCleanup && lookupsError ? 'Reserved ranges are unavailable' : 'Inventory is unavailable' }}</h2><p>Check the connection and try again.</p><button class="ui-button" @click="refreshAll">Try again</button></div>
      <div v-else-if="viewPending" class="empty-state">Loading device inventory…</div>
      <div v-else-if="!visibleDevices.length" class="empty-state"><h2>{{ activeFilters.length ? 'No matching devices' : filters.scope === 'history' ? 'No historical devices' : isCleanup ? 'No devices need cleanup' : 'No devices in this view' }}</h2><p v-if="activeFilters.length">Remove a filter or try another search.</p><button v-if="activeFilters.length" class="ui-button" @click="clearFilters">Clear filters</button><button v-else-if="filters.scope !== 'all'" class="ui-button" @click="filters.scope = 'all'">View all records</button></div>
      <div v-else class="device-list">
        <div class="column-headings" aria-hidden="true"><span>Device</span><span>Type</span><span>{{ isCleanup ? 'Outside reserved ranges' : 'Address / network' }}</span><span>Health</span><span></span></div>
        <article v-for="device in pagedDevices" :key="device.id" class="device-entry" :aria-label="device.name">
          <div class="device-row" :class="{ expanded: state.expanded.includes(device.id) }" @click="rowClick($event, device.id)">
            <div class="identity"><button class="expand-button" :aria-label="`${state.expanded.includes(device.id) ? 'Collapse' : 'Expand'} ${device.name}`" :aria-expanded="state.expanded.includes(device.id)" :aria-controls="`device-preview-${device.id}`" @click="toggleRow(device.id)"><AppIcon name="chevron" :size="16" /></button><div><span class="device-name">{{ device.name }}</span><span v-if="subtitle(device)" class="secondary hostname">{{ subtitle(device) }}</span><span class="mobile-type secondary">{{ device.deviceType || 'Unknown' }}</span></div></div>
            <span class="device-type">{{ device.deviceType || 'Unknown' }}</span>
            <div class="address-cell"><template v-if="isCleanup"><span v-for="ip in device.cleanupIps" :key="ip" class="mono address-line">{{ hostIp(ip) }}</span></template><template v-else><span class="mono">{{ hostIp(device.primaryIp) || 'No address' }}</span><span v-if="device.allIps?.length > 1" class="extra-ips">+{{ device.allIps.length - 1 }}</span></template><span v-if="device.vlans?.length" class="secondary"><template v-for="(network, index) in device.vlans" :key="network.id"><template v-if="index">, </template><VlanColorIndicator :color="network.color" />{{ network.name }}</template></span><span v-if="device.dnsComparison?.hasMismatch || ['pending', 'failed'].includes(device.dnsComparison?.state)" class="device-warning">{{ device.dnsComparison?.state === 'pending' ? 'DNS updating' : device.dnsComparison?.state === 'failed' ? 'DNS update failed' : 'DNS mismatch' }}</span></div>
            <div class="health-cell"><span class="health" :class="healthPresentation(device).tone"><span aria-hidden="true">●</span>{{ healthPresentation(device).label }}</span><span v-if="device.monitoring?.stale" class="secondary">Last result is stale</span></div>
            <NuxtLink :to="detailLink(device)" class="ui-button details-button" :aria-label="`Open details for ${device.name}`">Details</NuxtLink>
          </div>
          <div v-if="state.expanded.includes(device.id)" :id="`device-preview-${device.id}`" class="device-preview">
            <p v-if="device.dnsComparison?.hasMismatch" class="notice">DNS points to {{ [...new Set((device.dnsComparison.records || []).map(record => record.ip))].join(', ') || 'a different address' }}. <NuxtLink :to="detailLink(device)">Review address settings</NuxtLink></p>
            <p v-if="preview(device).operation && preview(device).operation.tone !== 'success'" class="notice">{{ preview(device).operation.label }}</p>
            <dl class="preview-grid">
              <div><dt>Addresses</dt><dd v-if="preview(device).addresses.length"><div v-for="address in preview(device).addresses" :key="address.ip" class="preview-address"><CopyValue class="mono" :value="address.ip" label="IP address" /><span v-if="address.network || address.range" class="secondary"><template v-if="address.network"><VlanColorIndicator :color="address.network.color" />{{ address.network.name }}</template><template v-if="address.network && address.range"> · </template>{{ address.range?.name }}</span></div></dd><dd v-else class="muted">No reported address</dd></div>
              <div v-if="device.mac"><dt>MAC address</dt><dd><CopyValue class="mono" :value="device.mac" label="MAC address" /></dd></div>
              <div v-if="device.hardware?.model"><dt>Hardware</dt><dd>{{ device.hardware.model }}<span v-if="device.hardware.firmware" class="secondary">Firmware {{ device.hardware.firmware }}</span></dd></div>
              <div v-if="connectionLabel(device)"><dt>Connection</dt><dd>{{ connectionLabel(device) }}<span v-if="device.connection.accessPointMac" class="secondary">Access point {{ device.connection.accessPointMac }}</span></dd></div>
              <div><dt>Last seen</dt><dd><time :datetime="device.lastSeen || undefined" :title="formatTimestamp(device.lastSeen)">{{ relativeTime(device.lastSeen) }}</time><span class="secondary">{{ formatTimestamp(device.lastSeen) }}</span></dd></div>
              <div v-if="device.monitoring?.count"><dt>Monitoring</dt><dd>{{ device.monitoring.count }} {{ device.monitoring.count === 1 ? 'check' : 'checks' }}<span class="secondary">{{ device.monitoring.stale ? 'Result is over 24 hours old · ' : 'Last checked ' }}{{ formatTimestamp(device.monitoring.checkedAt) }}</span></dd></div>
              <div><dt>DNS</dt><dd>{{ preview(device).dnsLabel }}</dd></div>
            </dl>
            <div class="preview-organization"><span>Role: {{ device.role || 'Unassigned' }}</span><span v-for="tag in device.tags" :key="tag.id || tag.name" class="tag-label">{{ tag.name }}</span><p v-if="device.notes" class="notes">{{ device.notes }}</p></div>
            <div class="preview-footer"><span class="muted">{{ device.lifecycle?.reason }}</span><NuxtLink :to="detailLink(device)" class="text-button">Full device details <AppIcon name="arrow" :size="14" /></NuxtLink></div>
          </div>
        </article>
      </div>
      <footer class="table-footer"><span v-if="lastRefreshed" class="muted">Refreshed {{ lastRefreshed }}</span><span v-if="visibleDevices.length && !viewPending && !viewError">{{ (page - 1) * state.pageSize + 1 }}–{{ Math.min(page * state.pageSize, visibleDevices.length) }} of {{ visibleDevices.length }}</span><div class="pagination"><label>Per page <select v-model.number="state.pageSize"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select></label><button class="ui-button" :disabled="page <= 1 || viewPending" aria-label="Previous page" @click="page--">Previous</button><span>{{ page }} / {{ totalPages }}</span><button class="ui-button" :disabled="page >= totalPages || viewPending" aria-label="Next page" @click="page++">Next</button></div></footer>
    </section>
    <div class="inventory-utility">
      <NuxtLink :to="isCleanup ? '/' : '/cleanup'">{{ isCleanup ? 'Back to device inventory' : 'Device cleanup' }}</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.inventory-utility{font-size:12px;color:var(--fg-muted)}
.inventory-utility a{display:inline-block;padding-block:8px;text-decoration:underline;text-underline-offset:3px}
.inventory-utility a:hover{color:var(--fg)}
.inventory-page{display:grid;gap:24px;min-width:0;font-size:15px}.page-heading,.heading-actions,.inventory-toolbar,.scope-controls,.search-field,.view-controls,.sort-controls,.active-filters,.filter-chip,.pagination,.table-footer,.preview-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.page-heading{justify-content:space-between;align-items:flex-start}.page-heading h1{font-size:32px;letter-spacing:-1px;line-height:1.2;margin:0}.page-heading p{margin:10px 0 0}.inventory-panel{border-radius:12px;border:1px solid var(--border-muted);min-width:0;background:var(--surface-raised)}.inventory-toolbar{justify-content:space-between;padding:24px 24px 20px;gap:18px}.scope-controls{gap:4px}.scope-controls button{border:0;border-radius:7px;padding:10px 14px;background:transparent;color:var(--fg-muted);font:inherit;font-size:14px;min-height:44px}.scope-controls button[aria-pressed=true]{background:var(--accent-muted);color:var(--fg);font-weight:600}.search-field{border:1px solid var(--border-strong);border-radius:8px;padding:10px 12px;gap:10px;width:340px;max-width:100%;background:var(--surface-raised);color:var(--fg-muted)}.search-field input{border:0;background:transparent;color:var(--fg);font:inherit;font-size:15px;min-width:0;width:calc(100% - 30px);outline-offset:4px}.primary-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:0 24px}.view-controls{padding:16px 24px;justify-content:space-between}.text-button{display:inline-flex;align-items:center;gap:8px;background:none;border:0;padding:6px 0;color:var(--accent);font:inherit;font-size:14px;text-align:left}.rotated{transform:rotate(90deg)}.sort-controls{gap:16px;color:var(--fg-muted);font-size:13px}.sort-controls label,.pagination label{display:flex;align-items:center;gap:8px}select{font:inherit;color:var(--fg);border:1px solid var(--border-muted);border-radius:6px;background:var(--surface-raised);padding:7px;min-height:36px}.more-filters{display:flex;align-items:center;gap:24px;flex-wrap:wrap;padding:0 24px 20px}.more-filters>.inventory-filter{width:230px;max-width:100%}.check{display:flex;align-items:center;gap:10px;font-size:14px;min-height:44px}.check input{width:16px;height:16px;accent-color:var(--accent)}.active-filters{padding:0 24px 14px;gap:8px}.filter-chip{background:var(--surface);color:var(--fg);border:1px solid var(--border-muted);border-radius:20px;padding:6px 11px;font:inherit;font-size:13px;overflow-wrap:anywhere;text-align:left}.filter-chip svg{flex:none}.result-count{color:var(--fg-muted);font-size:13px;padding:0 24px 16px}.scope-note,.lookup-warning{margin:0;padding:0 24px 18px;color:var(--fg-muted);font-size:13px}.column-headings,.device-row{display:grid;grid-template-columns:minmax(180px,1.5fr) minmax(100px,.75fr) minmax(140px,1fr) minmax(110px,.85fr) 78px;gap:16px;align-items:center;padding:18px 24px}.column-headings{font-size:13px;color:var(--fg-muted);border-block:1px solid var(--border-muted);padding-block:12px;background:var(--surface)}.device-entry+.device-entry{border-top:1px solid var(--border-muted)}.device-row{cursor:pointer;min-height:82px}.device-row:hover,.device-row.expanded{background:var(--surface)}.identity{display:flex;gap:12px;align-items:center;min-width:0}.identity>div{min-width:0}.device-name{font-weight:600;font-size:16px;overflow-wrap:anywhere}.expand-button{border:0;background:none;display:grid;place-items:center;color:var(--fg-muted);padding:6px;min-width:30px;min-height:36px}.expanded .expand-button svg{transform:rotate(90deg)}.secondary{display:block;font-size:13px;color:var(--fg-muted);margin-top:5px;overflow-wrap:anywhere}.device-type{font-size:14px;overflow-wrap:anywhere}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:14px;overflow-wrap:anywhere}.extra-ips{margin-left:7px;color:var(--fg-muted);font-size:12px}.address-line{display:block}.health{display:inline-flex;align-items:center;gap:6px;font-size:13px}.health>span{font-size:10px}.success{color:var(--success)}.danger{color:var(--danger)}.neutral,.muted{color:var(--fg-muted)}.details-button{padding:8px 12px;font-size:14px;justify-content:center}.device-warning{display:block;color:var(--theme-warning,#9d6400);font-size:12px;margin-top:6px}.device-preview{padding:24px 24px 24px 66px;background:var(--surface);border-top:1px solid var(--border-muted)}.preview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px 28px;margin:0}.preview-grid>div{min-width:0}dt{font-size:13px;color:var(--fg-muted);margin-bottom:6px}dd{margin:0;font-size:14px;overflow-wrap:anywhere}.preview-address+.preview-address{margin-top:10px}.preview-address .secondary{margin-top:0}.preview-organization{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px;font-size:13px;color:var(--fg-muted)}.tag-label{padding:3px 8px;background:var(--surface-raised);border-radius:5px}.notes{width:100%;white-space:pre-wrap;margin:0;overflow-wrap:anywhere}.preview-footer{justify-content:space-between;margin-top:18px;font-size:12px}.notice{margin:0 0 20px;border-left:3px solid var(--theme-warning,#9d6400);padding:8px 12px;font-size:14px;overflow-wrap:anywhere}.notice a{color:var(--accent);text-decoration:underline}.empty-state{text-align:center;padding:48px 24px;color:var(--fg-muted)}.empty-state h2{font-size:20px;color:var(--fg)}.empty-state .ui-button{margin:auto}.table-footer{border-top:1px solid var(--border-muted);padding:18px 24px;justify-content:space-between;font-size:13px}.pagination{margin-left:auto;gap:12px}.pagination .ui-button{font-size:13px}.mobile-type{display:none}
@media(max-width:1150px){.column-headings,.device-row{grid-template-columns:minmax(170px,1.5fr) minmax(140px,1fr) minmax(110px,.8fr) 78px}.column-headings>span:nth-child(2),.device-type{display:none}.mobile-type{display:block}}
@media(max-width:760px){.page-heading h1{font-size:27px}.inventory-page{gap:20px}.inventory-toolbar{padding:20px;align-items:stretch}.search-field{width:100%}.primary-filters{grid-template-columns:1fr 1fr;padding:0 20px;gap:14px}.view-controls{padding:14px 20px}.sort-controls{gap:10px}.more-filters,.active-filters{padding-inline:20px}.column-headings{display:none}.device-row{grid-template-columns:minmax(0,1fr) 110px;padding:18px 20px;gap:14px}.identity{grid-column:1;grid-row:1;gap:6px}.address-cell{grid-column:1;grid-row:2;padding-left:36px}.health-cell{grid-column:2;grid-row:1}.details-button{grid-column:2;grid-row:2;justify-self:start}.device-preview{padding:20px}.preview-grid{grid-template-columns:1fr 1fr;gap:22px}.device-list{border-top:1px solid var(--border-muted)}.pagination{margin-left:0;flex-wrap:wrap}.table-footer{padding:18px 20px;gap:16px}.result-count,.scope-note,.lookup-warning{padding-inline:20px}.device-name{font-size:15px}}
@media(max-width:420px){.primary-filters{gap:12px}.device-row{padding:16px 12px;grid-template-columns:minmax(0,1fr) 98px;gap:8px}.identity{gap:2px}.address-cell{padding-left:32px}.preview-grid{grid-template-columns:1fr}.scope-controls button{padding:9px 10px}.inventory-toolbar{padding:18px 14px}.primary-filters,.active-filters,.view-controls,.more-filters{padding-inline:14px}.health{font-size:12px}.heading-actions{gap:8px}.pagination{gap:8px}.pagination label{width:100%}}
@media(pointer:coarse){.expand-button{min-width:36px;min-height:44px}.text-button,.details-button{min-height:44px}}
</style>
