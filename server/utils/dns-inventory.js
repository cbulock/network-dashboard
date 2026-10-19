import { getInventoryDeviceDetails } from '~/scripts/device-registry.js';

export async function dnsInventoryPayload(db, body, id) {
  const existing = id ? await getInventoryDeviceDetails(db,id) : null;
  if (existing && !body.dns && Object.hasOwn(body,'hostname') && String(body.hostname ?? '').trim() === String(existing.hostname ?? '')) {
    const { hostname: unchanged, ...rest } = body;
    return rest;
  }
  if (Object.hasOwn(body,'hostname') && String(body.hostname ?? '').trim() !== String(existing?.hostname ?? '') && !body.dns) {
    body = { ...body, dns: { targetIp: existing?.primaryIp,
      expectedRevision: existing?.dns?.revision || (await db.query('SELECT revision FROM dns_platform_state WHERE id=1')).rows[0]?.revision } };
  }
  return body;
}
