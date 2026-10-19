<script setup>
const props = defineProps({ color: { type: String, default: null } });
const validColor = computed(() => /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(props.color || '') ? props.color : null);
</script>

<template>
  <span v-if="validColor" class="vlan-color-indicator" :style="{ backgroundColor: validColor }" aria-hidden="true"></span>
</template>

<style scoped>
.vlan-color-indicator {
  display: inline-block;
  width: 0.65em;
  height: 0.65em;
  flex: none;
  margin-inline-end: 0.4em;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  vertical-align: 0.02em;
}
</style>
