import { shallowRef, ref } from 'vue';

// Keep cached choices visible while refreshing. Requests have ownership so an
// earlier response cannot replace the range the user has since selected.
export function createIpChoices(fetchPage, { now = Date.now, ttl = 20000, onDevice = () => {} } = {}) {
  const data = shallowRef(null), page = shallowRef(null), pending = ref(false), error = ref('');
  let requestId = 0, controller, receivedAt = 0;
  const pages = new Map();
  const key = (rangeId, offset) => `${rangeId || ''}:${offset}`;
  function cancel() { requestId++; controller?.abort(); controller = null; pending.value = false; }
  async function load(rangeId = '', offset = 0, { fresh = false } = {}) {
    const cached = pages.get(key(rangeId, offset));
    if (cached) page.value = cached;
    else page.value = null;
    cancel();
    if (!fresh && cached && now() - receivedAt < ttl) { error.value = ''; return; }
    const id = ++requestId;
    controller = new AbortController();
    pending.value = true; error.value = '';
    try {
      const response = await fetchPage({ rangeId, offset, signal: controller.signal });
      if (id !== requestId) return;
      if (data.value?.checkedAt !== response.checkedAt) pages.clear();
      data.value = response; receivedAt = now();
      for (const range of response.ranges) if (range.availability) pages.set(key(String(range.id), 0), range.availability);
      if (rangeId) pages.set(key(rangeId, offset), response);
      else pages.set(key('', 0), response);
      page.value = pages.get(key(rangeId, offset)) || null;
      onDevice(response.device);
    } catch (cause) {
      if (id === requestId && !controller?.signal.aborted) error.value = cause?.data?.statusMessage || cause?.message || 'Unable to check available addresses.';
    } finally { if (id === requestId) { pending.value = false; controller = null; } }
  }
  return { data, page, pending, error, load, cancel };
}
