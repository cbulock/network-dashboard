import assert from "node:assert/strict";
import test from "node:test";
import {
  devicePresentation,
  healthPresentation,
  operationPresentation,
  sectionValues,
  sectionChanges,
  sectionPayload,
  acceptSectionSave,
} from "../utils/device-presentation.js";
import { deviceFixture, lookups } from "./fixtures/device-ux.js";

test("representative devices keep diagnostics separate from health and editable network values", () => {
  for (const scenario of ["normal", "empty", "long", "failed", "mismatch"]) {
    const device = deviceFixture(scenario);
    const view = devicePresentation(device, lookups);
    assert.ok(view.title);
    assert.equal(
      new Set(view.addresses.map((row) => row.ip)).size,
      view.addresses.length,
    );
    assert.equal(
      view.health.label,
      scenario === "empty" ? "Not monitored" : "Healthy",
    );
    if (scenario === "empty") assert.equal(view.canChangeAddress, false);
    if (scenario === "failed")
      assert.equal(
        view.operation.label,
        "Address applied. DNS needs attention",
      );
    if (scenario === "long")
      assert.equal(
        view.groups.find((group) => group.key === "home_assistant").records
          .length,
        35,
      );
  }
});

test("health distinguishes missing monitoring from unknown readings and ignores connection status", () => {
  assert.equal(
    healthPresentation({ status: "up", sources: [{ source: "unifi" }] }).label,
    "Not monitored",
  );
  for (const [status, label] of [
    ["up", "Healthy"],
    ["down", "Failing"],
    ["unknown", "Unknown"],
  ])
    assert.equal(
      healthPresentation({
        status,
        unifi: { connected: true },
        sources: [{ source: "uptime_kuma" }],
      }).label,
      label,
    );
});
test("addresses deduplicate host masks and IPv6 variants and retain network/range context", () => {
  const view = devicePresentation(
    {
      primaryIp: "10.0.0.2/32",
      allIps: ["10.0.0.2", "2001:db8::1", "2001:0db8:0:0:0:0:0:1"],
      hostname: "switch",
      dns: { configured: true },
      unifi: { editable: true },
    },
    {
      vlans: [{ id: 1, vlanId: 10, name: "LAN", subnet: "10.0.0.0/24" }],
      reservedRanges: [
        { id: 2, name: "Switches", startIp: "10.0.0.2", endIp: "10.0.0.10" },
      ],
    },
  );
  assert.equal(view.primary.ip, "10.0.0.2");
  assert.equal(view.additional.length, 1);
  assert.equal(view.primary.network.name, "LAN");
  assert.equal(view.primary.range.name, "Switches");
  assert.deepEqual(view.ipv4, ["10.0.0.2"]);
  assert.equal(view.title, "switch");
});
test("IP progress takes precedence over related DNS errors; partial failure is explicit and blocks new edits", () => {
  const device = {
    unifi: { editable: true, operation: { state: "waiting" } },
    dns: { configured: true, operation: { state: "live" } },
  };
  assert.match(operationPresentation(device).label, /Waiting/);
  assert.equal(devicePresentation(device).canChangeHostname, false);
  device.unifi.operation.state = "dns_failed";
  assert.equal(
    operationPresentation(device).label,
    "Address applied. DNS needs attention",
  );
  assert.equal(devicePresentation(device).canChangeAddress, false);
  device.unifi.operation.state = "completed";
  assert.equal(devicePresentation(device).canChangeHostname, true);
});
test("missing addresses, unavailable DNS, and diagnostic-only sources do not become mismatches", () => {
  const view = devicePresentation({
    dns: { error: "unavailable" },
    unifi: { error: "offline" },
  });
  assert.equal(view.primary, null);
  assert.equal(view.dnsState, "unknown");
  assert.equal(view.groups.length, 2);
  assert.equal(view.canChangeHostname, false);
});
test("draft baselines survive replacement of confirmed state; saves send only changed section fields", () => {
  let device = {
    displayName: "Server",
    hostname: "server",
    notes: "Old note",
    tags: [{ name: "home" }],
    dns: { targetIp: "10.0.0.2", revision: "r1" },
  };
  const baseline = sectionValues(device, "organization");
  const draft = structuredClone(baseline);
  draft.notes = "Unsaved note";
  device = {
    ...device,
    displayName: "New label",
    notes: "Updated remotely",
    tags: [{ name: "other" }],
  };
  assert.equal(draft.notes, "Unsaved note");
  assert.deepEqual(sectionPayload("organization", draft, baseline), {
    notes: "Unsaved note",
  });
  assert.equal(
    sectionPayload(
      "name",
      sectionValues(device, "name"),
      sectionValues(device, "name"),
    ),
    null,
  );
  assert.deepEqual(sectionChanges(baseline, baseline), {});
});
test("hostname requests use the editing-session revision and selected target, without unrelated fields", () => {
  const baseline = { hostname: "old", targetIp: "10.0.0.2" };
  assert.deepEqual(
    sectionPayload(
      "hostname",
      { ...baseline, hostname: " new " },
      baseline,
      "r1",
    ),
    {
      hostname: "new",
      dns: { targetIp: "10.0.0.2", expectedRevision: "r1" },
    },
  );
  assert.deepEqual(
    sectionPayload(
      "organization",
      { tags: ["a"], notes: "" },
      { tags: [], notes: "" },
    ),
    { tags: [{ name: "a" }] },
  );
  assert.deepEqual(
    sectionPayload("mac", { mac: "" }, { mac: "00:11:22:33:44:55" }),
    { mac: null },
  );
});

test("saving metadata cannot regress fresher address-picker evidence", () => {
  const current = {
    displayName: "Before",
    notes: "Old",
    primaryIp: "10.0.0.35",
    unifi: { revision: "fresh" },
  };
  const response = {
    ...current,
    displayName: "After",
    primaryIp: "10.0.0.32",
    unifi: { revision: "old" },
  };
  const saved = acceptSectionSave(current, response, "name");
  assert.equal(saved.displayName, "After");
  assert.equal(saved.primaryIp, "10.0.0.35");
  assert.equal(saved.unifi.revision, "fresh");
});
