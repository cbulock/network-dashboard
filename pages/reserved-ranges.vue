<script setup>
import { reservedRangeOverview } from '~/utils/reserved-range-overview.js';
import { deviceTitle } from '~/utils/device-presentation.js';

useHead({ title: 'Reserved ranges' });
const { data: lookups, pending: rangesPending, error: rangesError, refresh: refreshRanges } = useFetch('/api/inventory/lookups', {
  lazy: true, default: () => ({ reservedRanges: [], vlans: [] }),
});
const { data: inventory, pending: devicesPending, error: devicesError, refresh: refreshDevices } = useFetch('/api/inventory/devices', {
  lazy: true, default: () => ({ devices: [] }),
});
const pending = computed(() => rangesPending.value || devicesPending.value);
const error = computed(() => rangesError.value || devicesError.value);
const groups = computed(() => reservedRangeOverview(lookups.value?.reservedRanges ?? lookups.value?.virtualSubnets ?? [], inventory.value?.devices ?? []));
const deviceCount = computed(() => new Set(groups.value.flatMap(group => group.devices.map(device => device.id))).size);
const ipCount = computed(() => groups.value.reduce((sum, group) => sum + group.ipCount, 0));
const refreshing = ref(false);
async function refreshAll() {
  refreshing.value = true;
  try { await Promise.all([refreshRanges(), refreshDevices()]); }
  finally { refreshing.value = false; }
}
function rangeVlan(range) { return lookups.value?.vlans?.find(vlan => vlan.id === range.vlanId); }
function vlanLabel(range) {
  const vlan = lookups.value?.vlans?.find(vlan => vlan.id === range.vlanId);
  return vlan ? `VLAN ${vlan.vlanId} · ${vlan.name}` : '';
}
</script>

<template>
  <div class="range-overview">
    <header class="page-heading">
      <div>
        <h1>Reserved ranges</h1>
        <p v-if="!pending && !error" class="overview-counts">{{ groups.length }} ranges <span aria-hidden="true">·</span> {{ deviceCount }} devices <span aria-hidden="true">·</span> {{ ipCount }} IPs</p>
      </div>
      <div class="heading-actions">
        <button type="button" class="ui-button" :disabled="pending || refreshing" @click="refreshAll"><AppIcon name="refresh" :size="16" />{{ refreshing ? 'Refreshing…' : 'Refresh' }}</button>
        <NuxtLink to="/network" class="ui-button">Manage ranges</NuxtLink>
      </div>
    </header>

    <div v-if="pending" class="panel state" role="status">Loading reserved ranges…</div>
    <div v-else-if="error" class="panel state" role="alert">
      <h2>Reserved ranges are unavailable</h2>
      <p>Check the connection and try again.</p>
      <button type="button" class="ui-button" @click="refreshAll">Try again</button>
    </div>
    <div v-else-if="!groups.length" class="panel state">
      <h2>No reserved ranges yet</h2>
      <NuxtLink to="/network" class="ui-button">Create a reserved range</NuxtLink>
    </div>
    <template v-else>
      <section v-for="range in groups" :key="range.id" class="panel range-group" :aria-labelledby="`range-${range.id}`">
        <header class="range-heading">
          <div>
            <h2 :id="`range-${range.id}`">{{ range.name }}</h2>
            <div class="range-meta">
              <span v-if="range.startIp && range.endIp" class="address">{{ range.startIp }} – {{ range.endIp }}</span>
              <span v-else>No IP boundaries defined</span>
              <span v-if="vlanLabel(range)"><VlanColorIndicator :color="rangeVlan(range)?.color" />{{ vlanLabel(range) }}</span>
            </div>
            <p v-if="range.description" class="range-description">{{ range.description }}</p>
          </div>
          <span class="range-count">{{ range.devices.length }} {{ range.devices.length === 1 ? 'device' : 'devices' }} · {{ range.ipCount }} {{ range.ipCount === 1 ? 'IP' : 'IPs' }}</span>
        </header>
        <table v-if="range.devices.length">
          <caption class="sr-only">Devices in {{ range.name }}</caption>
          <thead><tr><th scope="col">Label</th><th scope="col">Hostname</th><th scope="col">IP</th><th scope="col">MAC</th><th scope="col" class="details-column"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            <tr v-for="device in range.devices" :key="device.id">
              <td data-label="Label"><NuxtLink :to="`/devices/${device.id}`" class="device-label" :aria-label="`Details for ${deviceTitle(device)}`">{{ deviceTitle(device) }}</NuxtLink></td>
              <td data-label="Hostname">{{ device.hostname || '—' }}</td>
              <td data-label="IP" class="address"><span v-for="ip in device.rangeIps" :key="ip" class="ip-value">{{ ip }}</span></td>
              <td data-label="MAC" class="address">{{ device.mac || '—' }}</td>
              <td class="device-actions"><NuxtLink :to="`/devices/${device.id}`" class="ui-button details-link" :aria-label="`View details for ${deviceTitle(device)}`">Details<AppIcon name="chevron" :size="14" /></NuxtLink></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="range-empty">No devices in this range.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.range-overview { display: grid; gap: 20px; }
