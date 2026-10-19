<script setup>
const props = defineProps({ label: { type: String, required: true }, allLabel: { type: String, default: '' }, options: { type: Array, default: () => [] }, modelValue: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue']);
const root = ref(null);
const caption = computed(() => props.modelValue.length === 1
  ? props.options.find(option => option.value === props.modelValue[0])?.label || props.modelValue[0]
  : props.modelValue.length ? `${props.modelValue.length} selected` : props.allLabel || `All ${props.label.toLowerCase()}`);
function toggle(value) { emit('update:modelValue', props.modelValue.includes(value) ? props.modelValue.filter(item => item !== value) : [...props.modelValue, value]); }
function outside(event) { if (!root.value?.contains(event.target) && root.value) root.value.open = false; }
function close() { root.value.open = false; root.value.querySelector('summary').focus(); }
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>
<template>
  <details ref="root" class="inventory-filter" @keydown.esc.prevent.stop="close">
    <summary :aria-label="`${label}: ${caption}`"><span class="filter-label">{{ label }}</span><span class="filter-value"><span><VlanColorIndicator v-if="modelValue.length === 1" :color="options.find(option => option.value === modelValue[0])?.color" />{{ caption }}</span><AppIcon name="chevron" :size="14" /></span></summary>
    <div class="filter-options" role="group" :aria-label="label">
      <button v-if="modelValue.length" type="button" class="reset-filter" @click="emit('update:modelValue', [])">Clear selection</button>
      <label v-for="option in options" :key="option.value"><input type="checkbox" :checked="modelValue.includes(option.value)" @change="toggle(option.value)"><span><VlanColorIndicator :color="option.color" />{{ option.label }}</span></label>
      <p v-if="!options.length">No options available</p>
    </div>
  </details>
</template>
<style scoped>
.inventory-filter{position:relative;min-width:0}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}.filter-label{display:block;font-size:13px;color:var(--fg-muted);margin-bottom:7px}.filter-value{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--border-strong);border-radius:7px;padding:10px 12px;min-height:44px;background:var(--surface-raised);font-size:14px;overflow-wrap:anywhere}.filter-value svg{flex:none;transform:rotate(90deg)}.filter-options{position:absolute;top:100%;left:0;right:0;margin-top:6px;background:var(--surface-raised);border:1px solid var(--border-strong);border-radius:8px;box-shadow:0 8px 24px #0002;max-height:320px;overflow-y:auto;padding:8px;z-index:20}.filter-options label{display:flex;align-items:center;gap:10px;padding:10px 6px;min-height:44px;cursor:pointer;font-size:14px;overflow-wrap:anywhere}.filter-options label:hover{background:var(--surface)}input{width:16px;height:16px;flex:none;accent-color:var(--accent)}.reset-filter{border:0;background:none;color:var(--accent);padding:8px;font:inherit;font-size:13px}.filter-options p{font-size:14px;padding:8px}
</style>
