import { ensureUnifiSchema, assignmentFor, dnsComparison, unifiUrl } from './unifi-platform.js';
import { randomUUID } from "node:crypto";
import { resolveMacHardware } from './mac-hardware.js';
import { inventoryFacts, matchesDeviceSearch, classificationValue, DEVICE_TYPES, DEVICE_ROLES } from '../utils/inventory-model.js';
import { ensureDnsSchema, queueDnsChange, selectDnsRecord, cleanIp, deviceAddress } from './dns-platform.js';
import process from "node:process";
import pg from "pg";
import { normalizeHostname, normalizeKumaTarget, normalizeMac, normalizeSourceIps } from "./source-identity.js";
import { matchVlanForIp, matchDeviceNetworks, normalizeIpRange, matchVlanForRange, matchReservedRangeForIp, getDeviceReservedRanges } from "../utils/network-match.js";

const { Client } = pg;

export function buildDeviceKey(source, id) {
  return `${source}:${id}`;
}

export function mergeIps(...ipLists) {
  return Array.from(
    new Set(
      ipLists
        .flat()
        .filter(Boolean)
        .map((ip) => String(ip).trim())
        .filter(Boolean)
    )
  );
}

export async function getDbClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const db = new Client({ connectionString });
  await db.connect();
  return db;
}

