<script setup>
import {
  CindorBadge,
  CindorButton,
  CindorForm,
  CindorFormField,
  CindorFormRow,
  CindorInput,
  CindorSelect,
  CindorTag,
  CindorTextarea,
} from "cindor-ui-vue";
import { formatTimestamp } from "~/utils/format-date.js";
import { getDeviceReservedRanges, matchVlanForIp, matchDeviceNetworks, matchReservedRangeForIp } from "~/utils/network-match.js";

const props = defineProps({
  device: {
    type: Object,
    default: null,
  },
  lookups: {
    type: Object,
    required: true,
  },
  mode: {
    type: String,
    default: "edit",
  },
});

const emit = defineEmits(["saved"]);

const saving = ref(false);
const saveError = ref("");
const saveSuccess = ref("");
const dnsState = ref(null);
const dnsBaseline = reactive({ hostname:'', targetIp:'', revision:null });
let dnsPoll;
let dnsPolling = false;
let confirmedDnsJob = null;
const networkDevice = ref(props.device);
function acceptNetworkUpdate(device) {
  networkDevice.value = device;
  dnsState.value = device.dns;
  if (form.hostname === dnsBaseline.hostname && form.dnsTargetIp === dnsBaseline.targetIp && device.dns?.operation?.state === 'live') {
    form.hostname = device.hostname || '';
    form.dnsTargetIp = device.dns.targetIp || '';
    Object.assign(dnsBaseline, {hostname:form.hostname,targetIp:form.dnsTargetIp,revision:device.dns.revision});
  }
}


const deviceStatus = computed(() => props.device?.status || "unknown");

const form = reactive(createFormState());

function createFormState(device = null) {
  return {
    displayName: device?.displayName ?? "",
    hostname: ['pending','deploying'].includes(device?.dns?.operation?.state) ? device.dns.operation.hostname : device?.hostname ?? "",
    dnsTargetIp: device?.dns?.targetIp || '',
    mac: device?.mac ?? "",
    notes: device?.notes ?? "",
    tagsText: Array.isArray(device?.tags)
      ? device.tags.map((tag) => tag.name).join(", ")
      : "",
  };
}

function resetForm(device = props.device) {
  Object.assign(form, createFormState(device));
  Object.assign(dnsBaseline, { hostname: device?.hostname ?? '', targetIp:device?.dns?.targetIp ?? '', revision:device?.dns?.revision ?? dnsState.value?.revision ?? null });
  saveError.value = "";
  saveSuccess.value = "";
}

watch(
  () => props.device,
  (device) => {
    networkDevice.value = device;
    dnsState.value = device?.dns ?? null;
    resetForm(device);
  },
  { immediate: true },
);

const isCreate = computed(() => props.mode === "create");
const lookupVlans = computed(() => props.lookups?.vlans ?? []);
const lookupReservedRanges = computed(
  () => props.lookups?.reservedRanges ?? props.lookups?.virtualSubnets ?? [],
);

const parsedTags = computed(() =>
  form.tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, tags) => tags.indexOf(tag) === index),
);

const formatIp = (ip) =>
  String(ip || "").replace(/^(\d{1,3}(?:\.\d{1,3}){3})\/32$/, "$1");
const sources = computed(() => props.device?.sources ?? []);
const sourceDescriptions = {
  dns_platform: { name: 'DNS Platform', type: 'address record', idLabel: 'Address record', description: 'Authoritative hostnames and aliases, matched by IP address.' },
  unifi: { name: "UniFi", type: "device record", idLabel: "Device ID", description: "Network discovery and device identity." },
  home_assistant: { name: "Home Assistant", type: "entity", plural: "entities", idLabel: "Entity ID", description: "Entities are controls, sensors, or services associated with this device. One device can have several entities." },
  uptime_kuma: { name: "Uptime Kuma", type: "monitor record", idLabel: "Monitor host", description: "Service monitoring and device health." },
};
const sourceGroups = computed(() => {
  const groups = new Map();
  for (const record of sources.value) {
    if (!groups.has(record.source)) {
      groups.set(record.source, { source: record.source,
        ...(sourceDescriptions[record.source] ?? { name: record.source, type: "record", idLabel: "Record ID" }), records: [] });
    }
    groups.get(record.source).records.push(record);
  }
  return [...groups.values()];
});
const effectiveName = computed(
  () => form.displayName || form.hostname || props.device?.name || "New device",
);
useHead({ title: () => (isCreate.value ? "New device" : effectiveName.value) });

