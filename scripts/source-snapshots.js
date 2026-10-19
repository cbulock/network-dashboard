// Read the installed snapshot shape rather than altering integration tables
// owned by a different database role on legacy installations.
export async function snapshotColumns(db, table) {
  const { rows } = await db.query(`SELECT attname FROM pg_attribute
    WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [table]);
  return new Set(rows.map((row) => row.attname));
}

export async function storeKumaSnapshot(db, columns, deviceKey, host, status) {
  if (columns.has("hostname")) {
    await db.query(`INSERT INTO uptime_kuma_data (hostname, status, raw)
      VALUES ($1,$2,$3) ON CONFLICT (hostname) DO UPDATE SET
      status=EXCLUDED.status, raw=EXCLUDED.raw`, [host.hostname, host.status, host]);
  } else {
    await db.query(`INSERT INTO uptime_kuma_data (source_device_key, status, raw_data)
      VALUES ($1,$2,$3) ON CONFLICT (source_device_key) DO UPDATE SET
      status=EXCLUDED.status, raw_data=EXCLUDED.raw_data, last_seen=NOW()`,
    [deviceKey, status, host]);
  }
}

export async function storeHomeAssistantSnapshot(db, columns, { entityId, friendlyName, ip, mac, status, attributes, lastUpdated }) {
  if (columns.has("attributes")) {
    await db.query(`INSERT INTO ha_data (entity_id, friendly_name, ip, mac, status, attributes, last_updated)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (entity_id) DO UPDATE SET
      friendly_name=EXCLUDED.friendly_name, ip=EXCLUDED.ip, mac=EXCLUDED.mac,
      status=EXCLUDED.status, attributes=EXCLUDED.attributes, last_updated=EXCLUDED.last_updated`,
    [entityId, friendlyName, ip, mac, status, attributes, lastUpdated]);
  } else {
    await db.query(`INSERT INTO ha_data (entity_id, friendly_name, ip, state, raw_data, last_seen)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (entity_id) DO UPDATE SET
      friendly_name=EXCLUDED.friendly_name, ip=EXCLUDED.ip, state=EXCLUDED.state,
      raw_data=EXCLUDED.raw_data, last_seen=EXCLUDED.last_seen`,
    [entityId, friendlyName, ip, status, { mac, attributes }, lastUpdated]);
  }
}

export async function storeUnifiSnapshot(db, columns, device, { unifiId, mac, hostname, ip }) {
  if (columns.has("unifi_id")) {
    await db.query(`INSERT INTO unifi_data (unifi_id, mac, hostname, ip, raw)
      VALUES ($1,$2::macaddr,$3,$4::inet,$5) ON CONFLICT (unifi_id) DO UPDATE SET
      mac=EXCLUDED.mac, hostname=EXCLUDED.hostname, ip=EXCLUDED.ip, raw=EXCLUDED.raw`,
    [unifiId || mac, mac, hostname, ip, device]);
  } else {
    await db.query(`INSERT INTO unifi_data (mac, name, hostname, ip, raw_data, last_seen)
      VALUES ($1::macaddr,$2,$3,$4::inet,$5,$6) ON CONFLICT (mac) DO UPDATE SET
      name=EXCLUDED.name, hostname=EXCLUDED.hostname, ip=EXCLUDED.ip,
      raw_data=EXCLUDED.raw_data, last_seen=EXCLUDED.last_seen`,
    [mac, device.name ?? hostname, hostname, ip, device, device.last_seen ? new Date(device.last_seen * 1000) : new Date()]);
  }
}
