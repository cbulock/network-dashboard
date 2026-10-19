import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const registries = [
  ['MA-L', 'https://standards-oui.ieee.org/oui/oui.csv', 6],
  ['MA-M', 'https://standards-oui.ieee.org/oui28/mam.csv', 7],
  ['MA-S', 'https://standards-oui.ieee.org/oui36/oui36.csv', 9],
  ['IAB', 'https://standards-oui.ieee.org/iab/iab.csv', 9],
];

// IEEE's UTF-8 CSV includes quoted commas, escaped quotes and multiline addresses.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('Incomplete IEEE CSV response');
  if (field || row.length) rows.push([...row, field.replace(/\r$/, '')]);
  return rows;
}

export async function updateMacVendors() {
  const entries = {};
  for (const [registry, url, length] of registries) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${registry}: HTTP ${response.status}`);
    const [header, ...rows] = parseCsv((await response.text()).replace(/^\uFEFF/, ''));
    if (header?.slice(0, 4).join(',') !== 'Registry,Assignment,Organization Name,Organization Address') {
      throw new Error(`${registry}: Unexpected IEEE CSV columns`);
    }
    let count = 0;
    for (const row of rows) {
      if (row.length === 1 && !row[0].trim()) continue;
      const [type, prefix, name, address] = row;
      if (type !== registry || !new RegExp(`^[A-F0-9]{${length}}$`).test(prefix) || !name?.trim()) {
        throw new Error(`${registry}: Invalid assignment`);
      }
      entries[prefix] = [name.trim(), (address || '').replace(/\s+/g, ' ').trim(), registry];
      count++;
    }
    if (count < 1000) throw new Error(`${registry}: Incomplete registry (${count} entries)`);
    console.log(`${registry}: ${count} assignments`);
  }
  const destination = new URL('../data/mac-vendors.json', import.meta.url);
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  // Only replace the working snapshot once every registry has passed validation.
  const temporary = new URL('../data/mac-vendors.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify({
    updatedAt: new Date().toISOString(),
    sources: registries.map(([, url]) => url),
    entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
  }) + '\n');
  await rename(temporary, destination);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateMacVendors().catch(error => { console.error(error.message); process.exitCode = 1; });
}
