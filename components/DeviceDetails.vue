<script setup>
import { CindorSelect } from "cindor-ui-vue";
import {
  devicePresentation,
  sectionValues,
  sectionChanges,
  sectionPayload,
  acceptSectionSave,
  friendlyError,
  hostIp,
} from "~/utils/device-presentation.js";
import { formatTimestamp } from "~/utils/format-date.js";
import { DEVICE_TYPES, DEVICE_ROLES } from "~/utils/inventory-model.js";
const route = useRoute();
const returnTo = computed(() =>
  route.query.from === "cleanup" ? "/cleanup" : "/",
);

const props = defineProps({
  device: { type: Object, required: true },
  lookups: { type: Object, required: true },
  lookupError: { type: Boolean, default: false },
});
const confirmed = ref(props.device);
const view = computed(() => devicePresentation(confirmed.value, props.lookups));
useHead({ title: () => view.value.title });
const sections = reactive({});
const busy = ref("");
const refreshing = ref(false);
const refreshError = ref("");
const networkError = ref("");
const addressEditing = ref(false);
const addressDirty = ref(false);
const addressSaving = ref(false);
const tagInput = ref("");
const root = ref(null);
const dnsRepair = ref(false);
const repairTarget = ref("");
const repairRevision = ref(null);
const pendingRetry = ref(false);
let retryBaseline = null;
const diagnostic = ref("");
let timer,
  requestVersion = 0;
