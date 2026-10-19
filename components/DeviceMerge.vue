<script setup>
const props = defineProps({ device: { type: Object, required: true }, disabled: Boolean });
const dialog = ref(null), trigger = ref(null), searchInput = ref(null), reviewTitle = ref(null);
const search = ref(''), candidates = ref([]), selected = ref(null);
const preview = ref(null), error = ref(''), busy = ref(false), searched = ref(false);
const applying = ref(false);
let version = 0;
const fieldLabels = { display_name: 'Name', hostname: 'Hostname', managed_hostname: 'Managed hostname', dns_target_ip: 'DNS address', primary_ip: 'Primary IP', device_type: 'Device type', device_role: 'Device role' };
const sourceLabels = { unifi: 'UniFi', home_assistant: 'Home Assistant', ha: 'Home Assistant', uptime_kuma: 'Uptime Kuma', dns_platform: 'DNS Platform' };
function message(e) { return e?.data?.statusMessage || e.message || 'Unable to merge devices.'; }
function open() {
  if (props.disabled) return;
  search.value = ''; candidates.value = []; selected.value = null;
  preview.value = null; error.value = ''; searched.value = false;
  dialog.value.showModal();
  searchInput.value?.focus();
}
function close() {
  if (applying.value) return;
  version++; busy.value = false;
  dialog.value.close();
  trigger.value?.focus();
}
async function find() {
  if (busy.value || !search.value.trim()) return;
  const request = ++version;
  preview.value = null; selected.value = null; candidates.value = []; searched.value = false;
  busy.value = true; error.value = '';
  try {
    const result = await $fetch('/api/inventory/devices', { query: { search: search.value.trim() } });
    if (request === version) { candidates.value = result.devices.filter(d => d.id !== props.device.id).slice(0, 30); searched.value = true; }
  } catch (e) { if (request === version) error.value = message(e); }
  finally { if (request === version) busy.value = false; }
}
async function review(device) {
  if (busy.value) return;
  const request = ++version;
  selected.value = device; preview.value = null; busy.value = true; error.value = '';
  try {
    const result = await $fetch(`/api/inventory/devices/${props.device.id}/merge`, { method: 'POST', body: { otherId: device.id } });
    if (request === version) { preview.value = result; await nextTick(); reviewTitle.value?.focus(); }
  } catch (e) { if (request === version) error.value = message(e); }
  finally { if (request === version) busy.value = false; }
}
async function back() {
  preview.value = null; error.value = ''; await nextTick(); searchInput.value?.focus();
}
async function merge() {
  if (busy.value || props.disabled || !preview.value || preview.value.blockers.length) return;
  busy.value = true; applying.value = true; error.value = '';
  try {
    await $fetch(`/api/inventory/devices/${props.device.id}/merge`, {
      method: 'POST', body: { otherId: selected.value.id, revision: preview.value.revision, apply: true },
    });
    window.location.assign(`/devices/${props.device.id}`);
  } catch (e) { error.value = message(e); preview.value = null; await nextTick(); searchInput.value?.focus(); }
  finally { busy.value = false; applying.value = false; }
}
onBeforeUnmount(() => { version++; });
</script>

