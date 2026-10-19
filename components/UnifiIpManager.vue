<script setup>
import { CindorSelect } from "cindor-ui-vue";
import { ipInRange } from "~/utils/network-match.js";
import { createIpChoices } from "~/utils/ip-choices.js";
import { friendlyError, hostIp } from "~/utils/device-presentation.js";
import { formatTimestamp } from "~/utils/format-date.js";
const props = defineProps({
  device: { type: Object, required: true },
  ranges: { type: Array, default: () => [] },
  blocked: Boolean,
});
const emit = defineEmits(["updated", "applied", "cancel", "dirty", "saving"]);
const mode = ref(
  props.device.unifi?.mode === "automatic" ? "automatic" : "fixed",
);
const selectedIp = ref(
  hostIp(props.device.unifi?.configuredIp || props.device.primaryIp),
);
const baseline = { mode: mode.value, ip: selectedIp.value };
const initialRange = props.ranges.find((range) =>
  ipInRange(selectedIp.value, range.startIp, range.endIp),
);
const rangeId = ref(String(initialRange?.id || "custom"));
const offset = ref(0),
  saving = ref(false),
  error = ref(""),
  conflict = ref(false);
const editor = ref(null);
const revision = ref(props.device.unifi?.revision);
const choices = createIpChoices(
  ({ rangeId, offset, signal }) =>
    $fetch(`/api/inventory/devices/${props.device.id}/unifi-availability`, {
      query: { rangeId: rangeId || undefined, offset },
      signal,
    }),
  {
    onDevice(device) {
      if (device) {
        revision.value = device.unifi?.revision;
        emit("updated", device);
      }
    },
  },
);
const {
  data: availability,
  page,
  pending: checking,
  error: availabilityError,
} = choices;
const ranges = computed(() => availability.value?.ranges || props.ranges);
const dirty = computed(
  () =>
    mode.value !== baseline.mode ||
    (mode.value === "fixed" && selectedIp.value !== baseline.ip),
);
watch(dirty, (value) => emit("dirty", value), { immediate: true });
const canApply = computed(
  () =>
    !saving.value &&
    !props.blocked &&
    !checking.value &&
    !availabilityError.value &&
    availability.value &&
    dirty.value &&
    (mode.value === "automatic" ||
      (Boolean(selectedIp.value) &&
        (rangeId.value === "custom" ||
          page.value?.addresses?.some((row) => row.ip === selectedIp.value)))),
);
function load(next = 0, fresh = false) {
  offset.value = next;
  return choices.load(rangeId.value === "custom" ? "" : rangeId.value, next, {
    fresh,
  });
}
function changeRange() {
  selectedIp.value = "";
  void load();
}
async function apply() {
  if (!canApply.value) return;
  saving.value = true;
  emit("saving", true);
  error.value = "";
  conflict.value = false;
  try {
    const result = await $fetch(
      `/api/inventory/devices/${props.device.id}/unifi-assignment`,
      {
        method: "POST",
        body: {
          mode: mode.value,
          ...(mode.value === "fixed" ? { ip: selectedIp.value } : {}),
          expectedRevision: revision.value,
        },
      },
    );
    emit("applied", result.device);
  } catch (cause) {
    error.value = friendlyError(cause);
    conflict.value = (cause.statusCode || cause.status) === 409;
  } finally {
    saving.value = false;
    emit("saving", false);
  }
}
async function review() {
  await load(offset.value, true);
  if (!availabilityError.value) {
    error.value =
      "Availability refreshed. Review your selection before applying.";
    conflict.value = false;
  }
}
onMounted(async () => {
  void load();
  const select = editor.value?.querySelector("cindor-select");
  await select?.updateComplete;
  select?.focus();
});
onBeforeUnmount(() => {
  choices.cancel();
  emit("dirty", false);
});
</script>
<template>
  <!-- Reflect values before Cindor connects so its option initialization preserves drafts. -->
  <form
    ref="editor"
    class="address-editor"
    aria-label="Change address"
    @submit.prevent="apply"
  >
    <h3>Change address</h3>
    <div class="fields">
      <label
        >Assignment<CindorSelect
          v-model="mode"
          :value.attr="mode"
          aria-label="Assignment"
          :disabled="saving || blocked"
        >
          <option value="fixed">
            {{
              device.unifi?.kind === "managed_device"
                ? "Static IP"
                : "Fixed IP reservation"
            }}
          </option>
          <option value="automatic">Automatic (DHCP)</option>
        </CindorSelect></label
      >
      <template v-if="mode === 'fixed'">
        <label
          >Address range<CindorSelect
            v-model="rangeId"
            :value.attr="rangeId"
            aria-label="Address range"
            :disabled="saving || blocked"
            @change="changeRange"
          >
            <option value="" disabled>Select a reserved range</option>
            <option
              v-for="range in ranges"
              :key="range.id"
              :value="String(range.id)"
              :disabled="range.compatible === false"
            >
              {{ range.name
              }}{{
                range.compatible === false
                  ? " · Outside current network"
                  : range.total !== undefined
                    ? ` · ${range.total} available`
                    : ""
              }}
            </option>
            <option value="custom">Enter an address</option>
          </CindorSelect></label
        >
        <label v-if="rangeId === 'custom'"
          >IPv4 address<input
            v-model.trim="selectedIp"
            :disabled="saving || blocked"
            placeholder="192.168.10.42"
            required
        /></label>
        <label v-else
          >Available IP<CindorSelect
            v-model="selectedIp"
            :value.attr="selectedIp"
            aria-label="Available IP"
            :disabled="
              saving || blocked || checking || !page?.addresses?.length
            "
            required
          >
            <option value="" disabled>
              {{ checking ? "Checking addresses…" : "Select an address" }}
            </option>
            <option
              v-for="address in page?.addresses || []"
              :key="address.ip"
              :value="address.ip"
            >
              {{ address.ip
              }}{{
                address.current
                  ? " · current"
                  : address.reserved
                    ? " · reserved for this device"
                    : ""
              }}
            </option>
          </CindorSelect></label
        >
      </template>
    </div>
    <p v-if="checking" class="muted" role="status">
      Checking available addresses…
    </p>
    <p v-else-if="availabilityError" class="error" role="alert">
      {{ friendlyError({ message: availabilityError }) }}
      <button type="button" class="text-action" @click="load(offset, true)">
        Retry
      </button>
    </p>
    <p
      v-else-if="mode === 'fixed' && rangeId !== 'custom' && page"
      class="muted"
    >
      {{ page.total }} available · Checked {{ formatTimestamp(page.checkedAt)
      }}<span v-if="!page.total">
        · Choose another range or enter an address.</span
      >
    </p>
    <div
      v-if="mode === 'fixed' && rangeId !== 'custom' && page?.total > 50"
      class="actions"
    >
      <button
        type="button"
        class="ui-button"
        :disabled="checking || saving || !offset"
        @click="load(Math.max(0, offset - 50))"
      >
        Previous addresses</button
      ><button
        type="button"
        class="ui-button"
        :disabled="checking || saving || page.nextOffset === null"
        @click="load(page.nextOffset)"
      >
        Next addresses
      </button>
    </div>
    <p class="muted">
      The address may change when the device renews its connection. Existing DNS
      follows once the new address is reported.
    </p>
    <p v-if="error" class="error" role="alert">
      {{ error }}
      <button
        v-if="conflict"
        type="button"
        class="text-action"
        :disabled="checking"
        @click="review"
      >
        Refresh and review
      </button>
    </p>
    <div class="actions">
      <button class="ui-button primary" :disabled="!canApply">
        {{ saving ? "Applying…" : "Apply address" }}</button
      ><button
        type="button"
        class="ui-button"
        :disabled="saving"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </div>
  </form>
</template>
<style scoped>
.address-editor {
  margin-top: 22px;
  padding: 20px;
  border: 1px solid var(--border-muted);
  border-radius: 9px;
  background: var(--surface);
  display: grid;
  gap: 16px;
}
.address-editor h3 {
  font-size: 16px;
  margin: 0;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}
.fields label {
  display: grid;
  gap: 7px;
  font-size: 14px;
  min-width: 0;
  font-weight: 550;
}
.fields input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  color: var(--fg);
  background: var(--surface-raised);
  font: inherit;
  font-size: 15px;
}
.fields cindor-select {
  width: 100%;
  min-width: 0;
  --cindor-field-inline-size: 100%;
}
.fields cindor-select::part(control) {
  min-height: 44px;
  font-size: 15px;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.ui-button {
  font-size: 14px;
  min-height: 40px;
}
.muted {
  color: var(--fg-muted);
  font-size: 14px;
}
.error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.text-action {
  color: var(--accent);
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.address-editor p {
  margin: 0;
}
@media (max-width: 600px) {
  .fields {
    grid-template-columns: 1fr;
  }
  .address-editor {
    padding: 16px;
  }
}
</style>
