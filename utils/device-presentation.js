import {
  getDeviceIps,
  matchVlanForIp,
  matchReservedRangeForIp,
} from "./network-match.js";

export const hostIp = (value) =>
  String(value || "").replace(/^(\d{1,3}(?:\.\d{1,3}){3})\/32$/, "$1");
export const deviceTitle = (device) =>
  device.displayName || device.hostname || device.name || "Unnamed device";
const sourceInfo = {
  unifi: ["UniFi", "Device ID"],
  dns_platform: ["DNS Platform", "Address record"],
  home_assistant: ["Home Assistant", "Entity ID"],
  uptime_kuma: ["Uptime Kuma", "Monitor host"],
};

export function healthPresentation(device) {
  if (device.monitoring) return { label: device.monitoring.label,
    tone: device.monitoring.label === 'Healthy' ? 'success' : device.monitoring.label === 'Failing' ? 'danger' : 'neutral' };
  if (!(device.sources || []).some((source) => source.source === "uptime_kuma"))
    return { label: "Not monitored", tone: "neutral" };
  return device.status === "up"
    ? { label: "Healthy", tone: "success" }
    : device.status === "down"
      ? { label: "Failing", tone: "danger" }
      : { label: "Unknown", tone: "neutral" };
}

export function operationPresentation(device) {
  const ip = device.unifi?.operation;
  const dns = device.dns?.operation;
  const labels = {
    pending: "Address update queued",
    applying: "Applying address update",
    waiting: "Waiting for the device to report its new address",
    dns_pending: "Address applied. Updating DNS",
    dns_failed: "Address applied. DNS needs attention",
    failed: "Address update failed",
    conflict: "Address settings changed. Review before retrying",
    completed: "Address update completed",
  };
  if (
    ip &&
    [
      "pending",
      "applying",
      "waiting",
      "dns_pending",
      "dns_failed",
      "failed",
      "conflict",
    ].includes(ip.state)
  ) {
    return {
      label: labels[ip.state],
      tone: ["dns_failed", "failed", "conflict"].includes(ip.state)
        ? "danger"
        : "info",
      active: ["pending", "applying", "waiting", "dns_pending"].includes(
        ip.state,
      ),
      error: ip.error,
    };
  }
  if (dns && ["pending", "deploying", "failed"].includes(dns.state)) {
    return {
      label: {
        pending: "DNS update queued",
        deploying: "Updating DNS",
        failed: "DNS update failed",
      }[dns.state],
      tone: dns.state === "failed" ? "danger" : "info",
      active: dns.state !== "failed",
      error: dns.error,
    };
  }
  if (dns?.state === "live")
    return { label: "DNS update completed", tone: "success", active: false };
  if (ip?.state === "completed")
    return { label: labels.completed, tone: "success", active: false };
  return null;
}