const baseUrl = computed(() => `/api/inventory/devices/${confirmed.value.id}`);
const networkEditing = computed(
  () =>
    addressEditing.value ||
    Boolean(sections.hostname || sections.mac) ||
    dnsRepair.value,
);
const saving = computed(() => Boolean(busy.value || addressSaving.value));
const dirty = computed(
  () =>
    addressDirty.value ||
    dnsRepair.value ||
    Object.values(sections).some(
      (section) =>
        Object.keys(sectionChanges(section.draft, section.baseline)).length,
    ) ||
    Boolean(sections.organization && tagInput.value.trim()),
);
const suggestions = computed(() =>
  (props.lookups.tags || [])
    .map((tag) => tag.name)
    .filter(
      (name) =>
        !sections.organization?.draft.tags.includes(name) &&
        name.toLowerCase().includes(tagInput.value.toLowerCase()),
    )
    .slice(0, 8),
);
const observedWork = ref(false);
watch(
  () => view.value.operation?.active,
  (active) => {
    if (active) observedWork.value = true;
  },
  { immediate: true },
);
const operation = computed(() => {
  if (pendingRetry.value) return { label: "DNS retry requested", tone: "info" };
  const value = view.value.operation;
  return value?.tone === "success" && !observedWork.value ? null : value;
});
const dnsNeedsRepair = computed(
  () => view.value.dnsState === "mismatch" || view.value.dnsState === "failed",
);
const retryOnly = computed(
  () =>
    confirmed.value.dns?.operation?.state === "failed" &&
    !confirmed.value.dns.operation.remote?.conflict,
);
const canRepair = computed(
  () =>
    !pendingRetry.value &&
    !view.value.operation?.active &&
    !saving.value &&
    !networkEditing.value &&
    (retryOnly.value ||
      (confirmed.value.dns?.moveSupported &&
        view.value.ipv4.length &&
        confirmed.value.unifi?.connected)),
);
function isDirty(key) {
  const section = sections[key];
  return (
    section &&
    Object.keys(sectionChanges(section.draft, section.baseline)).length > 0
  );
}
async function focus(selector) {
  await nextTick();
  const target = root.value?.querySelector(selector);
  await target?.updateComplete;
  (target && !target.disabled
    ? target
    : root.value?.querySelector("#network-title")
  )?.focus();
}
function start(key) {
  const baseline = sectionValues(confirmed.value, key);
  sections[key] = {
    baseline,
    draft: structuredClone(baseline),
    revision: confirmed.value.dns?.revision,
    error: "",
    notice: "",
  };
  if (key === "hostname" && view.value.ipv4.length === 1)
    sections[key].draft.targetIp = view.value.ipv4[0];
  if (key === "organization") tagInput.value = "";
  void focus(`[data-editor="${key}"] ${key === 'organization' ? 'select' : 'input'}`);
}
function close(key) {
  delete sections[key];
  if (key === "organization") tagInput.value = "";
  void focus(`[data-edit="${key}"]`);
}
function accept(device) {
  if (device?.id !== confirmed.value.id) return;
  confirmed.value = device;
  if (
    device.dns?.operation?.state !== "failed" ||
    device.dns?.operation?.updatedAt !== retryBaseline
  )
    pendingRetry.value = false;
}
function acceptAddress(device) {
  requestVersion++;
  // Availability refreshes only own network facts, not concurrently saved labels or notes.
  const keys = [
    "primaryIp",
    "allIps",
    "ips",
    "discoveredIps",
    "unifi",
    "dns",
    "dnsComparison",
    "vlans",
    "vlan",
    "reservedRanges",
  ];
  confirmed.value = {
    ...confirmed.value,
    ...Object.fromEntries(
      keys.filter((key) => key in device).map((key) => [key, device[key]]),
    ),
  };
}
async function save(key) {
  if (saving.value) return;
  const section = sections[key];
  if (key === "organization") addTag();
  const payload = sectionPayload(
    key,
    section.draft,
    section.baseline,
    section.revision,
  );
  if (!payload) return;
  if (
    key === "hostname" &&
    (!section.draft.hostname.trim() ||
      !view.value.ipv4.includes(section.draft.targetIp))
  ) {
    section.error = "Enter a hostname and select a reported IPv4 address.";
    return;
  }
  if (["hostname", "mac"].includes(key) && view.value.networkBusy) {
    section.error = "Wait for the current network update to finish.";
    return;
  }
  busy.value = key;
  section.error = "";
  requestVersion++;
  try {
    const result = await $fetch(baseUrl.value, {
      method: "PATCH",
      body: payload,
    });
    accept(acceptSectionSave(confirmed.value, result.device, key));
    close(key);
    if (key !== "hostname")
      notices[key] =
        key === "name"
          ? "Name saved."
          : key === "mac"
            ? "MAC address saved."
            : "Organization saved.";
  } catch (error) {
    section.error = friendlyError(error);
    diagnostic.value = error?.data?.statusMessage || error.message;
    section.conflict = (error?.statusCode || error?.status) === 409;
  } finally {
    busy.value = "";
  }
}
const notices = reactive({});
function addTag(value = tagInput.value) {
  const draft = sections.organization?.draft;
  if (!draft) return;
  for (const tag of String(value)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (
      !draft.tags.some(
        (existing) => existing.toLowerCase() === tag.toLowerCase(),
      )
    )
      draft.tags.push(tag);
  }
  tagInput.value = "";
}
function tagKey(event) {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addTag();
  }
}
async function refresh(live = false) {
  if (refreshing.value || saving.value) return;
  const version = ++requestVersion;
  refreshing.value = true;
  try {
    const result = await $fetch(
      `${baseUrl.value}/${live ? "unifi-refresh" : "unifi"}`,
      live ? { method: "POST", body: {} } : {},
    );
    if (version !== requestVersion) return;
    accept(result.device);
    refreshError.value = "";
  } catch (error) {
    if (version === requestVersion)
      refreshError.value =
        "Unable to refresh device information. Showing the last available values.";
    diagnostic.value = error?.data?.statusMessage || error.message;
  } finally {
    refreshing.value = false;
  }
}
async function refreshConflict(key) {
  await refresh();
  if (refreshError.value) return;
  const section = sections[key];
  if (!section) return;
  section.revision = confirmed.value.dns?.revision;
  section.error = "";
  section.conflict = false;
  section.notice = `Latest saved hostname: ${confirmed.value.hostname || "None"}. Your draft is retained; review before applying.`;
}
function startAddress() {
  addressEditing.value = true;
}
function closeAddress() {
  addressEditing.value = false;
  addressDirty.value = false;
  void focus('[data-edit="address"]');
}
function addressApplied(device) {
  acceptAddress(device);
  closeAddress();
}
function openRepair() {
  dnsRepair.value = true;
  repairTarget.value = hostIp(confirmed.value.dns?.targetIp);
  if (!view.value.ipv4.includes(repairTarget.value))
    repairTarget.value = view.value.ipv4[0] || "";
  repairRevision.value = confirmed.value.dns?.revision;
  void focus(
    '[data-editor="repair"] cindor-select, [data-editor="repair"] button',
  );
}
async function repairDns() {
  if (saving.value) return;
  busy.value = "repair";
  networkError.value = "";
  requestVersion++;
  try {
    if (retryOnly.value) {
      retryBaseline = confirmed.value.dns?.operation?.updatedAt;
      await $fetch(`${baseUrl.value}/dns-retry`, { method: "POST", body: {} });
      pendingRetry.value = true;
      observedWork.value = true;
    } else {
      const result = await $fetch(`${baseUrl.value}/dns-reconcile`, {
        method: "POST",
        body: {
          targetIp: repairTarget.value,
          expectedRevision: repairRevision.value,
        },
      });
      accept(result.device);
    }
    dnsRepair.value = false;
    void focus('[data-edit="repair"]');
  } catch (error) {
    networkError.value = friendlyError(error);
    diagnostic.value = error?.data?.statusMessage || error.message;
  } finally {
    busy.value = "";
  }
}
function beforeUnload(event) {
  if (dirty.value || saving.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
function mayLeave() {
  return (
    !(dirty.value || saving.value) ||
    window.confirm(
      saving.value
        ? "A change is being saved. Leave this device?"
        : "Discard unsaved changes and leave this device?",
    )
  );
}
onBeforeRouteLeave(mayLeave);
onBeforeRouteUpdate(mayLeave);
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  timer = setInterval(() => {
    if (view.value.operation?.active || pendingRetry.value) void refresh();
  }, 3000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  requestVersion++;
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <!-- Reflect values before Cindor connects so its option initialization preserves drafts. -->
  <div ref="root" class="device-workspace">
    <header class="device-heading">
      <div class="heading-identity">
        <div class="title-line">
          <h1>{{ view.title }}</h1>
          <span class="health" :class="view.health.tone"
            ><span aria-hidden="true" class="health-dot" />{{
              view.health.label
            }}</span
          >
        </div>
        <button
          v-if="!sections.name"
          type="button"
          class="text-action"
          data-edit="name"
          @click="start('name')"
        >
          Edit name
        </button>
        <form
          v-else
          data-editor="name"
          class="section-editor name-editor"
          @submit.prevent="save('name')"
        >
          <label
            >Friendly label <span class="optional">Optional</span
            ><input
              v-model="sections.name.draft.displayName"
              autocomplete="off"
              placeholder="Use hostname"
              :disabled="busy === 'name'"
          /></label>
          <p v-if="sections.name.error" class="error" role="alert">
            {{ sections.name.error }}
          </p>
          <div class="actions">
            <button
              class="ui-button primary"
              :disabled="saving || !isDirty('name')"
            >
              {{ busy === "name" ? "Saving…" : "Save name" }}</button
            ><button
              type="button"
              class="ui-button"
              :disabled="busy === 'name'"
              @click="close('name')"
            >
              Cancel
            </button>
          </div>
        </form>
        <span
          v-if="notices.name && !sections.name"
          class="saved-notice"
          role="status"
          >{{ notices.name }}</span
        >
      </div>
      <NuxtLink class="ui-button" :to="returnTo"
        >Back to results <AppIcon name="arrow" :size="16"
      /></NuxtLink>
    </header>



    <section class="detail-section" aria-labelledby="network-title">
      <div class="section-heading">
        <h2 id="network-title" tabindex="-1">Network &amp; DNS</h2>
        <button
          type="button"
          class="ui-button"
          :disabled="refreshing || saving || addressEditing"
          @click="refresh(true)"
        >
          <AppIcon name="refresh" :size="16" />{{
            refreshing ? "Refreshing…" : "Refresh"
          }}
        </button>
      </div>
      <p v-if="lookupError" class="error" role="alert">
        Network labels and address ranges are unavailable. Refresh the page to
        try again.
      </p>
      <p v-if="refreshError" class="error" role="alert">
        {{ refreshError }}
        <button type="button" class="text-action" @click="refresh()">
          Retry
        </button>
      </p>
      <div class="network-values">
        <div class="network-field">
          <div class="value-label">
            IP address <span class="subtle-badge">{{ view.mode }}</span>
          </div>
          <div class="value-line">
            <CopyValue
              v-if="view.primary"
              :value="view.primary.ip"
              label="IP address"
              class="mono primary-value"
            /><span v-else class="muted">No address reported</span>
            <button
              v-if="confirmed.unifi?.editable && !addressEditing"
              type="button"
              class="text-action"
              data-edit="address"
              :disabled="
                saving ||
                networkEditing ||
                !view.canChangeAddress ||
                pendingRetry
              "
              @click="startAddress"
            >
              Change address
            </button>
          </div>
          <div v-if="view.primary" class="network-context">
            <span
              ><VlanColorIndicator :color="view.primary.network?.color" />{{ view.primary.network?.name || "No matching network"
              }}<span v-if="view.primary.network" class="muted">
                · VLAN {{ view.primary.network.vlanId }}</span
              ></span
            ><span v-if="view.primary.range">{{
              view.primary.range.name
            }}</span>
          </div>
          <p v-if="!confirmed.unifi?.editable" class="muted capability-note">
            Address changes are unavailable for this device.
            <a
              href="#device-sources"
              @click="root.querySelector('#device-sources').open = true"
              >See sources</a
            >.
          </p>
        </div>
        <div class="network-field">
          <div class="value-label">Hostname</div>
          <div class="value-line">
            <CopyValue
              v-if="confirmed.hostname"
              :value="confirmed.hostname"
              label="hostname"
              class="mono primary-value"
            /><span v-else class="muted">No hostname</span>
            <button
              v-if="!sections.hostname"
              type="button"
              class="text-action"
              data-edit="hostname"
              :disabled="
                saving ||
                networkEditing ||
                !view.canChangeHostname ||
                !view.ipv4.length ||
                pendingRetry
              "
              @click="start('hostname')"
            >
              {{ confirmed.hostname ? "Edit hostname" : "Add hostname" }}
            </button>
          </div>
          <p v-if="!confirmed.dns?.configured" class="muted capability-note">
            Hostname changes require a configured DNS service.
          </p>
          <p v-else-if="!view.ipv4.length" class="muted capability-note">
            A reported IPv4 address is needed to configure DNS.
          </p>
          <p
            v-if="!operation"
            class="dns-state"
            :class="{ warning: dnsNeedsRepair }"
          >
            <AppIcon
              :name="
                view.dnsState === 'matched'
                  ? 'check'
                  : dnsNeedsRepair
                    ? 'warning'
                    : 'globe'
              "
              :size="16"
            />{{ view.dnsLabel }}
          </p>
        </div>
      </div>

      <details v-if="view.additional.length" class="additional-addresses">
        <summary>
          +{{ view.additional.length }}
          {{ view.additional.length === 1 ? "address" : "addresses" }}
        </summary>
        <ul class="address-list">
          <li v-for="row in view.additional" :key="row.ip">
            <CopyValue :value="row.ip" label="IP address" class="mono" /><span
              class="muted"
              ><VlanColorIndicator :color="row.network?.color" />{{ row.network?.name || "No matching network"
              }}<template v-if="row.network">
                · VLAN {{ row.network.vlanId }}</template
              ><template v-if="row.range">
                · {{ row.range.name }}</template
              ></span
            >
          </li>
        </ul>
      </details>

      <div
        v-if="operation"
        class="operation"
        :class="operation.tone"
        role="status"
      >
        <AppIcon
          :name="
            operation.tone === 'danger'
              ? 'warning'
              : operation.tone === 'success'
                ? 'check'
                : 'refresh'
          "
          :size="18"
        />
        <div>
          <strong>{{ operation.label }}</strong>
          <p v-if="operation.error">
            {{ friendlyError({ message: operation.error }) }}
          </p>
          <p
            v-if="
              confirmed.unifi?.configuredIp &&
              !view.addresses.some(
                (row) => row.ip === hostIp(confirmed.unifi.configuredIp),
              )
            "
          >
            Requested address:
            <span class="mono">{{ hostIp(confirmed.unifi.configuredIp) }}</span>
          </p>
        </div>
      </div>
      <p v-if="networkError" class="error" role="alert">{{ networkError }}</p>
      <div v-if="dnsNeedsRepair" class="dns-repair">
        <div v-if="view.dnsState === 'mismatch'">
          <span class="value-label"
            >DNS record differs from the reported address above</span
          >
          <div
            v-for="record in confirmed.dnsComparison?.mismatches || []"
            :key="record.ip"
            class="mono"
          >
            {{ record.ip }}
          </div>
        </div>
        <button
          v-if="!dnsRepair"
          type="button"
          class="ui-button"
          data-edit="repair"
          :disabled="!canRepair"
          @click="openRepair"
        >
          {{ retryOnly ? "Retry DNS update" : "Update DNS" }}
        </button>
        <p
          v-if="
            !canRepair &&
            !dnsRepair &&
            !networkEditing &&
            !saving &&
            !view.operation?.active &&
            !pendingRetry
          "
          class="muted"
        >
          {{
            confirmed.dns?.operation?.remote?.conflict
              ? "DNS records changed. Refresh and review the current record before updating."
              : "DNS updates require a connected device and support for address updates. See Sources for details."
          }}
        </p>
        <form
          v-if="dnsRepair"
          data-editor="repair"
          class="section-editor"
          @submit.prevent="repairDns"
        >
          <template v-if="!retryOnly"
            ><label
              >DNS target address<CindorSelect
                v-model="repairTarget"
                :value.attr="repairTarget"
                aria-label="DNS target address"
                :disabled="saving"
              >
                <option v-for="ip in view.ipv4" :key="ip" :value="ip">
                  {{ ip }}
                </option>
              </CindorSelect></label
            >
            <p>
              Point {{ confirmed.hostname }} to {{ repairTarget }}. Existing
              aliases move with it.
            </p></template
          >
          <p v-else>
            Retry the failed DNS update. The applied address is retained.
          </p>
          <div class="actions">
            <button
              class="ui-button primary"
              :disabled="saving || (!retryOnly && !repairTarget)"
            >
              {{
                busy === "repair" ? "Submitting…" : "Confirm DNS update"
              }}</button
            ><button
              type="button"
              class="ui-button"
              :disabled="saving"
              @click="
                dnsRepair = false;
                focus('[data-edit=repair]');
              "
            >
              Cancel
            </button>
          </div>
        </form>
      </div>

      <UnifiIpManager
        v-if="addressEditing"
        :device="confirmed"
        :ranges="lookups.reservedRanges || lookups.virtualSubnets || []"
        :blocked="(saving && !addressSaving) || view.networkBusy"
        @updated="acceptAddress"
        @applied="addressApplied"
        @cancel="closeAddress"
        @dirty="addressDirty = $event"
        @saving="
          addressSaving = $event;
          requestVersion++;
        "
      />

      <form
        v-if="sections.hostname"
        data-editor="hostname"
        class="section-editor"
        @submit.prevent="save('hostname')"
      >
        <h3>Edit hostname</h3>
        <div class="form-grid">
          <label
            >Hostname<input
              v-model="sections.hostname.draft.hostname"
              autocomplete="off"
              required
              :disabled="saving || view.networkBusy" /></label
          ><label
            >DNS target address<CindorSelect
              v-model="sections.hostname.draft.targetIp"
              :value.attr="sections.hostname.draft.targetIp"
              aria-label="DNS target address"
              required
              :disabled="saving || view.networkBusy"
            >
              <option value="" disabled>Select an IPv4 address</option>
              <option v-for="ip in view.ipv4" :key="ip" :value="ip">
                {{ ip }}
              </option>
            </CindorSelect></label
          >
        </div>
        <p class="muted">
          Applying publishes this hostname and address to DNS.
        </p>
        <p v-if="sections.hostname.error" class="error" role="alert">
          {{ sections.hostname.error }}
          <button
            v-if="sections.hostname.conflict"
            type="button"
            class="text-action"
            :disabled="refreshing"
            @click="refreshConflict('hostname')"
          >
            Refresh and review
          </button>
        </p>
        <p v-if="sections.hostname.notice" role="status">
          {{ sections.hostname.notice }}
        </p>
        <div class="actions">
          <button
            class="ui-button primary"
            :disabled="saving || view.networkBusy || !isDirty('hostname')"
          >
            {{ busy === "hostname" ? "Applying…" : "Apply hostname" }}</button
          ><button
            type="button"
            class="ui-button"
            :disabled="busy === 'hostname'"
            @click="close('hostname')"
          >
            Cancel
          </button>
        </div>
      </form>

      <details class="technical-details">
        <summary>Technical details</summary>
        <dl class="technical-grid">
          <div>
            <dt>MAC address</dt>
            <dd>
              <CopyValue
                v-if="confirmed.mac"
                :value="confirmed.mac"
                label="MAC address"
                class="mono"
              /><span v-else>Not reported</span
              ><button
                v-if="!sections.mac"
                type="button"
                data-edit="mac"
                class="text-action"
                :disabled="
                  saving || networkEditing || view.networkBusy || pendingRetry
                "
                @click="start('mac')"
              >
                Edit MAC
              </button>
              <p v-if="confirmed.macs?.some(mac => mac !== confirmed.mac)" class="muted">
                Merged MACs: {{ confirmed.macs.filter(mac => mac !== confirmed.mac).join(', ') }}
              </p>
              <div v-if="confirmed.hardware?.addressType" class="mac-hardware">
                <strong>{{ confirmed.hardware.manufacturer || 'Manufacturer unknown' }}</strong>
                <span>{{ confirmed.hardware.addressType }}</span>
                <span v-if="confirmed.hardware.addressType.startsWith('Locally')" class="muted">
                  This MAC does not reliably identify the hardware manufacturer.
                </span>
                <details v-if="confirmed.hardware.prefix" class="hardware-registration">
                  <summary>IEEE registration</summary>
                  <dl>
                    <div><dt>Assigned block</dt><dd class="mono">{{ confirmed.hardware.prefix }} · {{ confirmed.hardware.registry }}</dd></div>
                    <div v-if="confirmed.hardware.registeredAddress"><dt>Registrant address</dt><dd>{{ confirmed.hardware.registeredAddress }}</dd></div>
                  </dl>
                  <a :href="confirmed.hardware.sourceUrl" target="_blank" rel="noopener noreferrer"
                    :title="`Registry snapshot: ${formatTimestamp(confirmed.hardware.updatedAt)}`">IEEE registry</a>
                  <span class="muted"> · Updated {{ formatTimestamp(confirmed.hardware.updatedAt) }}</span>
                </details>
              </div>
            </dd>
          </div>
          <div>
            <dt>Network connection</dt>
            <dd>
              {{
                confirmed.unifi?.error || confirmed.unifi?.mode === "unknown"
                  ? "Unavailable"
                  : confirmed.unifi?.connected
                    ? "Connected"
                    : "Disconnected"
              }}
            </dd>
          </div>
          <div>
            <dt>Address last reported</dt>
            <dd>{{ formatTimestamp(confirmed.unifi?.lastSeen) }}</dd>
          </div>
          <div>
            <dt>DNS last checked</dt>
            <dd>{{ formatTimestamp(confirmed.dns?.lastSync) }}</dd>
          </div>
          <div v-if="view.aliases.length">
            <dt>DNS aliases</dt>
            <dd>
              <span
                v-for="alias in view.aliases"
                :key="alias"
                class="alias mono"
                >{{ alias }}</span
              >
            </dd>
          </div>
        </dl>
        <form
          v-if="sections.mac"
          data-editor="mac"
          class="section-editor"
          @submit.prevent="save('mac')"
        >
          <label
            >MAC address<input
              v-model="sections.mac.draft.mac"
              autocomplete="off"
              placeholder="aa:bb:cc:dd:ee:ff"
              :disabled="saving || view.networkBusy"
          /></label>
          <p class="muted">
            Correct the inventory identity. This does not change the device
            hardware.
          </p>
          <p v-if="sections.mac.error" class="error" role="alert">
            {{ sections.mac.error }}
          </p>
          <div class="actions">
            <button
              class="ui-button primary"
              :disabled="saving || view.networkBusy || !isDirty('mac')"
            >
              Save MAC</button
            ><button
              type="button"
              class="ui-button"
              :disabled="busy === 'mac'"
              @click="close('mac')"
            >
              Cancel
            </button>
          </div>
        </form>
        <p
          v-if="notices.mac && !sections.mac"
          class="saved-notice"
          role="status"
        >
          {{ notices.mac }}
        </p>
      </details>
    </section>

    <section
      v-if="
        confirmed.hardware?.model ||
        confirmed.connection ||
        confirmed.monitoring?.count
      "
      class="detail-section"
      aria-labelledby="hardware-health-title"
    >
      <h2 id="hardware-health-title">Hardware & monitoring</h2>
      <dl class="technical-grid">
        <div v-if="confirmed.hardware?.model">
          <dt>Model</dt>
          <dd>
            {{ confirmed.hardware.model
            }}<span v-if="confirmed.hardware.firmware" class="muted">
              · {{ confirmed.hardware.firmware }}</span
            >
          </dd>
        </div>
        <div v-if="confirmed.connection?.kind">
          <dt>Connection</dt>
          <dd>
            {{
              [confirmed.connection.kind, confirmed.connection.wifi]
                .filter(Boolean)
                .join(" · ")
            }}
          </dd>
        </div>
        <div v-if="confirmed.monitoring?.count">
          <dt>Health checks</dt>
          <dd>
            {{ confirmed.monitoring.count }}
            {{ confirmed.monitoring.count === 1 ? "check" : "checks" }} ·
            {{ view.health.label }}
          </dd>
        </div>
        <div v-if="confirmed.monitoring?.count">
          <dt>Last health check</dt>
          <dd>
            {{ formatTimestamp(confirmed.monitoring.checkedAt)
            }}<span v-if="confirmed.monitoring.stale" class="muted">
              · Result is over 24 hours old</span
            >
          </dd>
        </div>
      </dl>
    </section>
    <section
      class="detail-section organization"
      aria-labelledby="organization-title"
    >
      <div class="section-heading">
        <h2 id="organization-title">Organization</h2>
        <button
          v-if="!sections.organization"
          type="button"
          data-edit="organization"
          class="text-action"
          @click="start('organization')"
        >
          Edit organization
        </button>
      </div>
      <template v-if="!sections.organization"
        ><dl class="technical-grid">
          <div>
            <dt>Device type</dt>
            <dd>
              {{ confirmed.deviceType || "Unknown"
              }}<span
                v-if="
                  !confirmed.classification?.typeOverride &&
                  confirmed.deviceType &&
                  confirmed.deviceType !== 'Unknown'
                "
                class="subtle-badge"
                >Suggested</span
              >
            </dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              {{ confirmed.role || "Unassigned"
              }}<span
                v-if="
                  !confirmed.classification?.roleOverride &&
                  confirmed.role &&
                  confirmed.role !== 'Unassigned'
                "
                class="subtle-badge"
                >Suggested</span
              >
            </dd>
          </div>
          <div>
            <dt>Inventory</dt>
            <dd>
              {{
                confirmed.lifecycle?.scope === "history" ? "History" : "Current"
              }}
              · {{ confirmed.lifecycle?.reason || "Last seen is unknown" }}
            </dd>
          </div>
        </dl>
        <div v-if="confirmed.tags?.length" class="tags">
          <span
            v-for="tag in confirmed.tags"
            :key="tag.id || tag.name"
            class="tag-chip"
            >{{ tag.name }}</span
          >
        </div>
        <p v-if="confirmed.notes" class="notes">{{ confirmed.notes }}</p>
        <p v-if="notices.organization" class="saved-notice" role="status">
          {{ notices.organization }}
        </p></template
      >
      <form
        v-else
        data-editor="organization"
        class="section-editor"
        @submit.prevent="save('organization')"
      >
        <div class="form-grid">
          <label
            >Device type<CindorSelect
              v-model="sections.organization.draft.deviceType"
              :value.attr="sections.organization.draft.deviceType"
              aria-label="Device type"
              :disabled="busy === 'organization'"
            >
              <option value="">
                Automatic ·
                {{ confirmed.classification?.suggestedType || "Unknown" }}
              </option>
              <option v-for="type in DEVICE_TYPES" :key="type" :value="type">
                {{ type }}
              </option>
            </CindorSelect></label
          >
          <label
            >Role<CindorSelect
              v-model="sections.organization.draft.role"
              :value.attr="sections.organization.draft.role"
              aria-label="Role"
              :disabled="busy === 'organization'"
            >
              <option value="">Automatic suggestion</option>
              <option v-for="role in DEVICE_ROLES" :key="role" :value="role">
                {{ role }}
              </option>
            </CindorSelect></label
          >
        </div>
        <label class="keep-current"
          ><input
            v-model="sections.organization.draft.keepCurrent"
            type="checkbox"
            :disabled="busy === 'organization'"
          />Keep in Current even after 90 days without activity</label
        >
        <p class="muted">
          Configured and monitored devices stay in Current automatically. Type
          and role corrections are kept when device data refreshes.
        </p>
        <label for="device-tags">Tags</label>
        <div class="tag-entry">
          <span
            v-for="(tag, index) in sections.organization.draft.tags"
            :key="tag"
            class="tag-chip"
            >{{ tag
            }}<button
              type="button"
              :aria-label="`Remove tag ${tag}`"
              :disabled="busy === 'organization'"
              @click="sections.organization.draft.tags.splice(index, 1)"
            >
              <AppIcon name="close" :size="14" /></button></span
          ><input
            id="device-tags"
            v-model="tagInput"
            autocomplete="off"
            placeholder="Add a tag…"
            :disabled="busy === 'organization'"
            @keydown="tagKey"
            @blur="addTag()"
          />
        </div>
        <div v-if="suggestions.length" class="suggestions">
          <span class="muted">Suggestions</span
          ><button
            v-for="tag in suggestions"
            :key="tag"
            type="button"
            :disabled="busy === 'organization'"
            @mousedown.prevent
            @click="addTag(tag)"
          >
            {{ tag }}
          </button>
        </div>
        <label
          >Notes<textarea
            v-model="sections.organization.draft.notes"
            rows="4"
            :disabled="busy === 'organization'"
          />
        </label>
        <p v-if="sections.organization.error" class="error" role="alert">
          {{ sections.organization.error }}
        </p>
        <div class="actions">
          <button
            class="ui-button primary"
            :disabled="saving || (!isDirty('organization') && !tagInput.trim())"
          >
            {{
              busy === "organization" ? "Saving…" : "Save organization"
            }}</button
          ><button
            type="button"
            class="ui-button"
            :disabled="busy === 'organization'"
            @click="close('organization')"
          >
            Cancel
          </button>
        </div>
      </form>
    </section>

    <details id="device-sources" class="detail-section sources">
      <summary>
        Sources
        <span class="muted"
          >· {{ view.groups.length }}
          {{ view.groups.length === 1 ? "system" : "systems" }}</span
        >
      </summary>
      <div v-for="group in view.groups" :key="group.key" class="source-group">
        <div class="source-heading">
          <h3>{{ group.name }}</h3>
          <a v-if="group.url" :href="group.url" target="_blank" rel="noopener"
            >Open {{ group.name }} ↗</a
          >
        </div>
        <p v-if="group.checkedAt" class="muted">
          Last checked {{ formatTimestamp(group.checkedAt) }}
        </p>
        <p v-if="group.error" class="error">{{ group.error }}</p>
        <p
          v-if="group.key === 'unifi' && confirmed.unifi?.reason"
          class="muted"
        >
          {{ confirmed.unifi.reason }}
        </p>
        <details>
          <summary>
            {{ group.records.length }} linked
            {{ group.records.length === 1 ? "record" : "records" }}
          </summary>
          <ul class="source-records">
            <li v-for="record in group.records" :key="record.sourceId">
              <strong v-if="record.name && record.name !== record.sourceId">{{
                record.name
              }}</strong
              ><span
                >{{ group.idLabel }}: <code>{{ record.sourceId }}</code></span
              ><span class="muted"
                >{{
                  record.linkMethod === "manual"
                    ? "Linked manually"
                    : record.linkMethod === "network_identity"
                      ? "Matched by network identity"
                      : "Existing link"
                }}
                · Last reported {{ formatTimestamp(record.lastSeen) }}</span
              ><span v-if="record.status"
                >Reported status: {{ record.status }}</span
              >
            </li>
          </ul>
        </details>
      </div>
      <p v-if="!view.groups.length" class="muted">No linked source records.</p>
      <dl class="source-key">
        <dt>Discovery key</dt>
        <dd class="mono">{{ confirmed.deviceKey || "Created manually" }}</dd>
      </dl>
      <p v-if="diagnostic" class="error">
        Last request error: {{ diagnostic }}
      </p>
    </details>
    <DeviceMerge :device="confirmed" :disabled="dirty || saving || refreshing || Boolean(view.operation?.active)" />
  </div>
</template>

<style scoped>
.section-editor .keep-current {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 400;
}
.section-editor .keep-current input {
  display: inline-block;
  flex: none;
  width: 18px;
  height: 18px;
  min-height: 0;
  margin: 0;
}
.organization dd .subtle-badge {
  margin-left: 8px;
}
.device-workspace {
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  display: grid;
  gap: 24px;
  font-size: 15px;
  line-height: 1.55;
  min-width: 0;
  color: var(--fg);
}
.device-heading,
.title-line,
.section-heading,
.value-line,
.actions,
.source-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.device-heading {
  align-items: flex-start;
  justify-content: space-between;
}
.heading-identity {
  flex: 1;
  min-width: 0;
}
.title-line h1 {
  font-size: clamp(26px, 3vw, 34px);
  letter-spacing: -0.8px;
  line-height: 1.2;
  margin: 0;
  overflow-wrap: anywhere;
  min-width: 0;
}
.title-line {
  margin-bottom: 10px;
}
.device-heading > .ui-button {
  flex: none;
}
.detail-section {
  background: var(--surface-raised);
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  padding: 26px;
  min-width: 0;
}
.section-heading {
  justify-content: space-between;
  margin-bottom: 24px;
}
.section-heading h2 {
  font-size: 19px;
  letter-spacing: -0.3px;
  margin: 0;
}
.detail-section h3 {
  font-size: 16px;
  margin: 0 0 12px;
}
.network-values {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28px;
}
.network-field {
  min-width: 0;
}
.value-label,
dt {
  display: block;
  font-size: 13px;
  color: var(--fg-muted);
  margin-bottom: 7px;
}
.value-label {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.value-line {
  gap: 10px 18px;
  min-height: 36px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.primary-value {
  font-size: 17px;
}
.network-context {
  display: flex;
  gap: 6px 16px;
  flex-wrap: wrap;
  margin-top: 7px;
  font-size: 14px;
}
.subtle-badge {
  background: var(--surface);
  border-radius: 5px;
  padding: 2px 7px;
  font-size: 12px;
  color: var(--fg-muted);
}
.text-action {
  border: 0;
  background: transparent;
  padding: 5px 0;
  color: var(--accent);
  font-size: 14px;
  font-weight: 550;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-align: left;
}
.text-action:disabled {
  color: var(--fg-muted);
  text-decoration: none;
}
.device-workspace .ui-button {
  font-size: 14px;
  min-height: 40px;
}
.health {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 20px;
  background: var(--surface);
  white-space: nowrap;
}
.health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.success {
  color: var(--success);
}
.danger,
.error {
  color: var(--danger);
}
.neutral {
  color: var(--fg-muted);
}
.error {
  overflow-wrap: anywhere;
}
.muted,
.optional,
.saved-notice {
  color: var(--fg-muted);
}
.optional {
  font-size: 12px;
  font-weight: 400;
  margin-left: 6px;
}
.capability-note {
  font-size: 13px;
  margin-bottom: 0;
}
.capability-note a {
  color: var(--accent);
  text-decoration: underline;
}
.dns-state {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  margin: 7px 0 0;
  color: var(--fg-muted);
}
.warning {
  color: var(--theme-warning, #8c4c00);
}
.additional-addresses {
  margin-top: 20px;
}
.address-list,
.source-records {
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
}
.address-list li {
  display: flex;
  gap: 8px 24px;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 10px 0;
  border-top: 1px solid var(--border-muted);
}
summary {
  cursor: pointer;
  font-size: 14px;
  width: fit-content;
  padding: 6px 0;
  color: var(--fg-muted);
}
summary:hover {
  color: var(--fg);
}
.technical-details {
  border-top: 1px solid var(--border-muted);
  padding-top: 14px;
  margin-top: 24px;
}
.technical-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin: 18px 0 0;
}
.technical-grid > div {
  min-width: 0;
}
.mac-hardware {
  display: grid;
  gap: 4px;
  margin-top: 10px;
  font-size: 0.875rem;
}
.hardware-registration summary {
  cursor: pointer;
  color: var(--fg-muted);
}
.hardware-registration dl {
  display: grid;
  gap: 8px;
  margin: 10px 0;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
dd > .text-action {
  margin-left: 12px;
}
.alias {
  display: block;
}
.section-editor {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border-muted);
  border-radius: 9px;
  margin-top: 22px;
  display: grid;
  gap: 16px;
}
.section-editor p {
  margin: 0;
}
.name-editor {
  max-width: 560px;
  margin-top: 12px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.section-editor label {
  display: block;
  font-size: 14px;
  font-weight: 550;
  min-width: 0;
}
.section-editor input,
.section-editor textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin-top: 7px;
  padding: 10px 12px;
  min-height: 44px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface-raised);
  color: var(--fg);
  font: inherit;
  font-size: 15px;
}
.section-editor textarea {
  resize: vertical;
}
.section-editor cindor-select {
  display: block;
  width: 100%;
  min-width: 0;
  margin-top: 7px;
  --cindor-field-inline-size: 100%;
}
.section-editor cindor-select::part(control) {
  min-height: 44px;
  font-size: 15px;
}
.actions {
  gap: 10px;
}
.operation {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border-muted);
  background: var(--surface);
  border-radius: 8px;
  margin-top: 22px;
}
.operation svg {
  flex: none;
  margin-top: 3px;
}
.operation strong {
  font-weight: 550;
}
.operation p {
  margin: 5px 0 0;
  font-size: 14px;
}
.operation.info {
  color: var(--fg);
}
.dns-repair {
  margin-top: 18px;
  display: grid;
  gap: 12px;
}
.dns-repair > .ui-button {
  justify-self: start;
}
.organization .section-heading {
  margin-bottom: 0;
}
.organization .section-editor,
.organization .tags,
.organization .notes {
  margin-top: 18px;
}
.notes {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-bottom: 0;
}
.tags,
.tag-entry,
.suggestions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--accent-muted);
  font-size: 14px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.tag-chip button {
  display: grid;
  place-items: center;
  background: transparent;
  color: inherit;
  border: 0;
  width: 26px;
  height: 26px;
  flex: none;
}
.tag-entry {
  border: 1px solid var(--border-strong);
  padding: 8px;
  border-radius: 7px;
  background: var(--surface-raised);
}
.tag-entry input {
  flex: 1 1 140px;
  border: 0;
  padding: 4px;
  margin: 0;
  min-height: 34px;
}
.suggestions {
  font-size: 13px;
}
.suggestions button {
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--fg);
  padding: 5px 9px;
}
.sources > summary {
  font-size: 16px;
  font-weight: 550;
  color: var(--fg);
  padding: 0;
}
.sources > summary .muted {
  font-weight: 400;
  font-size: 14px;
}
.source-group {
  border-top: 1px solid var(--border-muted);
  padding-top: 18px;
  margin-top: 18px;
}
.source-heading {
  justify-content: space-between;
}
.source-heading h3 {
  margin: 0;
}
.source-heading a {
  font-size: 14px;
  color: var(--accent);
}
.source-group p {
  font-size: 13px;
  margin: 8px 0;
}
.source-records li {
  display: grid;
  gap: 4px;
  padding: 12px 0;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.source-records li + li {
  border-top: 1px solid var(--border-muted);
}
.source-key {
  margin: 22px 0 0;
}
.saved-notice {
  display: block;
  font-size: 13px;
  margin: 8px 0 0;
}
@media (max-width: 700px) {
  .device-workspace {
    gap: 16px;
  }
  .detail-section {
    padding: 20px;
  }
  .network-values,
  .form-grid,
  .technical-grid {
    grid-template-columns: 1fr;
    gap: 22px;
  }
  .device-heading > .ui-button {
    order: -1;
  }
  .device-heading {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .heading-identity {
    width: 100%;
  }
  .section-editor {
    padding: 16px;
  }
  .section-heading {
    gap: 10px;
  }
  .value-line {
    align-items: flex-start;
  }
  .title-line h1 {
    width: 100%;
  }
}
</style>