<template>
  <div class="merge-section">
    <details class="advanced-actions">
      <summary>Advanced actions</summary>
      <div class="advanced-content">
        <p>Combine duplicate inventory records for the same device.</p>
        <button ref="trigger" type="button" class="ui-button" :disabled="disabled" @click="open">Merge duplicate…</button>
        <p v-if="disabled" class="muted">Finish any edits or active updates before merging.</p>
      </div>
    </details>
    <dialog ref="dialog" class="merge-dialog" aria-labelledby="merge-title" aria-describedby="merge-description" @cancel.prevent="close">
      <header class="modal-header">
        <div>
          <p class="eyebrow">{{ preview ? 'Step 2 of 2 · Review' : 'Step 1 of 2 · Choose duplicate' }}</p>
          <h2 id="merge-title">Merge duplicate device</h2>
          <p id="merge-description">{{ preview ? 'Review the records and changes before merging.' : 'Find the duplicate record to combine with this device.' }}</p>
        </div>
        <button type="button" class="ui-button close-button" aria-label="Close merge dialog" :disabled="applying" @click="close">×</button>
      </header>
      <div class="modal-body" :aria-busy="busy">
        <div class="record-pair">
          <article class="record kept">
            <span class="eyebrow">Keep this record</span>
            <h3>{{ device.name }}</h3>
            <span>{{ device.primaryIp || 'No IP address' }}</span>
            <span class="mono">{{ device.mac || 'No MAC address' }}</span>
            <span class="muted">Record #{{ device.id }}</span>
          </article>
          <article v-if="preview" class="record">
            <span class="eyebrow">Merge into kept record</span>
            <h3>{{ selected.name }}</h3>
            <span>{{ selected.primaryIp || 'No IP address' }}</span>
            <span class="mono">{{ selected.mac || 'No MAC address' }}</span>
            <span class="muted">Record #{{ selected.id }} · Removed after merge</span>
          </article>
        </div>
        <template v-if="!preview">
          <form class="merge-search" @submit.prevent="find">
            <label>Find duplicate<input ref="searchInput" v-model="search" type="search" placeholder="Name, IP, or MAC address" :disabled="busy" /></label>
            <button class="ui-button" :disabled="busy || !search.trim()">Search</button>
          </form>
          <p v-if="searched" class="muted" role="status">{{ candidates.length ? `${candidates.length} matching records${candidates.length === 30 ? ' · Refine your search if needed' : ''}` : 'No other devices found. Try a different name or address.' }}</p>
          <ul class="merge-candidates">
            <li v-for="candidate in candidates" :key="candidate.id">
              <button type="button" :disabled="busy" @click="review(candidate)">
                <span class="candidate-identity"><strong>{{ candidate.name }}</strong><span class="muted">{{ candidate.primaryIp || 'No IP' }} · {{ candidate.mac || 'No MAC' }} · #{{ candidate.id }}</span></span>
                <span class="review-label">Review →</span>
              </button>
            </li>
          </ul>
        </template>
        <section v-else class="merge-preview">
          <h3 ref="reviewTitle" tabindex="-1">What will change</h3>
          <div class="merge-counts">
            <span><strong>{{ preview.sources.length }}</strong> linked sources</span>
            <span><strong>{{ preview.tags }}</strong> tags</span>
            <span><strong>{{ preview.addresses }}</strong> saved addresses</span>
          </div>
          <ul class="changes">
            <li>Notes are combined. Existing labels and settings on the kept record take priority.</li>
            <li>Other MAC addresses remain recognized on future imports.</li>
            <li>The duplicate leaves the inventory. Its old link opens the kept record, and a history snapshot is saved.</li>
          </ul>
          <div v-if="preview.conflicts.length" class="conflicts">
            <h4>Values kept from {{ device.name }}</h4>
            <dl><div v-for="field in preview.conflicts" :key="field"><dt>{{ fieldLabels[field] || field }}</dt><dd>{{ preview.target[field] }}</dd></div></dl>
          </div>
          <details class="source-details"><summary>Linked sources after merge</summary><ul><li v-for="source in preview.sources" :key="`${source.source}:${source.sourceId}`">{{ sourceLabels[source.source] || source.source }} · {{ source.sourceId }}</li></ul></details>
          <div v-if="preview.blockers.length" class="merge-error" role="alert"><strong>Resolve before merging</strong><ul><li v-for="blocker in preview.blockers" :key="blocker">{{ blocker }}</li></ul></div>
        </section>
        <p v-if="busy" role="status">{{ applying ? 'Merging records…' : selected ? 'Loading merge preview…' : 'Searching devices…' }}</p>
        <p v-if="error" class="merge-error" role="alert">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="ui-button" :disabled="applying" @click="close">Cancel</button>
        <template v-if="preview">
          <button type="button" class="ui-button" :disabled="busy" @click="back">Choose another</button>
          <button type="button" class="ui-button primary" :disabled="busy || disabled || preview.blockers.length > 0" @click="merge">{{ applying ? 'Merging…' : 'Confirm merge' }}</button>
        </template>
      </footer>
    </dialog>
  </div>