export function devicePresentation(device, lookups = {}) {
  const addresses = getDeviceIps(device).map((ip) => {
    const network = matchVlanForIp(ip, lookups.vlans || []);
    const range = matchReservedRangeForIp(
      ip,
      lookups.reservedRanges || lookups.virtualSubnets || [],
      network?.id,
    );
    return { ip, network, range };
  });
  const operation = operationPresentation(device);
  const networkBusy = Boolean(
    operation?.active ||
    device.unifi?.operation?.state === "dns_failed" ||
    ["pending", "deploying"].includes(device.dns?.operation?.state),
  );
  const groups = new Map();
  for (const record of device.sources || []) {
    if (!groups.has(record.source)) {
      const [name, idLabel] = sourceInfo[record.source] || [
        record.source,
        "Record ID",
      ];
      groups.set(record.source, {
        key: record.source,
        name,
        idLabel,
        records: [],
      });
    }
    groups.get(record.source).records.push(record);
  }
  // Integration failures can exist before a device has a linked source record.
  for (const key of ["unifi", "dns_platform"]) {
    const state = key === "unifi" ? device.unifi : device.dns;
    if (!state?.error && !groups.has(key)) continue;
    if (!groups.has(key))
      groups.set(key, {
        key,
        name: sourceInfo[key][0],
        idLabel: sourceInfo[key][1],
        records: [],
      });
    Object.assign(groups.get(key), {
      error: state?.error,
      checkedAt: key === "unifi" ? state?.checkedAt : state?.lastSync,
      url: key === "unifi" ? device.unifiUrl : null,
    });
  }
  const dnsState = device.dnsComparison?.state || "unknown";
  return {
    title: deviceTitle(device),
    health: healthPresentation(device),
    addresses,
    primary: addresses[0] || null,
    additional: addresses.slice(1),
    operation,
    networkBusy,
    ipv4: addresses
      .map((row) => row.ip)
      .filter((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)),
    groups: [...groups.values()],
    mode:
      {
        fixed: "Fixed reservation",
        static: "Static",
        automatic: "Automatic (DHCP)",
      }[device.unifi?.mode] || "Assignment unknown",
    dnsLabel:
      {
        matched: "DNS is up to date",
        mismatch: "DNS points to a different address",
        missing: "No DNS record",
        unknown: "DNS information unavailable",
        pending: "DNS is updating",
        failed: "DNS update failed",
      }[dnsState] || "DNS information unavailable",
    dnsState,
    aliases: [
      ...new Set(
        (device.dnsComparison?.records || []).flatMap(
          (record) => record.names || [],
        ),
      ),
    ].filter(
      (name) =>
        name.toLowerCase() !== String(device.hostname || "").toLowerCase(),
    ),
    canChangeAddress: Boolean(device.unifi?.editable) && !networkBusy,
    canChangeHostname: Boolean(device.dns?.configured) && !networkBusy,
  };
}

// Baselines belong to an editing session, never to the latest poll response.
export function sectionValues(device, section) {
  if (section === "name") return { displayName: device.displayName || "" };
  if (section === "mac") return { mac: device.mac || "" };
  if (section === "hostname")
    return {
      hostname: device.hostname || "",
      targetIp: hostIp(device.dns?.targetIp),
    };
  return {
    tags: [...new Set((device.tags || []).map((tag) => tag.name))],
    notes: device.notes || "",
    deviceType: device.classification?.typeOverride || '',
    role: device.classification?.roleOverride || '',
    keepCurrent: device.keepCurrent === true,
  };
}
export function sectionChanges(draft, baseline) {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key]),
    ),
  );
}
export function sectionPayload(section, draft, baseline, revision) {
  const changed = sectionChanges(draft, baseline);
  if (!Object.keys(changed).length) return null;
  if (section === "hostname")
    return {
      hostname: draft.hostname.trim(),
      dns: { targetIp: draft.targetIp, expectedRevision: revision },
    };
  if (Object.hasOwn(changed, "tags"))
    changed.tags = changed.tags.map((name) => ({ name }));
  if (Object.hasOwn(changed, "mac")) changed.mac = changed.mac || null;
  return changed;
}

export function acceptSectionSave(current, response, section) {
  // An inventory save can return an older persisted network snapshot than the
  // address picker just read. Only replace facts owned by that save.
  const keys =
    section === "name"
      ? ["displayName", "name", "updatedAt"]
      : section === "organization"
        ? ["tags", "notes", "updatedAt", "deviceType", "role", "classification", "keepCurrent", "lifecycle"]
        : null;
  return keys
    ? {
        ...current,
        ...Object.fromEntries(
          keys
            .filter((key) => key in response)
            .map((key) => [key, response[key]]),
        ),
      }
    : response;
}

export function friendlyError(error, fallback = "Unable to save. Try again.") {
  const message =
    error?.data?.statusMessage ||
    error?.statusMessage ||
    error?.message ||
    fallback;
  return message
    .replace(/DNS Platform/g, "DNS service")
    .replace(/UniFi/g, "network controller")
    .replace(/Uptime Kuma/g, "monitoring service");
}