export async function ensureDeviceSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      device_key TEXT UNIQUE NOT NULL,
      mac MACADDR UNIQUE,
      name TEXT,
      ips INET[] DEFAULT '{}',
      status TEXT,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS hostname TEXT
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS display_name TEXT
  `);
  await db.query(`ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS device_type TEXT,
    ADD COLUMN IF NOT EXISTS device_role TEXT,
    ADD COLUMN IF NOT EXISTS keep_current BOOLEAN NOT NULL DEFAULT false`);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS primary_ip INET
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS notes TEXT
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS device_sources (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
      raw_data JSONB,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source, source_id)
    )
  `);

  await db.query(`
    ALTER TABLE device_sources ADD COLUMN IF NOT EXISTS status TEXT
  `);
  // Older installations stored snapshots in details and explicit remaps in
  // mapped_device_key. Keep those readable while collectors use raw_data.
  await db.query(`ALTER TABLE device_sources
    ADD COLUMN IF NOT EXISTS raw_data JSONB,
    ADD COLUMN IF NOT EXISTS mapped_device_key TEXT,
    ADD COLUMN IF NOT EXISTS link_method TEXT`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS unifi_data (
      mac MACADDR PRIMARY KEY,
      name TEXT,
      hostname TEXT,
      ip INET,
      state INTEGER,
      vlan INTEGER,
      raw_data JSONB,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ha_data (
      entity_id TEXT PRIMARY KEY,
      source_device_key TEXT REFERENCES devices(device_key) ON DELETE SET NULL,
      state TEXT,
      ip TEXT,
      friendly_name TEXT,
      raw_data JSONB,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS uptime_kuma_data (
      source_device_key TEXT PRIMARY KEY REFERENCES devices(device_key) ON DELETE CASCADE,
      status TEXT,
      uptime_percent DOUBLE PRECISION,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      raw_data JSONB
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS device_tags (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS vlans (
      id SERIAL PRIMARY KEY,
      vlan_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      subnet CIDR,
      description TEXT,
      color TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS virtual_subnets (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      vlan_id INTEGER REFERENCES vlans(id) ON DELETE SET NULL,
      is_logical BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS device_tag_assignments (
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES device_tags(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (device_id, tag_id)
    )
  `);

  await db.query(`ALTER TABLE virtual_subnets ADD COLUMN IF NOT EXISTS start_ip INET`);
  await db.query(`ALTER TABLE virtual_subnets ADD COLUMN IF NOT EXISTS end_ip INET`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS device_ip_assignments (
      id SERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      ip INET NOT NULL,
      label TEXT,
      assignment_type TEXT NOT NULL DEFAULT 'manual',
      source TEXT NOT NULL DEFAULT 'manual',
      virtual_subnet_id INTEGER REFERENCES virtual_subnets(id) ON DELETE SET NULL,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (device_id, ip)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS subnet_allocations (
      id SERIAL PRIMARY KEY,
      virtual_subnet_id INTEGER NOT NULL REFERENCES virtual_subnets(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      description TEXT,
      start_ip INET,
      end_ip INET,
      cidr CIDR,
      assigned_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      assigned_ip INET,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_device_sources_device_id
      ON device_sources(device_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_devices_last_seen
      ON devices(last_seen DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_device_tag_assignments_device_id
      ON device_tag_assignments(device_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_device_ip_assignments_device_id
      ON device_ip_assignments(device_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_device_ip_assignments_ip
      ON device_ip_assignments(ip)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_subnet_allocations_virtual_subnet_id
      ON subnet_allocations(virtual_subnet_id)
  `);
  await ensureDnsSchema(db);
  await ensureUnifiSchema(db);
  await db.query(`CREATE TABLE IF NOT EXISTS device_merge_aliases (
    old_id INTEGER PRIMARY KEY, device_key TEXT UNIQUE NOT NULL, mac MACADDR UNIQUE,
    device_id INTEGER NOT NULL REFERENCES devices(id));
    CREATE TABLE IF NOT EXISTS device_merge_history (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      target_id INTEGER NOT NULL, removed_id INTEGER NOT NULL, snapshot JSONB NOT NULL);`);
}

export async function findExistingDevice(db, { mac, ips = [] }) {
  mac = normalizeMac(mac);
  const uniqueIps = normalizeSourceIps(ips);

  if (mac) {
    const byMac = await db.query(
      `SELECT * FROM devices WHERE mac = $1 LIMIT 1`,
      [mac]
    );

    if (byMac.rows.length) {
      return byMac.rows[0];
    }
    const byAlias = await db.query(`SELECT d.* FROM device_merge_aliases a
      JOIN devices d ON d.id=a.device_id WHERE a.mac=$1`, [mac]);
    if (byAlias.rows.length) return byAlias.rows[0];
  }

  if (!uniqueIps.length) return null;
  const candidates = await db.query(`
    SELECT d.* FROM devices d
    WHERE EXISTS (SELECT 1 FROM device_sources ds,
      LATERAL jsonb_array_elements_text(COALESCE(ds.raw_data#>'{identity,ips}', '[]'::jsonb)) address
      WHERE ds.source='unifi' AND ds.device_id=d.id AND COALESCE(ds.raw_data->>'active','true')='true'
        AND host(address::inet) IN (SELECT host(input) FROM unnest($1::inet[]) input))
    ORDER BY d.id
  `, [uniqueIps]);
  // Shared/reassigned addresses and conflicting MACs must not merge devices.
  if (candidates.rows.length !== 1) return null;
  const candidate = candidates.rows[0];
  if (mac && candidate.mac && normalizeMac(candidate.mac) !== mac) return null;
  return candidate;
}

// Kuma monitors identify their target by hostname. Only actual hostname fields
// and active DNS aliases count; inventory labels and HA friendly names do not.
export async function findDeviceByKumaHostname(db, value) {
  const hostname = normalizeHostname(value);
  if (!hostname) return null;
  const { rows } = await db.query(`
    SELECT d.* FROM devices d
    WHERE lower(rtrim(trim(d.hostname), '.')) = $1
       OR EXISTS (
         SELECT 1 FROM device_sources ds
         JOIN dns_platform_records dr ON ds.source_id = 'A:' || host(dr.ip)
         CROSS JOIN LATERAL jsonb_array_elements_text(dr.names) AS alias(name)
         WHERE ds.source = 'dns_platform' AND ds.device_id = d.id AND dr.active
           AND lower(rtrim(trim(alias.name), '.')) = $1)
       OR EXISTS (
         SELECT 1 FROM device_sources ds
         WHERE ds.source = 'unifi' AND ds.device_id = d.id
           AND lower(rtrim(trim(COALESCE(ds.raw_data->>'hostname', to_jsonb(ds)#>>'{details,hostname}')), '.')) = $1)
       OR EXISTS (
         SELECT 1 FROM unifi_data u WHERE u.mac = d.mac
           AND lower(rtrim(trim(u.hostname), '.')) = $1)
    ORDER BY d.id
  `, [hostname]);
  return rows.length === 1 ? rows[0] : null;
}

export async function findDeviceByKumaTarget(db, value) {
  const target = normalizeKumaTarget(value);
  if (!target) return null;
  return target.kind === 'ip'
    ? findExistingDevice(db, { ips: [target.value] })
    : findDeviceByKumaHostname(db, target.value);
}

export async function upsertDeviceFromSource(
  db,
  { source, sourceId, mac, name, ip, ips = [], status, rawData, details, lastSeen },
  { schemaReady = false } = {},
) {
  if (!schemaReady) await ensureDeviceSchema(db);

  mac = normalizeMac(mac);
  const kumaTarget = source === 'uptime_kuma'
    ? normalizeKumaTarget(rawData?.hostname ?? details?.hostname ?? sourceId) : null;
  const uniqueIps = normalizeSourceIps(ip, ips, kumaTarget?.kind === 'ip' ? kumaTarget.value : null);
  const kumaStatus = source === "uptime_kuma"
    ? (["up", "down"].includes(status) ? status : "unknown")
    : null;
  const mapped = await db.query(
    `SELECT d.*, ds.link_method, ds.mapped_device_key,
            (SELECT count(*) = 1 FROM device_sources siblings WHERE siblings.device_id = d.id) AS is_single_source
     FROM devices d
     JOIN device_sources ds ON ds.device_id = d.id
     WHERE ds.source = $1 AND ds.source_id = $2 LIMIT 1`,
    [source, sourceId]
  );
  const previous = mapped.rows[0];
  const manual = previous?.link_method === "manual" || Boolean(previous?.mapped_device_key);
  const alias = mac && previous ? await db.query(
    'SELECT 1 FROM device_merge_aliases WHERE device_id=$1 AND mac=$2', [previous.id, mac]) : null;
  const compatible = !mac || !previous?.mac || normalizeMac(previous.mac) === mac || Boolean(alias?.rows.length);
  if (previous && !manual && !compatible && source !== "home_assistant") {
    throw new Error(`Conflicting MAC for ${source}:${sourceId}; review the existing source mapping.`);
  }
  const standaloneEntity = source === "home_assistant" && !mac && !uniqueIps.length && previous?.is_single_source;
  const kumaMatch = source === "uptime_kuma" && !manual
    ? await findDeviceByKumaTarget(db, kumaTarget?.value)
    : null;
  const existing = kumaMatch || (manual || standaloneEntity || (source !== "home_assistant" && compatible && previous)
    ? previous
    : await findExistingDevice(db, { mac, ips: uniqueIps }));
  const linkMethod = manual ? "manual" : kumaMatch ? (kumaTarget.kind === 'ip' ? 'network_identity' : 'hostname') : standaloneEntity ? "legacy_entity" : source === "home_assistant" ? "network_identity" : previous && existing?.id === previous.id ? previous.link_method : existing ? "network_identity" : "source_id";
  const snapshot = { ...(rawData ?? details ?? {}), identity: { mac, ips: uniqueIps } };
  const seenAt = lastSeen ?? new Date();

  // HA states include people, weather and services. Keep unmatched entities as
  // source records rather than manufacturing devices or merging friendly names.
  if (source === "home_assistant" && !existing) {
    await db.query(`
      INSERT INTO device_sources (source, source_id, device_id, raw_data, status, last_seen, link_method)
      VALUES ($1, $2, NULL, $3, NULL, $4, NULL)
      ON CONFLICT (source, source_id) DO UPDATE SET
        device_id = NULL, raw_data = EXCLUDED.raw_data, status = NULL,
        last_seen = EXCLUDED.last_seen, link_method = NULL
    `, [source, sourceId, snapshot, seenAt]);
    return { deviceKey: null, deviceId: null };
  }
  const deviceKey = existing?.device_key || buildDeviceKey(source, sourceId);

  await db.query(
    `
      INSERT INTO devices (device_key, mac, name, ips, last_seen, updated_at)
      VALUES ($1, $2, $3, $4::inet[], $5, NOW())
      ON CONFLICT (device_key)
      DO UPDATE SET
        mac = COALESCE(devices.mac, EXCLUDED.mac),
        name = COALESCE(devices.name, EXCLUDED.name),
        ips = CASE WHEN $6 THEN EXCLUDED.ips ELSE devices.ips END,
        last_seen = GREATEST(devices.last_seen, EXCLUDED.last_seen),
        updated_at = NOW()
    `,
    [deviceKey, mac || null, name || null, source === "unifi" ? uniqueIps : [], seenAt, source === "unifi"]
  );

  const deviceRes = await db.query(
    `SELECT id, device_key FROM devices WHERE device_key = $1`,
    [deviceKey]
  );
  const device = deviceRes.rows[0];

  await db.query(
    `
      INSERT INTO device_sources (source, source_id, device_id, raw_data, status, last_seen, link_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (source, source_id)
      DO UPDATE SET
        device_id = EXCLUDED.device_id,
        raw_data = EXCLUDED.raw_data,
        status = EXCLUDED.status,
        last_seen = EXCLUDED.last_seen,
        link_method = EXCLUDED.link_method
    `,
    [source, sourceId, device.id, snapshot, kumaStatus, seenAt, linkMethod]
  );

  return { deviceKey: device.device_key, deviceId: device.id };
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeMacAddress(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(normalized)) {
    throw new Error("MAC address must use six octets separated by : or -");
  }

  return normalized.toLowerCase().replace(/-/g, ":");
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeTagName(value) {
  return normalizeText(typeof value === "string" ? value : value?.name);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags = [];
  const seen = new Set();

  for (const item of value) {
    const name = normalizeTagName(item);

    if (!name) {
      continue;
    }

    const slug = slugify(name);

    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    tags.push({ slug, name });
  }

  return tags;
}

function normalizeIpAssignments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const assignments = [];
  const seen = new Set();

  for (const item of value) {
    const raw = typeof item === "string" ? { ip: item } : item || {};
    const ip = normalizeText(raw.ip);

    if (!ip || seen.has(ip)) {
      continue;
    }

    seen.add(ip);
    assignments.push({
      ip,
      label: normalizeText(raw.label),
      assignmentType: normalizeText(raw.assignmentType) || "manual",
      source: normalizeText(raw.source) || "manual",
      virtualSubnetId: normalizeInteger(
        raw.virtualSubnetId ?? raw.reservedRangeId
      ),
      isPrimary: Boolean(raw.isPrimary),
    });
  }

  return assignments;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeDevicePayload(payload = {}) {
  if (hasOwn(payload, 'keepCurrent') && typeof payload.keepCurrent !== 'boolean')
    throw new Error('Keep in Current must be true or false.');
  return {
    deviceType: classificationValue(payload.deviceType, DEVICE_TYPES),
    role: classificationValue(payload.role, DEVICE_ROLES),
    keepCurrent: payload.keepCurrent === true,
    name: normalizeText(payload.name),
    hostname: normalizeText(payload.hostname),
    displayName: normalizeText(payload.displayName),
    mac: normalizeMacAddress(payload.mac),
    notes: normalizeText(payload.notes),
    primaryIp: normalizeText(payload.primaryIp),
    tags: normalizeTags(payload.tags),
    assignedIps: normalizeIpAssignments(
      payload.assignedIps ?? payload.ipAssignments
    ),
  };
}

function coalesceDeviceName({ name, displayName, hostname, existingName }) {
  return displayName || hostname || name || existingName || null;
}

async function replaceDeviceTags(db, deviceId, tags) {
  await db.query(`DELETE FROM device_tag_assignments WHERE device_id = $1`, [
    deviceId,
  ]);

  for (const tag of tags) {
    const tagRes = await db.query(
      `
        INSERT INTO device_tags (slug, name, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (slug)
        DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
        RETURNING id
      `,
      [tag.slug, tag.name]
    );

    await db.query(
      `
        INSERT INTO device_tag_assignments (device_id, tag_id)
        VALUES ($1, $2)
        ON CONFLICT (device_id, tag_id) DO NOTHING
      `,
      [deviceId, tagRes.rows[0].id]
    );
  }
}

async function replaceDeviceIpAssignments(db, deviceId, assignments) {
  await db.query(`DELETE FROM device_ip_assignments WHERE device_id = $1`, [
    deviceId,
  ]);

  for (const assignment of assignments) {
    await db.query(
      `
        INSERT INTO device_ip_assignments (
          device_id,
          ip,
          label,
          assignment_type,
          source,
          virtual_subnet_id,
          is_primary,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `,
      [
        deviceId,
        assignment.ip,
        assignment.label,
        assignment.assignmentType,
        assignment.source,
        assignment.virtualSubnetId,
        assignment.isPrimary,
      ]
    );
  }
}

async function inferReservedRangeIdForIp(db, ip, vlanId = null) {
  const rangeMatch = await db.query(
    `SELECT id, host(start_ip) AS "startIp", host(end_ip) AS "endIp" FROM virtual_subnets
     WHERE family(start_ip) = family($1::inet)
       AND $1::inet >= start_ip AND $1::inet <= end_ip`,
    [ip]
  );
  if (rangeMatch.rows.length) return matchReservedRangeForIp(ip, rangeMatch.rows).id;

  const allocationMatch = await db.query(
    `
      SELECT sa.virtual_subnet_id AS id
      FROM subnet_allocations sa
      WHERE (
        sa.assigned_ip IS NOT NULL
        AND $1::inet = sa.assigned_ip
      )
      OR (
        sa.cidr IS NOT NULL
        AND $1::inet <<= sa.cidr
      )
      OR (
        sa.start_ip IS NOT NULL
        AND sa.end_ip IS NOT NULL
        AND $1::inet >= sa.start_ip
        AND $1::inet <= sa.end_ip
      )
      ORDER BY
        (sa.assigned_ip IS NOT NULL) DESC,
        masklen(sa.cidr) DESC NULLS LAST,
        sa.id ASC
      LIMIT 1
    `,
    [ip]
  );

  if (allocationMatch.rows.length) {
    return allocationMatch.rows[0].id;
  }

  if (vlanId === null || vlanId === undefined) {
    return null;
  }

  const vlanMatches = await db.query(
    `
      SELECT id
      FROM virtual_subnets
      WHERE vlan_id = $1
        AND start_ip IS NULL AND end_ip IS NULL
      ORDER BY name
      LIMIT 2
    `,
    [vlanId]
  );

  return vlanMatches.rows.length === 1 ? vlanMatches.rows[0].id : null;
}

async function resolveIpAssignments(db, assignments) {
  const vlans = await listVlans(db);
  const resolvedAssignments = [];

  for (const assignment of assignments) {
    const vlanId = matchVlanForIp(assignment.ip, vlans)?.id ?? null;
    const virtualSubnetId = await inferReservedRangeIdForIp(
      db,
      assignment.ip,
      vlanId
    );

    resolvedAssignments.push({
      ...assignment,
      vlanId,
      virtualSubnetId,
    });
  }

  return resolvedAssignments;
}

function determinePrimaryIp(explicitPrimaryIp, assignments, fallbackPrimaryIp) {
  if (explicitPrimaryIp !== undefined) {
    return explicitPrimaryIp;
  }

  const flagged = assignments.find((assignment) => assignment.isPrimary)?.ip;
  if (flagged) {
    return flagged;
  }

  return fallbackPrimaryIp ?? null;
}

function mapInventoryDeviceRow(row, vlans, ranges) {
  const dnsRecords = row.dns_records ?? [];
  const unifiRecords = (row.unifi_records ?? []).filter(record => record && record.active !== false);
  const primaryRecord = unifiRecords.find(record => normalizeMac(record.mac) === normalizeMac(row.mac)) ||
    unifiRecords.find(record => record.connected) || unifiRecords[0];
  const unifi = assignmentFor(primaryRecord, row.unifi_networks ?? []);
  const discoveredIps = normalizeSourceIps(unifi.ips, unifiRecords.flatMap(record => [record.ip, ...(record.ipv6_addresses ?? [])]));
  const assignedIps = [];
  const allIps = discoveredIps;
  const primaryIp = allIps.find(ip => deviceAddress(ip)) || allIps[0] || null;
  const dnsRecord = selectDnsRecord(dnsRecords, row.dns_target_ip, primaryIp);
  const effectiveHostname = row.managed_hostname || dnsRecord?.names?.[0] || row.hostname;

  return {
    id: row.id,
    deviceKey: row.device_key,
    macs: [...new Set([row.mac, ...(row.merged_macs || []), ...unifiRecords.map(record => normalizeMac(record.mac))].filter(Boolean))],
    name:
      row.display_name || effectiveHostname || row.name || (row.mac ? `Device ${row.mac}` : 'Unnamed device'),
    legacyName: row.name,
    hostname: effectiveHostname,
    dns: { configured: Boolean(process.env.DNS_PLATFORM_SSH_TARGET), moveSupported: (row.dns_capabilities ?? []).includes('hostname.move'), targetIp: cleanIp(row.dns_target_ip) || dnsRecord?.ip ||
      (deviceAddress(primaryIp) ? cleanIp(primaryIp) : allIps.find(deviceAddress)) || '',
      records: dnsRecords, revision: row.dns_revision ?? null, zone: row.dns_zone ?? 'bulock',
      lastSync: row.dns_last_sync ?? null, error: row.dns_error ?? null, operation: row.dns_operation ?? null },
    unifi: { ...unifi, checkedAt: row.unifi_sync ?? null, error: row.unifi_error ?? null, operation: row.unifi_operation ?? null },
    unifiUrl: unifiUrl(),
    dnsComparison: dnsComparison({ hostname: effectiveHostname, records: dnsRecords, ips: allIps,
      unifiError: row.unifi_error, dnsError: row.dns_error, lastSync: row.dns_last_sync,
      unifiSync: row.unifi_sync, operation: row.dns_operation, ipOperation: row.unifi_operation }),
    displayName: row.display_name,
    mac: row.mac,
    primaryIp,
    ips: discoveredIps,
    discoveredIps,
    assignedIps: [],
    allIps,
    reservedRanges: getDeviceReservedRanges({ primaryIp, allIps, assignedIps }, ranges),
    // Legacy devices.status may contain manual values or other collectors' states.
    // Only readings attached to the device's Kuma source mappings are trusted.
    status: getKumaStatus(row.sources),
    lastSeen: row.last_seen,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vlan: matchVlanForIp(primaryIp, vlans),
    vlans: matchDeviceNetworks(primaryIp, allIps, vlans),
    tags: Array.isArray(row.tags) ? row.tags : [],
    sources: Array.isArray(row.sources) ? row.sources : [],
    ...inventoryFacts(row, row.unifi_records || [], dnsRecords),
  };
}

function getKumaStatus(sources = []) {
  const readings = (sources ?? []).filter((source) => source.source === "uptime_kuma");
  if (readings.some((reading) => reading.status === "down")) return "down";
  if (readings.length && readings.every((reading) => reading.status === "up")) return "up";
  return "unknown";
}

function buildInventoryWhere(filters, values) {
  const conditions = [];

  if (filters.id !== null && filters.id !== undefined) {
    values.push(filters.id);
    conditions.push(`d.id = $${values.length}`);
  }

  if (filters.search) {
    values.push(`%${filters.search}%`);
    const placeholder = `$${values.length}`;
    conditions.push(`
      (
        COALESCE(d.display_name, '') ILIKE ${placeholder}
        OR COALESCE(d.hostname, '') ILIKE ${placeholder}
        OR COALESCE(d.name, '') ILIKE ${placeholder}
        OR COALESCE(d.device_key, '') ILIKE ${placeholder}
        OR COALESCE(d.notes, '') ILIKE ${placeholder}
        OR EXISTS (SELECT 1 FROM device_sources s JOIN dns_platform_records r ON s.source_id='A:'||host(r.ip)
          WHERE s.source='dns_platform' AND s.device_id=d.id AND r.active AND r.names::text ILIKE ${placeholder})
      )
    `);
  }

  if (filters.tags?.length) {
    values.push(filters.tags);
    const placeholder = `$${values.length}`;
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM device_tag_assignments dta
        JOIN device_tags dt ON dt.id = dta.tag_id
        WHERE dta.device_id = d.id
          AND (dt.slug = ANY(${placeholder}::text[]) OR dt.name = ANY(${placeholder}::text[]))
      )
    `);
  }

  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

function resolveSort(sortBy, sortDir) {
  const direction = sortDir === "asc" ? "ASC" : "DESC";
  const sortColumns = {
    createdAt: `d.created_at ${direction}`,
    hostname: `COALESCE(d.hostname, d.name, d.device_key) ${direction}`,
    lastSeen: `d.last_seen ${direction}`,
    name: `COALESCE(d.display_name, d.hostname, d.name, d.device_key) ${direction}`,
    updatedAt: `d.updated_at ${direction}`,
  };

  return sortColumns[sortBy] || sortColumns.name;
}

export async function listInventoryDevices(db, filters = {}) {
  const normalizedTags = Array.isArray(filters.tags)
    ? filters.tags.map(normalizeText).filter(Boolean)
    : filters.tag
      ? [normalizeText(filters.tag)].filter(Boolean)
      : [];
  const values = [];
  const whereSql = buildInventoryWhere(
    {
      id: normalizeInteger(filters.id),
      // Search the final normalized identity/address/alias fields after mapping.
      search: null,
      tags: normalizedTags,
    },
    values
  );
  const orderBy = resolveSort(filters.sortBy, filters.sortDir);

  const result = await db.query(
    `
      SELECT
        d.id,
        d.device_key,
        ARRAY(SELECT a.mac::text FROM device_merge_aliases a WHERE a.device_id=d.id AND a.mac IS NOT NULL ORDER BY a.old_id) AS merged_macs,
        d.name,
        d.hostname,
        host(d.dns_target_ip) AS dns_target_ip,
        (SELECT revision FROM dns_platform_state WHERE id=1) AS dns_revision,
        (SELECT zone FROM dns_platform_state WHERE id=1) AS dns_zone,
        (SELECT capabilities FROM dns_platform_state WHERE id=1) AS dns_capabilities,
        (SELECT last_sync FROM dns_platform_state WHERE id=1) AS dns_last_sync,
        (SELECT error FROM dns_platform_state WHERE id=1) AS dns_error,
        (SELECT jsonb_build_object('id',j.id,'state',j.state,'hostname',j.hostname,'ip',host(j.ip),
          'error',j.error,'remote',j.remote,'updatedAt',j.updated_at)
          FROM dns_platform_jobs j WHERE j.device_id=d.id ORDER BY j.created_at DESC LIMIT 1) AS dns_operation,
        d.managed_hostname,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('ip',host(r.ip),'names',r.names) ORDER BY r.ip),'[]'::jsonb)
          FROM dns_platform_records r WHERE r.active AND (
            (d.managed_hostname IS NOT NULL AND r.names ? d.managed_hostname) OR
            (d.managed_hostname IS NULL AND EXISTS(SELECT 1 FROM device_sources s WHERE s.source='dns_platform'
              AND s.device_id=d.id AND s.source_id='A:'||host(r.ip))))) AS dns_records,
        (SELECT networks FROM unifi_inventory_state WHERE id=1) AS unifi_networks,
        (SELECT last_sync FROM unifi_inventory_state WHERE id=1) AS unifi_sync,
        (SELECT error FROM unifi_inventory_state WHERE id=1) AS unifi_error,
        (SELECT jsonb_agg(raw_data) FROM device_sources WHERE source='unifi' AND device_id=d.id) AS unifi_records,
        (SELECT jsonb_build_object('id',j.id,'state',j.state,'error',j.error,'ip',host(j.ip),'updatedAt',j.updated_at)
          FROM unifi_ip_jobs j WHERE j.device_id=d.id ORDER BY j.created_at DESC LIMIT 1) AS unifi_operation,
        d.display_name,
        d.device_type,
        d.device_role,
        d.keep_current,
        d.mac::text AS mac,
        ARRAY(
          SELECT ip::text
          FROM UNNEST(COALESCE(d.ips, '{}'::inet[])) AS ip
        ) AS discovered_ips,
        d.primary_ip::text AS primary_ip,
        d.last_seen,
        d.notes,
        d.created_at,
        d.updated_at,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', dt.id,
                'slug', dt.slug,
                'name', dt.name
              )
              ORDER BY dt.name
            )
            FROM device_tag_assignments dta
            JOIN device_tags dt ON dt.id = dta.tag_id
            WHERE dta.device_id = d.id
          ),
          '[]'::jsonb
        ) AS tags,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', dia.id,
                'ip', dia.ip::text,
                'label', dia.label,
                'assignmentType', dia.assignment_type,
                'source', dia.source,
                'virtualSubnetId', dia.virtual_subnet_id,
                'virtualSubnetName', vs.name,
                'reservedRangeId', dia.virtual_subnet_id,
                'reservedRangeName', vs.name,
                'isPrimary', dia.is_primary,
                'createdAt', dia.created_at,
                'updatedAt', dia.updated_at
              )
              ORDER BY dia.is_primary DESC, dia.ip ASC
            )
            FROM device_ip_assignments dia
            LEFT JOIN virtual_subnets vs ON vs.id = dia.virtual_subnet_id
            WHERE dia.device_id = d.id
          ),
          '[]'::jsonb
        ) AS assigned_ips,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'source', ds.source,
                'sourceId', ds.source_id,
                'name', COALESCE(ds.raw_data->>'friendly_name', ds.raw_data#>>'{attributes,friendly_name}', to_jsonb(ds)#>>'{details,attributes,friendly_name}', ds.source_id),
                'linkMethod', CASE WHEN ds.mapped_device_key IS NOT NULL THEN 'manual' ELSE ds.link_method END,
                'status', ds.status,
                'lastSeen', ds.last_seen
              )
              ORDER BY ds.source, ds.source_id
            )
            FROM device_sources ds
            WHERE ds.device_id = d.id
              AND (ds.source <> 'dns_platform' OR COALESCE(ds.raw_data->>'active','true')='true')
          ),
          '[]'::jsonb
        ) AS sources
      FROM devices d
      ${whereSql}
      ORDER BY ${orderBy}
    `,
    values
  );

  const [vlans, rangeResult] = await Promise.all([
    listVlans(db),
    db.query(`SELECT id, name, host(start_ip) AS "startIp", host(end_ip) AS "endIp" FROM virtual_subnets`),
  ]);
  let devices = result.rows.map((row) => mapInventoryDeviceRow(row, vlans, rangeResult.rows));
  if (filters.search) devices = devices.filter(device => matchesDeviceSearch(device, filters.search));
  if (['name', 'hostname'].includes(filters.sortBy) || !filters.sortBy) {
    const direction = filters.sortDir === 'asc' ? 1 : -1;
    const field = filters.sortBy === 'hostname' ? 'hostname' : 'name';
    devices.sort((a,b) => direction * String(a[field] || a.name).localeCompare(String(b[field] || b.name), undefined, { numeric: true }) || a.id-b.id);
  }
  const vlanId = normalizeInteger(filters.vlanId);
  if (vlanId !== null) {
    devices = devices.filter((device) => device.vlans.some((vlan) => vlan.id === vlanId));
  }
  if (filters.sortBy === "vlan") {
    const direction = filters.sortDir === "asc" ? 1 : -1;
    devices.sort((left, right) => direction * ((left.vlan?.vlanId ?? 0) - (right.vlan?.vlanId ?? 0)) || left.name.localeCompare(right.name));
  }
  return devices;
}

export async function getInventoryDeviceById(db, id) {
  const devices = await listInventoryDevices(db, { id });
  return devices.find((device) => device.id === id) || null;
}

export async function getInventoryDeviceDetails(db, id) {
  const alias = await db.query('SELECT device_id FROM device_merge_aliases WHERE old_id=$1', [id]);
  const device = await getInventoryDeviceById(db, alias.rows[0]?.device_id ?? id);
  return device ? { ...device, hardware: { ...device.hardware, ...resolveMacHardware(device.mac) } } : null;
}

async function upsertVirtualSubnetReferences(db, assignments) {
  const ids = Array.from(
    new Set(
      assignments
        .map((assignment) => assignment.virtualSubnetId)
        .filter((value) => value !== null && value !== undefined)
    )
  );

  if (!ids.length) {
    return;
  }

  const result = await db.query(
    `SELECT id FROM virtual_subnets WHERE id = ANY($1::int[])`,
    [ids]
  );

  if (result.rows.length !== ids.length) {
    throw new Error("One or more reserved range IDs do not exist");
  }
}

export async function createInventoryDevice(db, payload) {
  rejectLocalAddresses(payload);
  const normalized = normalizeDevicePayload(payload);
  const deviceKey = normalizeText(payload.deviceKey) || `manual:${randomUUID()}`;
  const resolvedAssignments = await resolveIpAssignments(
    db,
    normalized.assignedIps
  );

  await db.query("BEGIN");

  try {
    if (normalized.mac && (await db.query('SELECT old_id FROM device_merge_aliases WHERE mac=$1', [normalized.mac])).rows.length)
      throw new Error('This MAC belongs to a merged device. Open that device to edit it.');
    const effectiveName = coalesceDeviceName({
      name: normalized.name,
      displayName: normalized.displayName,
      hostname: normalized.hostname,
      existingName: null,
    });
    const primaryIp = determinePrimaryIp(
      hasOwn(payload, "primaryIp") ? normalized.primaryIp : undefined,
      resolvedAssignments,
      null
    );

    const result = await db.query(
      `
        INSERT INTO devices (
          device_key,
          mac,
          name,
          hostname,
          display_name,
          primary_ip,
          notes,
          device_type,
          device_role,
          keep_current,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        RETURNING id
      `,
      [
        deviceKey,
        normalized.mac,
        effectiveName,
        payload.dns ? null : normalized.hostname,
        normalized.displayName,
        primaryIp,
        normalized.notes,
        normalized.deviceType,
        normalized.role,
        normalized.keepCurrent,
      ]
    );

    const deviceId = result.rows[0].id;
    await replaceDeviceTags(db, deviceId, normalized.tags);
    await replaceDeviceIpAssignments(db, deviceId, resolvedAssignments);
    await queueDnsChange(db, deviceId, payload);

    await db.query("COMMIT");
    return getInventoryDeviceDetails(db, deviceId);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function updateInventoryDevice(db, id, payload) {
  rejectLocalAddresses(payload);
  const existingView = payload.dns ? await getInventoryDeviceDetails(db, id) : null;
  const existingRes = await db.query(`SELECT * FROM devices WHERE id = $1`, [id]);

  if (!existingRes.rows.length) {
    return null;
  }

  const existing = existingRes.rows[0];
  const normalized = normalizeDevicePayload(payload);

  if (hasOwn(payload, 'mac') && normalized.mac && (await db.query(
    'SELECT old_id FROM device_merge_aliases WHERE mac=$1 AND device_id<>$2', [normalized.mac, id])).rows.length)
    throw new Error('This MAC belongs to another merged device.');

  const assignmentPayloadProvided =
    hasOwn(payload, "assignedIps") || hasOwn(payload, "ipAssignments");

  await db.query("BEGIN");

  try {
    const nextAssignments = assignmentPayloadProvided
      ? await resolveIpAssignments(db, normalized.assignedIps)
      : await getCurrentAssignments(db, id);
    // Removing a manual address must also remove its primary-IP fallback.
    const previousPrimaryIp = existing.primary_ip ? String(existing.primary_ip) : null;
    const keepPreviousPrimary = !assignmentPayloadProvided ||
      nextAssignments.some((assignment) => assignment.ip === previousPrimaryIp) ||
      (existing.ips ?? []).includes(previousPrimaryIp);
    const nextPrimaryIp = determinePrimaryIp(
      hasOwn(payload, "primaryIp") ? normalized.primaryIp : undefined,
      nextAssignments,
      keepPreviousPrimary ? previousPrimaryIp : null
    );
    const nextName = coalesceDeviceName({
      name: hasOwn(payload, "name") ? normalized.name : existing.name,
      displayName: hasOwn(payload, "displayName")
        ? normalized.displayName
        : existing.display_name,
      hostname: hasOwn(payload, "hostname")
        ? normalized.hostname
        : existing.hostname,
      existingName: existing.name,
    });

    await db.query(
      `
        UPDATE devices
        SET
          mac = $2,
          name = $3,
          hostname = $4,
          display_name = $5,
          primary_ip = $6,
          notes = $7,
          device_type = $8,
          device_role = $9,
          keep_current = $10,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        id,
        hasOwn(payload, "mac") ? normalized.mac : existing.mac,
        nextName,
        hasOwn(payload, "hostname") && !payload.dns ? normalized.hostname : existing.hostname,
        hasOwn(payload, "displayName")
          ? normalized.displayName
          : existing.display_name,
        nextPrimaryIp,
        hasOwn(payload, "notes") ? normalized.notes : existing.notes,
        hasOwn(payload, 'deviceType') ? normalized.deviceType : existing.device_type || null,
        hasOwn(payload, 'role') ? normalized.role : existing.device_role || null,
        hasOwn(payload, 'keepCurrent') ? normalized.keepCurrent : existing.keep_current === true,
      ]
    );

    if (hasOwn(payload, "tags")) {
      await replaceDeviceTags(db, id, normalized.tags);
    }

    if (assignmentPayloadProvided) {
      await replaceDeviceIpAssignments(db, id, nextAssignments);
    }
    await queueDnsChange(db, id, payload, existingView);

    await db.query("COMMIT");
    return getInventoryDeviceDetails(db, id);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function getCurrentAssignments(db, deviceId) {
  const result = await db.query(
    `
      SELECT
        ip::text AS ip,
        label,
        assignment_type AS "assignmentType",
        source,
        virtual_subnet_id AS "reservedRangeId",
        virtual_subnet_id AS "virtualSubnetId",
        is_primary AS "isPrimary"
      FROM device_ip_assignments
      WHERE device_id = $1
      ORDER BY is_primary DESC, ip ASC
    `,
    [deviceId]
  );

  return result.rows;
}