const requiresName = computed(
  () => !form.displayName.trim() && !form.hostname.trim(),
);
const dnsAddresses = computed(() => [...new Set([
  ...(networkDevice.value?.allIps ?? []),
].map(formatIp).filter(ip => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)))]);
const dnsBusy = computed(() => ['pending','deploying'].includes(dnsState.value?.operation?.state));
const dnsChanged = computed(() => !dnsBusy.value && (form.hostname.trim() !== dnsBaseline.hostname ||
  (Boolean(form.hostname.trim()) && form.dnsTargetIp !== dnsBaseline.targetIp)));
const dnsPreview = computed(() => {
  const name = form.hostname.trim().toLowerCase().replace(/\.$/,'');
  return !name ? '' : `${name.includes('.') ? name : `${name} / ${name}.${dnsState.value?.zone || 'bulock'}`} → ${form.dnsTargetIp || 'select an IP'}`;
});
watch(dnsAddresses, addresses => {
  if (!form.dnsTargetIp && addresses.length) form.dnsTargetIp = addresses.includes(formatIp(props.device?.primaryIp)) ? formatIp(props.device.primaryIp) : addresses[0];
}, { immediate:true });
async function pollDns() {
  if (!props.device?.id || dnsPolling) return;
  dnsPolling = true;
  try {
    const result = await $fetch(`/api/inventory/devices/${props.device.id}/dns`);
    const completed = result.dns?.operation?.state === 'live' && result.dns.operation.id !== confirmedDnsJob &&
      result.dns.revision === result.dns.operation.remote?.revision;
    dnsState.value = result.dns;
    if (completed) {
      confirmedDnsJob = result.dns.operation.id;
      saveSuccess.value = 'DNS is live on all resolvers.';
      // Refresh only after completion, without replacing unsaved inventory fields.
      if (form.dnsTargetIp === dnsBaseline.targetIp) form.dnsTargetIp = result.dns.targetIp;
      if (form.hostname === dnsBaseline.hostname || form.hostname === result.dns.operation.hostname) form.hostname = result.hostname;
      Object.assign(dnsBaseline, { hostname:result.hostname, targetIp:result.dns.targetIp, revision:result.dns.revision });
    }
  } catch { /* Keep the last confirmed state while offline. */ }
  finally { dnsPolling = false; }
}
onMounted(async () => {
  dnsPoll = setInterval(pollDns, 3000);
  if (!props.device?.id) {
    try { dnsState.value = await $fetch('/api/inventory/dns'); dnsBaseline.revision = dnsState.value.revision; } catch { /* Configuration hint remains visible. */ }
  }
});
onBeforeUnmount(() => clearInterval(dnsPoll));

async function saveDevice() {
  saveError.value = "";
  saveSuccess.value = "";

  if (requiresName.value) {
    saveError.value = "Add an inventory label or hostname before saving.";
    return;
  }

  saving.value = true;

  try {
    const payload = {
      displayName: form.displayName,
      hostname: form.hostname,
      mac: form.mac || null,
      notes: form.notes,
      tags: parsedTags.value.map((name) => ({ name })),
    };
    if (dnsChanged.value) payload.dns = { targetIp: form.dnsTargetIp, expectedRevision: dnsBaseline.revision };
    else delete payload.hostname;

    const response = isCreate.value
      ? await $fetch("/api/inventory/devices", {
          method: "POST",
          body: payload,
        })
      : await $fetch(`/api/inventory/devices/${props.device.id}`, {
          method: "PATCH",
          body: payload,
        });

    saveSuccess.value = payload.dns ? 'Device saved. DNS update queued.' : isCreate.value
      ? "Device created."
      : "Device details saved.";
    emit("saved", response.device);
  } catch (error) {
    saveError.value =
      error?.data?.statusMessage ||
      error?.message ||
      "Unable to save this device right now.";
  } finally {
    saving.value = false;
  }
}

const detectedVlans = computed(() => matchDeviceNetworks(
  networkDevice.value?.primaryIp, networkDevice.value?.allIps ?? [], lookupVlans.value,
));
const detectedReservedRanges = computed(() => getDeviceReservedRanges(
  networkDevice.value ?? {}, lookupReservedRanges.value,
));
function statusTone(status) {
  if (status === 'up') return 'success';
  if (status === 'down') return 'accent';
  return 'neutral';
}
</script>

