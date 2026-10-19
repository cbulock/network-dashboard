<script setup>
import {
  CindorButton,
  CindorColorInput,
  CindorInput,
  CindorFormField,
  CindorTextarea,
} from "cindor-ui-vue";
import { normalizeIpRange, matchVlanForRange } from "~/utils/network-match.js";

useHead({ title: "Network" });

const {
  data: lookups,
  pending,
  error,
  refresh,
} = useFetch("/api/inventory/lookups", {
  lazy: true,
  default: () => ({
    tags: [],
    vlans: [],
    reservedRanges: [],
    virtualSubnets: [],
  }),
});

const { data: devicesData, pending: devicesPending, error: devicesError, refresh: refreshDevices } = useFetch(
  "/api/inventory/devices",
  {
    lazy: true,
    default: () => ({ devices: [] }),
  },
);

const vlanForm = reactive({
  vlanId: "",
  name: "",
  subnet: "",
  description: "",
  color: "",
});
const reservedRangeForm = reactive({
  name: "",
  slug: "",
  startIp: "",
  endIp: "",
  description: "",
});

const rangePreview = computed(() => {
  if (!reservedRangeForm.startIp && !reservedRangeForm.endIp) {
    return { label: "Enter the start and end IPs to automatically match a VLAN." };
  }
  try {
    const { startIp, endIp } = normalizeIpRange(reservedRangeForm.startIp, reservedRangeForm.endIp);
    const vlan = matchVlanForRange(startIp, endIp, lookups.value?.vlans ?? []);
    return vlan
      ? { label: `VLAN ${vlan.vlanId} — ${vlan.name}`, color: vlan.color }
      : { label: "No VLAN subnet contains this entire range. It will be saved without a VLAN." };
  } catch (error) {
    return { label: error.message };
  }
});

