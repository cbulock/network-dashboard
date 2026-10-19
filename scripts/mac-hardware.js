import registry from '../data/mac-vendors.json' with { type: 'json' };
import { normalizeMac } from './source-identity.js';

export function resolveMacHardware(value, database = registry) {
  const mac = normalizeMac(value);
  if (!mac) return null;
  const hex = mac.replaceAll(':', '').toUpperCase();
  const first = parseInt(hex.slice(0, 2), 16);
  const base = {
    manufacturer: null, registeredAddress: null, prefix: null, registry: null,
    sourceUrl: 'https://standards.ieee.org/products-programs/regauth/',
    updatedAt: database.updatedAt,
  };
  if (hex === 'FFFFFFFFFFFF') return { ...base, addressType: 'Broadcast' };
  if (hex === '000000000000') return { ...base, addressType: 'Unspecified' };
  if (first & 1) return { ...base, addressType: 'Multicast' };
  // The U/L bit prevents treating randomized/private MACs as vendor allocations.
  if (first & 2) return { ...base, addressType: 'Locally administered (private or virtual)' };
  for (const length of [9, 7, 6]) {
    const prefix = hex.slice(0, length);
    const entry = database.entries[prefix];
    if (entry) return {
      ...base, addressType: 'Universally administered',
      manufacturer: entry[0], registeredAddress: entry[1] || null,
      prefix: `${prefix.padEnd(12, '0').match(/.{2}/g).join(':')}/${length * 4}`,
      registry: entry[2],
    };
  }
  return { ...base, addressType: 'Universally administered' };
}