<template>
  <div class="editor-shell">
    <header class="page-heading">
      <div>
        <h1>{{ isCreate ? "New device" : effectiveName }}</h1>
      </div>
      <NuxtLink to="/" class="ui-button"
        ><AppIcon name="grid" :size="16" />View inventory</NuxtLink
      >
    </header>

    <ClientOnly>
      <div class="editor-grid">
        <section class="editor-card">
          <CindorForm
            :submitting="saving"
            submitting-label="Saving device"
            :error="saveError"
            :success="saveSuccess"
            @submit.prevent="saveDevice"
          >
            <CindorFormRow :columns="2">
              <CindorFormField
                label="Inventory label"
                :required="true"
                :error="requiresName ? 'Required when hostname is blank.' : ''"
              >
                <CindorInput
                  v-model="form.displayName"
                  name="displayName"
                  placeholder="File server"
                />
              </CindorFormField>

              <CindorFormField label="Hostname">
                <CindorInput
                  v-model="form.hostname"
                  name="hostname"
                  placeholder="filesrv01"
                  :disabled="dnsBusy"
                />
              </CindorFormField>
            </CindorFormRow>

            <UnifiIpManager v-if="!isCreate && networkDevice" :device="networkDevice" :ranges="lookupReservedRanges" @updated="acceptNetworkUpdate" />
            <p v-else class="source-help">IP addresses appear after network discovery.</p>

            <details class="hostname-options"><summary>DNS options</summary>
            <CindorFormField label="DNS target IP" description="Select the device address this hostname should resolve to.">
              <CindorSelect v-model="form.dnsTargetIp" class="dns-select" :disabled="dnsBusy" aria-label="DNS target IP">
                <option value="">Select an IPv4 address</option>
                <option v-for="ip in dnsAddresses" :key="ip" :value="ip">{{ ip }}</option>
              </CindorSelect>
              <p v-if="dnsPreview" class="source-help">{{ dnsPreview }}</p>
              <p v-if="!dnsState?.configured" class="source-help">DNS controller setup is required before publishing hostname changes.</p>
              <p v-if="dnsBusy" class="source-help" role="status">DNS update {{ dnsState.operation.state === 'pending' ? 'queued' : 'deploying' }}. Inventory details can still be edited.</p>
            </CindorFormField>

            </details>

            <CindorFormRow :columns="2">
              <CindorFormField label="MAC address">
                <CindorInput
                  v-model="form.mac"
                  name="mac"
                  placeholder="aa:bb:cc:dd:ee:ff"
                />
              </CindorFormField>

              <CindorFormField label="Detected VLANs">
                <div class="tag-preview" aria-live="polite">
                  <CindorTag v-for="vlan in detectedVlans" :key="vlan.id" tone="neutral">
                    <VlanColorIndicator :color="vlan.color" />VLAN {{ vlan.vlanId }} — {{ vlan.name }}
                  </CindorTag>
                  <span v-if="!detectedVlans.length">No matching network</span>
                </div>
              </CindorFormField>
            </CindorFormRow>

            <CindorFormField v-if="detectedReservedRanges.length" label="Reserved ranges">
              <div class="tag-preview" aria-live="polite">
                <CindorTag v-for="range in detectedReservedRanges" :key="range.id" tone="neutral">
                  {{ range.name }}
                </CindorTag>
              </div>
            </CindorFormField>

            <CindorFormField
              label="Tags"
              description="Separate tags with commas."
            >
              <CindorInput
                v-model="form.tagsText"
                name="tags"
                placeholder="server, media, lab"
              />
            </CindorFormField>

            <div v-if="parsedTags.length" class="tag-preview">
              <CindorTag v-for="tag in parsedTags" :key="tag" tone="accent">
                {{ tag }}
              </CindorTag>
            </div>

            <CindorFormField label="Notes">
              <CindorTextarea v-model="form.notes" name="notes" />
            </CindorFormField>



            <div class="editor-actions">
              <CindorButton type="submit">
                {{ isCreate ? "Create device" : "Save changes" }}
              </CindorButton>
              <CindorButton variant="ghost" @click="resetForm()">
                Reset
              </CindorButton>
            </div>
          </CindorForm>
        </section>

        <div class="sidebar">
          <section class="sidebar-card">
            <div class="section-header section-header--stacked">
              <div>
                <h2>Details</h2>
              </div>
              <CindorBadge :tone="statusTone(deviceStatus)">
                {{ deviceStatus.toUpperCase() }}
              </CindorBadge>
            </div>

            <dl class="detail-list">
              <div>
                <dt>Primary label</dt>
                <dd>{{ effectiveName }}</dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>{{ formatTimestamp(props.device?.lastSeen) }}</dd>
              </div>
              <div>
                <dt>Discovery key</dt>
                <dd>{{ props.device?.deviceKey || "Created manually" }}</dd>
              </div>
            </dl>
          </section>

          <section v-if="!isCreate" class="sidebar-card">
            <div class="section-header section-header--stacked">
              <div>
                <h2>Linked sources</h2>
                <p class="source-help">Systems with records linked to this device. Each system may contain several records.</p>
              </div>
            </div>

            <div class="source-list">
              <div
                v-for="group in sourceGroups"
                :key="group.source"
                class="source-item"
              >
                <h3>{{ group.name }}</h3>
                <p v-if="group.description" class="source-help">{{ group.description }}</p>
                <details>
                  <summary>
                    {{ group.records.length }} linked {{ group.records.length === 1 ? group.type : (group.plural || `${group.type}s`) }}
                  </summary>
                  <ul class="source-records">
                    <li v-for="record in group.records" :key="record.sourceId">
                      <strong v-if="record.name && record.name !== record.sourceId">{{ record.name }}</strong>
                      <span>{{ group.idLabel }}: <code>{{ record.sourceId }}</code></span>
                      <small>{{ record.linkMethod === 'manual' ? 'Linked manually' : record.linkMethod === 'network_identity' ? 'Matched by network identity' : 'Existing link' }}</small>
                      <small>Last seen {{ formatTimestamp(record.lastSeen) }}</small>
                    </li>
                  </ul>
                </details>
              </div>
              <p v-if="!sourceGroups.length" class="source-help">No source records are linked to this device yet.</p>
            </div>
          </section>
        </div>
      </div>

      <template #fallback
        ><div class="surface form-loading" role="status">
          Loading device editor…
        </div></template
      >
    </ClientOnly>
  </div>