.overview-counts { margin: 8px 0 0; color: var(--fg-muted); display: flex; flex-wrap: wrap; gap: 10px; }
.heading-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.panel { background: var(--surface-raised); border: 1px solid var(--border-muted); border-radius: 12px; overflow: hidden; min-width: 0; }
.range-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; padding: 22px 24px; }
h2 { margin: 0; font-size: 18px; }
.range-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 8px; color: var(--fg-muted); font-size: 12px; }
.range-description { margin: 8px 0 0; color: var(--fg-muted); overflow-wrap: anywhere; }
.range-count { flex: none; padding: 5px 10px; border-radius: 6px; background: var(--accent-muted); color: var(--accent); font-size: 12px; font-weight: 600; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: left; }
th { padding: 10px 24px; color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; background: var(--surface); font-weight: 600; }
td { padding: 14px 24px; border-top: 1px solid var(--border-muted); vertical-align: top; overflow-wrap: anywhere; }
tr:hover td { background: color-mix(in srgb, var(--accent) 3%, var(--surface-raised)); }
.device-label { color: var(--fg); font-weight: 600; text-decoration: none; }
.device-label:hover { color: var(--accent); text-decoration: underline; }
.device-label:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.details-column { width: 112px; }
.device-actions { padding-left: 0; text-align: right; }
.details-link { white-space: nowrap; min-height: 32px; padding: 6px 10px; font-size: 12px; }
.address { font-family: 'JetBrains Mono', monospace; font-size: 12px; overflow-wrap: anywhere; }
.ip-value { display: block; }
.ip-value + .ip-value { margin-top: 6px; }
.range-empty { margin: 0; padding: 18px 24px; border-top: 1px solid var(--border-muted); color: var(--fg-muted); }
.state { padding: 28px; display: grid; justify-items: start; gap: 12px; }
.state p { margin: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 700px) {
  .range-heading { padding: 18px; flex-direction: column; gap: 12px; }
  table, tbody, tr, td { display: block; width: 100%; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  tbody tr { padding: 12px 18px; border-top: 1px solid var(--border-muted); }
  td { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 6px 0; border: 0; }
  td::before { content: attr(data-label); color: var(--fg-muted); font: 12px/1.5 'Mona Sans', system-ui, sans-serif; }
  td.address { display: block; padding-left: 84px; position: relative; min-height: 30px; }
  td.address::before { position: absolute; left: 0; }
  td.device-actions { display: flex; justify-content: flex-end; padding: 8px 0 0; }
  td.device-actions::before { content: none; }
  .range-empty { padding: 18px; }
}
</style>
