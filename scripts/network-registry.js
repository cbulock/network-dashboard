import { normalizeIpRange, matchVlanForRange, rangesOverlap, validateVlanSubnet, vlanSubnetsOverlap } from '../utils/network-match.js';

// Hold the table lock through validation and persistence so simultaneous saves cannot overlap.
async function writeNetwork(db, table, id, work) {
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid network ID.');
  await db.query('BEGIN');
  try {
    await db.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const result = await work();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
const text = value => String(value ?? '').trim() || null;

export async function saveVlan(db, payload, id = null) {
  const vlanId = Number(payload.vlanId);
  const name = text(payload.name);
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) throw new Error('VLAN ID must be an integer from 1 to 4094.');
  if (!name) throw new Error('Name is required.');
  const subnet = validateVlanSubnet(payload.subnet);
  return writeNetwork(db, 'vlans', id, async () => {
    const { rows } = await db.query('SELECT id, vlan_id AS "vlanId", name, subnet::text AS subnet FROM vlans');
    if (id !== null && !rows.some(row => row.id === id)) throw new Error('VLAN not found.');
    for (const row of rows.filter(row => row.id !== id)) {
      if (row.vlanId === vlanId) throw new Error(`VLAN ID ${vlanId} is already used by ${row.name}.`);
      if (vlanSubnetsOverlap(subnet, row.subnet)) throw new Error(`Subnet overlaps VLAN ${row.vlanId} — ${row.name} (${row.subnet}).`);
    }
    const values = [vlanId, name, subnet, text(payload.description), text(payload.color)];
    const sql = id === null
      ? 'INSERT INTO vlans (vlan_id, name, subnet, description, color) VALUES ($1, $2, $3, $4, $5)'
      : 'UPDATE vlans SET vlan_id=$1, name=$2, subnet=$3, description=$4, color=$5, updated_at=NOW() WHERE id=$6';
    if (id !== null) values.push(id);
    return (await db.query(`${sql} RETURNING id, vlan_id AS "vlanId", name, subnet::text AS subnet, description, color`, values)).rows[0];
  });
}

export async function saveReservedRange(db, payload, id = null) {
  const name = text(payload.name);
  if (!name) throw new Error('Name is required.');
  const { startIp, endIp } = normalizeIpRange(payload.startIp, payload.endIp);
  const slug = text(payload.slug) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Enter a slug for this range.');
  return writeNetwork(db, 'virtual_subnets', id, async () => {
    const { rows } = await db.query('SELECT id, slug, name, host(start_ip) AS "startIp", host(end_ip) AS "endIp" FROM virtual_subnets');
    if (id !== null && !rows.some(row => row.id === id)) throw new Error('Reserved range not found.');
    for (const row of rows.filter(row => row.id !== id)) {
      if (row.slug === slug) throw new Error(`Slug is already used by ${row.name}.`);
      if (rangesOverlap({ startIp, endIp }, row)) throw new Error(`Range overlaps ${row.name} (${row.startIp} – ${row.endIp}).`);
    }
    const vlans = (await db.query('SELECT id, vlan_id AS "vlanId", subnet::text AS subnet FROM vlans')).rows;
    const vlanId = matchVlanForRange(startIp, endIp, vlans)?.id ?? null;
    const values = [slug, name, text(payload.description), vlanId, payload.isLogical !== false, startIp, endIp];
    const sql = id === null
      ? 'INSERT INTO virtual_subnets (slug, name, description, vlan_id, is_logical, start_ip, end_ip) VALUES ($1, $2, $3, $4, $5, $6, $7)'
      : 'UPDATE virtual_subnets SET slug=$1, name=$2, description=$3, vlan_id=$4, is_logical=$5, start_ip=$6, end_ip=$7, updated_at=NOW() WHERE id=$8';
    if (id !== null) values.push(id);
    return (await db.query(`${sql} RETURNING id, slug, name, description, vlan_id AS "vlanId", is_logical AS "isLogical", host(start_ip) AS "startIp", host(end_ip) AS "endIp"`, values)).rows[0];
  });
}