</template>

<style scoped>
.dns-select { min-width:0; --cindor-field-inline-size:100%; }
.editor-shell {
  display: grid;
  gap: 1.5rem;
}

/* Keep the required marker from increasing the label row's line box. */
.editor-card :deep(cindor-form-field)::part(label-row) {
  font-size: var(--text-label-size);
  line-height: var(--text-label-leading);
}

.form-loading {
  padding: 32px;
  color: var(--fg-muted);
}
.editor-card,
.sidebar-card {
  background: var(--theme-raised, white);
  border: 1px solid var(--border-muted);
  min-width: 0;
}
.ip-card {
  background: var(--theme-success-bg, #f8fbf9);
}
.detail-list dd {
  overflow-wrap: anywhere;
}

.editor-grid {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: minmax(0, 2.1fr) minmax(280px, 0.9fr);
}

.editor-card,
.sidebar-card,
.ip-card {
  display: block;
  padding: 1.25rem;
}

.sidebar {
  display: grid;
  gap: 1rem;
  align-self: start;
}

.tag-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.assignment-resolution {
  margin: 0;
  min-height: 3rem;
  color: var(--fg-muted);
  line-height: 1.5;
}

.discovered-ip-list {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.5;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.ip-section {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
}

.ip-rows {
  display: grid;
  gap: 1rem;
}

.primary-toggle {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  min-height: 3rem;
}

.editor-actions,
.row-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 1rem;
}

.section-header {
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  align-items: start;
  flex-wrap: wrap;
}

.section-header > div {
  flex: 1;
  min-width: 150px;
}
.section-header cindor-badge {
  flex-shrink: 0;
  white-space: nowrap;
}

.section-header--stacked {
  margin-bottom: 1rem;
}

.section-header h2 {
  margin: 0;
  font-size: 1rem;
}

.detail-list {
  display: grid;
  gap: 0.9rem;
  margin: 0;
}

.detail-list div {
  display: grid;
  gap: 0.2rem;
}

.detail-list dt {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-subtle);
}

.detail-list dd {
  margin: 0;
  font-weight: 600;
}

.source-list {
  display: grid;
  gap: 0.75rem;
}

.source-item {
  display: grid;
  gap: 0.2rem;
  padding: 0.85rem 0.95rem;
  border-radius: 0.75rem;
  border: 1px solid var(--border-muted);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-raised));
}

.source-item span,
.source-item small,
.source-item code {
  overflow-wrap: anywhere;
}

.source-item h3 {
  margin: 0;
  font-size: 0.95rem;
}

.source-help {
  margin: 0.5rem 0;
  color: var(--fg-muted);
  font-size: 0.85rem;
  line-height: 1.5;
}

.source-item summary {
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0.5rem 0;
}

.source-item summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.source-records {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.75rem;
}

.source-records li {
  display: grid;
  gap: 0.3rem;
  border-top: 1px solid var(--border-muted);
  padding-top: 0.75rem;
  font-size: 0.85rem;
}

@media (max-width: 980px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .editor-card,
  .sidebar-card,
  .ip-card {
    padding: 1rem;
  }
}
</style>