const editingVlanId = ref(null);
const editingRangeId = ref(null);
function resetVlan() {
  editingVlanId.value = null;
  Object.assign(vlanForm, { vlanId: '', name: '', subnet: '', description: '', color: '' });
}
function resetRange() {
  editingRangeId.value = null;
  Object.assign(reservedRangeForm, { name: '', slug: '', startIp: '', endIp: '', description: '' });
}
async function editVlan(vlan) {
  editingVlanId.value = vlan.id;
  for (const key of Object.keys(vlanForm)) vlanForm[key] = String(vlan[key] ?? '');
  errorMessage.value = '';
  await nextTick();
  document.getElementById('vlan-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('[name="vlanId"]')?.focus();
}
async function editRange(range) {
  editingRangeId.value = range.id;
  for (const key of Object.keys(reservedRangeForm)) reservedRangeForm[key] = range[key] ?? '';
  errorMessage.value = '';
  await nextTick();
  document.getElementById('range-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('[name="rangeName"]')?.focus();
}
const saving = ref(false);
const errorMessage = ref("");

const devices = computed(() => devicesData.value?.devices ?? []);
const vlanUsage = computed(() =>
  (lookups.value?.vlans ?? []).map((vlan) => ({
    ...vlan,
    deviceCount: devices.value.filter((device) => device.vlans?.some((match) => match.id === vlan.id))
      .length,
  })),
);
const subnetUsage = computed(() =>
  (lookups.value?.reservedRanges ?? lookups.value?.virtualSubnets ?? []).map(
    (range) => ({
      ...range,
      ipCount: devices.value.reduce(
        (sum, device) =>
          sum +
          (device.reservedRanges?.find((match) => match.id === range.id)?.ips.length ?? 0),
        0,
      ),
    }),
  ),
);

function rangeVlan(range) { return lookups.value?.vlans?.find(vlan => vlan.id === range.vlanId); }
function rangeVlanLabel(range) {
  const vlan = lookups.value?.vlans?.find((vlan) => vlan.id === range.vlanId);
  return vlan ? `VLAN ${vlan.vlanId} — ${vlan.name}` : "No matching VLAN";
}

async function createVlan() {
  errorMessage.value = "";
  saving.value = true;

  try {
    await $fetch(editingVlanId.value ? `/api/inventory/vlans/${editingVlanId.value}` : "/api/inventory/vlans", {
      method: editingVlanId.value ? "PUT" : "POST",
      body: {
        vlanId: Number(vlanForm.vlanId),
        name: vlanForm.name,
        subnet: vlanForm.subnet || null,
        description: vlanForm.description || null,
        color: vlanForm.color || null,
      },
    });

    resetVlan();

    await Promise.all([refresh(), refreshDevices()]);
  } catch (error) {
    errorMessage.value =
      error?.data?.statusMessage || error?.message || "Unable to save VLAN.";
  } finally {
    saving.value = false;
  }
}

async function createSubnet() {
  errorMessage.value = "";
  saving.value = true;

  try {
    const { startIp, endIp } = normalizeIpRange(reservedRangeForm.startIp, reservedRangeForm.endIp);
    await $fetch(editingRangeId.value ? `/api/inventory/reserved-ranges/${editingRangeId.value}` : "/api/inventory/reserved-ranges", {
      method: editingRangeId.value ? "PUT" : "POST",
      body: {
        name: reservedRangeForm.name,
        slug: reservedRangeForm.slug || null,
        startIp,
        endIp,
        description: reservedRangeForm.description || null,
      },
    });

    resetRange();

    await Promise.all([refresh(), refreshDevices()]);
  } catch (error) {
    errorMessage.value =
      error?.data?.statusMessage ||
      error?.message ||
      "Unable to save reserved range.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page-grid">
    <header class="page-heading">
      <div>
        <h1>Network</h1>
      </div>
      <NuxtLink to="/reserved-ranges" class="ui-button"
        ><AppIcon name="layers" :size="16" />View reserved ranges</NuxtLink
      >
    </header>

    <p v-if="pending || devicesPending" role="status">Loading network data…</p>
    <p v-else-if="error || devicesError" role="alert">{{ (error || devicesError).statusMessage || (error || devicesError).message }}</p>
    <template v-else>
      <p v-if="errorMessage" class="error-copy" role="alert">{{ errorMessage }}</p>
      <ClientOnly>
        <section class="content-grid">
          <section class="panel">
            <div class="form-heading">
              <span class="form-icon"><AppIcon name="network" /></span>
              <div>
                <h2 id="vlan-editor">{{ editingVlanId ? "Edit VLAN" : "Create VLAN" }}</h2>
              </div>
            </div>
            <div class="form-grid">
              <CindorFormField label="VLAN ID"
                ><CindorInput
                  v-model="vlanForm.vlanId"
                  name="vlanId"
                  type="number"
                  placeholder="10"
              /></CindorFormField>
              <CindorFormField label="Name"
                ><CindorInput
                  v-model="vlanForm.name"
                  name="vlanName"
                  placeholder="Servers"
              /></CindorFormField>
              <CindorFormField label="Network range (CIDR)" description="Device IPs are automatically matched to this range."
                ><CindorInput
                  v-model="vlanForm.subnet"
                  name="subnet"
                  placeholder="192.168.10.0/24"
              /></CindorFormField>
              <CindorFormField label="Color (optional)"
                ><CindorColorInput
                  v-model="vlanForm.color"
                  :class="{ 'color-empty': !vlanForm.color }"
                  name="color"
                />
                <CindorButton v-if="vlanForm.color" @click="vlanForm.color = ''">Clear color</CindorButton>
              </CindorFormField>
            </div>
            <CindorFormField label="Description">
              <CindorTextarea v-model="vlanForm.description" />
            </CindorFormField>
            <div class="actions">
              <CindorButton :disabled="saving" @click="createVlan">
                Save VLAN
              </CindorButton>
              <CindorButton v-if="editingVlanId" :disabled="saving" @click="resetVlan">Cancel</CindorButton>
            </div>
          </section>

          <section class="panel">
            <div class="form-heading">
              <span class="form-icon"><AppIcon name="layers" /></span>
              <div>
                <h2 id="range-editor">{{ editingRangeId ? "Edit reserved range" : "Create reserved range" }}</h2>
              </div>
            </div>
            <div class="form-grid">
              <CindorFormField label="Name"
                ><CindorInput
                  v-model="reservedRangeForm.name"
                  name="rangeName"
                  placeholder="Infrastructure"
              /></CindorFormField>
              <CindorFormField label="Slug (optional)"
                ><CindorInput
                  v-model="reservedRangeForm.slug"
                  name="rangeSlug"
                  placeholder="infrastructure"
              /></CindorFormField>
              <CindorFormField label="Start IP" description="First address in the reserved range (included).">
                <CindorInput v-model="reservedRangeForm.startIp" name="rangeStartIp" placeholder="192.168.10.10" />
              </CindorFormField>
              <CindorFormField label="End IP" description="Last address in the reserved range (included).">
                <CindorInput v-model="reservedRangeForm.endIp" name="rangeEndIp" placeholder="192.168.10.50" />
              </CindorFormField>
            </div>
            <p class="range-preview" role="status"><VlanColorIndicator :color="rangePreview.color" />{{ rangePreview.label }}</p>
            <CindorFormField label="Description">
              <CindorTextarea v-model="reservedRangeForm.description" />
            </CindorFormField>
            <div class="actions">
              <CindorButton :disabled="saving" @click="createSubnet">
                Save reserved range
              </CindorButton>
              <CindorButton v-if="editingRangeId" :disabled="saving" @click="resetRange">Cancel</CindorButton>
            </div>
          </section>
        </section>

        <section class="content-grid">
          <section class="panel">
            <h2>VLAN usage</h2>
            <div v-if="vlanUsage.length" class="summary-list">
              <div
                v-for="vlan in vlanUsage"
                :key="vlan.id"
                class="summary-item"
              >
                <strong><VlanColorIndicator :color="vlan.color" />VLAN {{ vlan.vlanId }} — {{ vlan.name }}</strong>
                <span
                  >{{ vlan.deviceCount }} device{{
                    vlan.deviceCount === 1 ? "" : "s"
                  }}</span
                >
                <small>{{ vlan.subnet || "No subnet defined" }}</small>
                <small v-if="vlan.description">{{ vlan.description }}</small>
              <div class="actions"><NuxtLink :to="{ path: '/', query: { vlanId: vlan.id } }" class="ui-button">View devices</NuxtLink><CindorButton :disabled="saving" :aria-label="`Edit VLAN ${vlan.name}`" @click="editVlan(vlan)">Edit</CindorButton></div></div>
            </div>
            <p v-else>No VLANs.</p>
          </section>

          <section class="panel">
            <h2>Reserved range usage</h2>
            <div v-if="subnetUsage.length" class="summary-list">
              <div
                v-for="range in subnetUsage"
                :key="range.id"
                class="summary-item"
              >
                <strong>{{ range.name }}</strong>
                <small v-if="range.startIp && range.endIp">{{ range.startIp }} – {{ range.endIp }}</small>
                <small v-else>No IP boundaries defined</small>
                <small><VlanColorIndicator :color="rangeVlan(range)?.color" />{{ rangeVlanLabel(range) }}</small>
                <span
                  >{{ range.ipCount }} IP{{
                    range.ipCount === 1 ? "" : "s"
                  }}</span
                >
                <small v-if="range.description">{{ range.description }}</small>
              <div class="actions"><NuxtLink :to="{ path: '/', query: { reservedRangeId: range.id } }" class="ui-button">View devices</NuxtLink><CindorButton :disabled="saving" :aria-label="`Edit reserved range ${range.name}`" @click="editRange(range)">Edit</CindorButton></div></div>
            </div>
            <p v-else>No reserved ranges.</p>
          </section>
        </section>
        <template #fallback
          ><div class="surface form-loading" role="status">
            Loading network controls…
          </div></template
        >
      </ClientOnly>
    </template>
  </div>
</template>

<style scoped>
.page-grid {
  display: grid;
  gap: 1.5rem;
}

.content-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  display: grid;
  align-content: start;
  gap: 1rem;
  padding: 1.25rem;
}

.panel h2 {
  margin: 0;
  font-size: 16px;
}

.form-loading {
  padding: 32px;
  color: var(--fg-muted);
}
.form-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.form-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--theme-success-bg, #eaf4ee);
  color: var(--accent);
}
.panel {
  background: var(--theme-raised, white);
  border: 1px solid var(--border-muted);
}

.form-grid {
  display: grid;
  align-items: start;
  gap: 0.85rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.color-empty::part(value)::after {
  content: "None";
}

.color-empty::part(swatch) {
  background: transparent;
}

.actions {
  display: flex;
  gap: 0.75rem;
}

.summary-list {
  display: grid;
  align-content: start;
  gap: 0.85rem;
}

.summary-item {
  display: grid;
  gap: 0.25rem;
  padding: 0.9rem 1rem;
  border-radius: 0.8rem;
  border: 1px solid var(--border-muted);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-raised));
}

.error-copy {
  color: var(--danger);
  margin: 0;
}

.range-preview {
  margin: 0;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.summary-item {
  overflow-wrap: anywhere;
  color: inherit;
  text-decoration: none;
}

.summary-item:hover {
  border-color: var(--accent);
}

.summary-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

@media (max-width: 900px) {
  .content-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }

  .panel {
    padding: 1rem;
  }
}
</style>
