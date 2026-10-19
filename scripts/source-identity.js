import { isIP } from "node:net";

export function normalizeMac(value) {
  const hex = String(value ?? "").trim().replace(/[:-]/g, "").toLowerCase();
  return /^[\da-f]{12}$/.test(hex) ? hex.match(/.{2}/g).join(":") : null;
}

export function normalizeSourceIps(...values) {
  return [...new Set(values.flat().filter(Boolean).map((value) => String(value).trim().split("/")[0]))]
    .filter((ip) => isIP(ip));
}

export function normalizeHostname(value) {
  const hostname = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return hostname && hostname.length <= 253 && !isIP(hostname) &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? hostname : null;
}

// Kuma calls this field "hostname" even when its monitor targets an IP literal.
// Do not infer addresses from labels, URLs, partial names, or DNS resolution.
export function normalizeKumaTarget(value) {
  const target = String(value ?? '').trim();
  if (isIP(target)) return { kind: 'ip', value: target.toLowerCase() };
  const hostname = normalizeHostname(target);
  return hostname ? { kind: 'hostname', value: hostname } : null;
}

// Only identity fields belonging to the entity itself count. An AP, gateway,
// integration host, or friendly name is not evidence of device ownership.
export function homeAssistantIdentity(snapshot = {}) {
  const attributes = snapshot.attributes ?? {};
  return {
    mac: normalizeMac(snapshot.mac ?? snapshot.identity?.mac ?? attributes.mac ?? attributes.mac_address ?? attributes.macaddr ?? attributes.mac_addr),
    ips: normalizeSourceIps(snapshot.ip, snapshot.ips, snapshot.identity?.ips, attributes.ip, attributes.ip_address, attributes.ipv4, attributes.ipv6),
  };
}
