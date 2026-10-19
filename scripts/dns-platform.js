import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

export const cleanIp = (value) => String(value ?? '').trim().split('/')[0];
export function hostname(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!name || name.length > 253 || !name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new Error('Enter a valid DNS hostname.');
  return name;
}
export function deviceAddress(value) {
  const ip = cleanIp(value);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254);
}
export function normalizeSnapshot(snapshot) {
  if (!snapshot?.revision || !Array.isArray(snapshot.records)) throw new Error('Invalid DNS Platform snapshot');
  const zone = hostname(snapshot.zone);
  const seen = new Set();
  const records = snapshot.records.map(record => {
    const ip = cleanIp(record.value);
    if (record.type !== 'A' || isIP(ip) !== 4 || seen.has(ip) || !Array.isArray(record.names) || !record.names.length)
      throw new Error('Invalid or duplicate DNS Platform address record');
    seen.add(ip);
    return { ip, names: [...new Set(record.names.map(hostname))] };
  });
  return { revision: snapshot.revision, zone, records, capabilities: Array.isArray(snapshot.capabilities) ? snapshot.capabilities.filter(value=>value==='hostname.move') : [] };
}
export function selectDnsRecord(records, targetIp, primaryIp) {
  return records.find(r => r.ip === cleanIp(targetIp)) || records.find(r => r.ip === cleanIp(primaryIp)) ||
    [...records].sort((a,b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))[0] || null;
}

export async function ensureDnsSchema(db) {
  await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS dns_target_ip INET;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS managed_hostname TEXT;
    CREATE TABLE IF NOT EXISTS dns_platform_state (
      id INTEGER PRIMARY KEY CHECK (id=1), revision TEXT, zone TEXT, last_sync TIMESTAMPTZ, error TEXT);
    ALTER TABLE dns_platform_state ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]';
    INSERT INTO dns_platform_state(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS dns_platform_records (
      ip INET PRIMARY KEY, names JSONB NOT NULL, revision TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true);
    CREATE TABLE IF NOT EXISTS dns_platform_jobs (
      id UUID PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id), hostname TEXT NOT NULL,
      ip INET NOT NULL, expected_revision TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      remote JSONB, error TEXT, retry_requested BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE dns_platform_jobs ADD COLUMN IF NOT EXISTS move_from INET;
    CREATE UNIQUE INDEX IF NOT EXISTS dns_one_active_job ON dns_platform_jobs(device_id)
      WHERE state IN ('pending','deploying');`);
  await db.query(`UPDATE devices d SET managed_hostname=b.name FROM (
    SELECT s.device_id,min(r.names->>0) AS name FROM device_sources s
    JOIN dns_platform_records r ON s.source_id='A:'||host(r.ip)
    WHERE s.source='dns_platform' AND r.active GROUP BY s.device_id HAVING count(*)=1
  ) b WHERE d.id=b.device_id AND d.managed_hostname IS NULL`);
}

// Called inside the inventory transaction: the outbox survives process restarts.
export async function queueDnsChange(db, deviceId, payload, existing = null) {
  if (!payload.dns) return;
  const name = hostname(payload.hostname);
  const ip = cleanIp(payload.dns.targetIp);
  if (name === existing?.hostname && ip === cleanIp(existing?.dns?.targetIp)) return;
  if (!process.env.DNS_PLATFORM_SSH_TARGET) throw new Error('DNS Platform controller is not configured.');
  if (!deviceAddress(ip)) throw new Error('Select a device IPv4 address for DNS.');
  const { rows: owners } = await db.query(`SELECT d.id FROM devices d WHERE d.id=$1 AND
    EXISTS(SELECT 1 FROM device_sources s WHERE s.source='unifi' AND s.device_id=d.id
      AND COALESCE(s.raw_data->>'active','true')='true'
      AND (s.raw_data#>'{identity,ips}') ? $2) FOR UPDATE`, [deviceId, ip]);
  if (!owners.length) throw new Error('The selected DNS IP must belong to this device.');
  const { rows: [state] } = await db.query('SELECT * FROM dns_platform_state WHERE id=1');
  if (!state?.revision || payload.dns.expectedRevision !== state.revision) {
    const error = new Error('DNS records changed. Refresh this device before saving.'); error.statusCode = 409; throw error;
  }
  const { rows: active } = await db.query("SELECT id FROM dns_platform_jobs WHERE device_id=$1 AND state IN ('pending','deploying')", [deviceId]);
  if (active.length) throw new Error('This device already has a DNS update in progress.');
  await db.query(`INSERT INTO dns_platform_jobs(id,device_id,hostname,ip,expected_revision) VALUES($1,$2,$3,$4,$5)`,
    [randomUUID(), deviceId, name, ip, state.revision]);
  await db.query('UPDATE devices SET dns_target_ip=$2 WHERE id=$1', [deviceId, ip]);
}

export function controllerRequest(request, options = {}) {
  const target = options.target ?? process.env.DNS_PLATFORM_SSH_TARGET;
  if (!target || !/^[\w.@:-]+$/.test(target) || target.startsWith('-')) throw new Error('Configure DNS_PLATFORM_SSH_TARGET.');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
  const key = options.key ?? process.env.DNS_PLATFORM_SSH_KEY;
  if (key) args.push('-i', key, '-o', 'IdentitiesOnly=yes');
  args.push(target, 'dns-platform-control');
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('DNS controller request timed out; the worker will reconcile its request ID.')); }, 30000);
    child.stdout.on('data', data => { size += data.length; if (size > 4 * 1024 * 1024) child.kill(); else stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 2000) stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`DNS controller connection failed (${code}). Check SSH access.`));
      try { const result = JSON.parse(stdout); if (result.error && !result.state) throw new Error(result.error); resolve(result); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