</template>

<style scoped>
.merge-section { border-top: 1px solid var(--border-muted); padding-top: 1rem; }
.advanced-actions > summary { color: var(--text-muted, #64746d); cursor: pointer; width: fit-content; }
.advanced-content { padding-top: .5rem; }
p { line-height: 1.5; margin: .5rem 0; }
.merge-dialog { width: min(700px, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); padding: 0; border: 1px solid var(--border-muted); border-radius: 16px; color: var(--fg); background: var(--surface); box-shadow: 0 24px 80px #0005; }
.merge-dialog[open] { display: flex; flex-direction: column; }
.merge-dialog::backdrop { background: #07171099; backdrop-filter: blur(3px); }
.modal-header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding: 1.5rem; border-bottom: 1px solid var(--border-muted); }
h2 { font-size: 1.4rem; margin: .3rem 0; }
h3 { margin: .3rem 0; font-size: 1.05rem; overflow-wrap: anywhere; }
h4 { margin: 0 0 .75rem; }
.eyebrow { font-size: .78rem; font-weight: 650; color: var(--accent); }
.close-button { font-size: 1.4rem; padding: .1rem .6rem; }
.modal-body { padding: 1.5rem; overflow-y: auto; min-height: 0; }
.record-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; }
.record { display: grid; gap: .3rem; padding: 1rem; border: 1px solid var(--border-muted); border-radius: 10px; background: var(--surface-raised); overflow-wrap: anywhere; }
.kept { border-color: var(--accent); }
.muted { color: var(--fg-muted); font-size: .85rem; }
.mono { font-family: monospace; font-size: .85rem; }
.merge-search { display: flex; align-items: end; gap: .75rem; margin: 1.25rem 0; }
label { display: grid; gap: .5rem; flex: 1; min-width: 0; font-weight: 600; }
input { width: 100%; min-width: 0; }
.merge-candidates { list-style: none; padding: 0; display: grid; gap: .5rem; margin-bottom: 0; }
.merge-candidates button { display: flex; justify-content: space-between; align-items: center; gap: 1rem; width: 100%; text-align: left; padding: .85rem 1rem; border: 1px solid var(--border-muted); border-radius: 8px; background: var(--surface-raised); color: inherit; cursor: pointer; }
.merge-candidates button:hover { border-color: var(--accent); }
.candidate-identity { display: grid; gap: .35rem; overflow-wrap: anywhere; min-width: 0; }
.review-label { flex-shrink: 0; color: var(--accent); font-size: .85rem; }
.merge-preview { margin-top: 1.25rem; }
.merge-counts { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; margin: .75rem 0; }
.changes { padding-left: 1.2rem; line-height: 1.6; }
.changes li + li { margin-top: .4rem; }
.conflicts { padding: 1rem; background: var(--surface-raised); border-radius: 8px; }
dl { margin: 0; display: grid; gap: .5rem; }
dl > div { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
dd { margin: 0; overflow-wrap: anywhere; font-weight: 600; }
.source-details { margin-top: 1rem; overflow-wrap: anywhere; }
summary { cursor: pointer; }
.merge-error { border-left: 3px solid #c96149; padding: .75rem 1rem; background: var(--surface-raised); }
.modal-footer { display: flex; flex-wrap: wrap; justify-content: end; gap: .5rem; padding: 1rem 1.5rem; border-top: 1px solid var(--border-muted); }
.modal-footer > :first-child { margin-right: auto; }
@media (max-width: 480px) {
  .modal-header, .modal-body { padding: 1rem; }
  .modal-footer { padding: .85rem 1rem; }
  .record-pair { grid-template-columns: 1fr; }
  .review-label { display: none; }
}
</style>
