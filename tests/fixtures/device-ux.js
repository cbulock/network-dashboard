export const lookups = {
  tags: [
    { id: 1, name: "home" },
    { id: 2, name: "infrastructure" },
  ],
  vlans: [{ id: 1, vlanId: 10, name: "Management", subnet: "10.0.0.0/24" }],
  reservedRanges: [
    {
      id: 1,
      name: "Switches",
      startIp: "10.0.0.30",
      endIp: "10.0.0.39",
      compatible: true,
    },
  ],
};
export function deviceFixture(scenario = "normal") {
  const device = {
    id: 999999,
    name: "Garage switch",
    displayName: "Garage switch",
    hostname: "garage.switch",
    deviceKey: "unifi:fixture",
    mac: "00:11:22:33:44:55",
    primaryIp: "10.0.0.32",
    allIps: ["10.0.0.32", "10.0.0.33", "2001:db8::1234"],
    status: "up",
    notes: "Connects the workshop and garage.",
    tags: [{ id: 1, name: "home" }],
    unifi: {
      mode: "static",
      kind: "managed_device",
      editable: true,
      connected: true,
      configuredIp: "10.0.0.32",
      revision: "network-1",
      lastSeen: "2026-10-18T17:31:00Z",
      network: { name: "Management", ip_subnet: "10.0.0.0/24" },
    },
    dns: {
      configured: true,
      moveSupported: true,
      revision: "dns-1",
      targetIp: "10.0.0.32",
      lastSync: "2026-10-18T17:32:00Z",
    },
    dnsComparison: {
      state: "matched",
      records: [
        { ip: "10.0.0.32", names: ["garage.switch", "workshop.switch"] },
      ],
      mismatches: [],
    },
    sources: [
      {
        source: "unifi",
        sourceId: "fixture-switch",
        lastSeen: "2026-10-18T17:31:00Z",
        linkMethod: "network_identity",
      },
      { source: "dns_platform", sourceId: "A:10.0.0.32" },
      { source: "uptime_kuma", sourceId: "garage.switch", status: "up" },
    ],
  };
  if (scenario === "empty")
    Object.assign(device, {
      displayName: "",
      name: "Unconfigured device",
      hostname: "",
      primaryIp: null,
      allIps: [],
      mac: "",
      notes: "",
      tags: [],
      sources: [],
      dns: { configured: false },
      dnsComparison: { state: "unknown" },
      unifi: { mode: "unknown", editable: false },
    });
  if (scenario === "long")
    Object.assign(device, {
      displayName:
        "Workshop and garage infrastructure switch with a very long friendly name",
      hostname:
        "this-is-a-long-hostname-for-responsive-testing.management.example.home",
      sources: [
        ...device.sources,
        ...Array.from({ length: 35 }, (_, i) => ({
          source: "home_assistant",
          sourceId: `sensor.workshop_network_interface_${i}`,
          name: `Workshop network sensor ${i}`,
        })),
      ],
    });
  if (scenario === "failed" || scenario === "mismatch") {
    device.dnsComparison = {
      state: scenario === "failed" ? "failed" : "mismatch",
      hasMismatch: true,
      records: [{ ip: "10.0.0.31", names: ["garage.switch"] }],
      mismatches: [{ ip: "10.0.0.31" }],
    };
    if (scenario === "failed") {
      device.unifi.operation = {
        state: "dns_failed",
        error: "DNS Platform unavailable",
      };
      device.dns.operation = {
        id: "dns-job",
        state: "failed",
        updatedAt: "before",
        error: "Unavailable",
      };
    }
  }
  return device;
}