async function listVlans(db) {
  const result = await db.query(`
    SELECT id, vlan_id AS "vlanId", name, subnet::text AS subnet, description, color
    FROM vlans ORDER BY vlan_id
  `);
  return result.rows;
}

export async function listInventoryLookups(db) {
  const [tags, vlans, virtualSubnets] = await Promise.all([
    db.query(
      `
        SELECT id, slug, name
        FROM device_tags
        ORDER BY name
      `
    ),
    listVlans(db),
    db.query(
      `
        SELECT
          vs.id,
          vs.slug,
          vs.name,
          vs.description,
          host(vs.start_ip) AS "startIp",
          host(vs.end_ip) AS "endIp",
          vs.vlan_id AS "vlanId",
          vs.is_logical AS "isLogical",
          COUNT(sa.id)::integer AS "allocationCount"
        FROM virtual_subnets vs
        LEFT JOIN subnet_allocations sa ON sa.virtual_subnet_id = vs.id
        GROUP BY vs.id
        ORDER BY vs.name
      `
    ),
  ]);

  const ranges = virtualSubnets.rows.map((range) => ({
    ...range,
    vlanId: range.startIp && range.endIp
      ? matchVlanForRange(range.startIp, range.endIp, vlans)?.id ?? null
      : range.vlanId,
  }));

  return {
    tags: tags.rows,
    vlans,
    reservedRanges: ranges,
    virtualSubnets: ranges,
  };
}

export { saveVlan as createVlan, saveReservedRange as updateReservedRange, saveVlan as updateVlan } from './network-registry.js';
import { saveReservedRange as createReservedRange } from './network-registry.js';
export { createReservedRange };

export const createVirtualSubnet = createReservedRange;

function rejectLocalAddresses(payload) {
  if (['primaryIp','assignedIps','ipAssignments','ips'].some(key => Object.hasOwn(payload, key))) {
    const error = new Error('Device IP addresses are managed in UniFi. Use the UniFi IP assignment action.');
    error.statusCode = 400; throw error;
  }
}

