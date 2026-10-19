<script setup>
const props = defineProps({
  value: { type: String, default: "" },
  label: { type: String, default: "value" },
});
const status = ref("");
let timer;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    status.value = "Copied";
  } catch {
    status.value = "Unable to copy";
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    status.value = "";
  }, 2500);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <span class="copy-value">
    <span class="address-value">{{ value }}</span>
    <button
      type="button"
      class="copy-button"
      :aria-label="`Copy ${label}`"
      :title="`Copy ${label}`"
      @click="copy"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </svg>
    </button>
    <span class="copy-status" role="status">{{ status }}</span>
  </span>
</template>
<style scoped>
.copy-value {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  position: relative;
}
.address-value {
  font: inherit;
  overflow-wrap: anywhere;
  min-width: 0;
}
.copy-button {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-muted);
}
.copy-button:hover {
  background: var(--accent-muted);
  color: var(--fg);
}
.copy-status {
  position: absolute;
  top: 100%;
  right: 0;
  font: 12px/1.5 system-ui;
  background: var(--surface-raised);
  color: var(--fg);
  z-index: 2;
  white-space: nowrap;
}
</style>
