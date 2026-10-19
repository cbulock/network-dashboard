<script setup>
const route = useRoute();
const deviceId = computed(() => route.params.id);

const { data: lookups, pending: lookupsPending, error: lookupsError } = useFetch(
  "/api/inventory/lookups",
  {
    lazy: true,
    default: () => ({
      tags: [],
      vlans: [],
      reservedRanges: [],
      virtualSubnets: [],
    }),
  },
);

const {
  data: deviceResponse,
  pending: devicePending,
  error: deviceError,
} = useFetch(() => `/api/inventory/devices/${deviceId.value}`, {
  lazy: true,
  default: () => ({ device: null }),
  watch: [deviceId],
});

const device = computed(() => deviceResponse.value?.device ?? null);
watch(device, value => {
  if (value && String(value.id) !== String(deviceId.value))
    void navigateTo({ path: `/devices/${value.id}`, query: route.query }, { replace: true });
});
</script>

<template>
  <div class="page-grid">
    <p v-if="devicePending || lookupsPending" role="status">Loading device…</p>
    <p v-else-if="!device && deviceError" role="alert">
      {{ deviceError?.statusMessage || deviceError?.message }}
    </p>
    <DeviceDetails
      v-else-if="device"
      :key="device.id"
      :device="device"
      :lookups="lookups"
      :lookup-error="Boolean(lookupsError)"
    />
  </div>
</template>

<style scoped>
.page-grid {
  display: grid;
  gap: 1rem;
}
</style>
