<script setup>
const {
  data: lookups,
  pending,
  error,
} = useFetch("/api/inventory/lookups", {
  lazy: true,
  default: () => ({
    tags: [],
    vlans: [],
    reservedRanges: [],
    virtualSubnets: [],
  }),
});

async function handleSaved(device) {
  await navigateTo(`/devices/${device.id}`);
}
</script>

<template>
  <div class="page-grid">
    <p v-if="pending" role="status">Loading inventory lookups…</p>
    <p v-else-if="error" role="alert">{{ error.statusMessage || error.message }}</p>
    <DeviceEditor
      v-else
      mode="create"
      :lookups="lookups"
      @saved="handleSaved"
    />
  </div>
</template>

<style scoped>
.page-grid {
  display: grid;
  gap: 1rem;
}
</style>
