import "dotenv/config";
import axios from "axios";
import { pathToFileURL } from "node:url";
import { snapshotColumns, storeKumaSnapshot } from "./source-snapshots.js";
import {
  ensureDeviceSchema,
  getDbClient,
  upsertDeviceFromSource,
} from "./device-registry.js";

const metricsUrl =
  process.env.KUMA_METRICS_URL ||
  (process.env.UK_URL ? `${process.env.UK_URL}/metrics` : null);
const apiKey =
  process.env.KUMA_API_KEY || process.env.UK_API_KEY || process.env.UK_PASS;

export function parsePrometheusMetrics(raw) {
  const lines = raw.split("\n");
  const metrics = [];

  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") continue;

    const [metricWithLabels, valueStr] = line.split(/ (?![^{}]*})/);
    const value = parseFloat(valueStr);

    const [metric, rawLabels] = metricWithLabels.split("{");
    const labels = {};

    if (rawLabels) {
      rawLabels
        .replace(/}$/, "")
        .split(",")
        .forEach((pair) => {
          const [k, v] = pair.split("=");
          labels[k] = v.replace(/"/g, "");
        });
    }

    metrics.push({ metric, labels, value });
  }

  return metrics;
}

export function aggregateByHostname(metrics) {
  const result = {};

  for (const { metric, labels, value } of metrics) {
    // Exporter/process metrics aren't device monitors. Placeholder hostnames
    // must never become identities (or match a UniFi hostname of "unknown").
    if (!["monitor_status", "monitor_response_time", "monitor_cert_is_valid", "monitor_cert_days_remaining"].includes(metric)) continue;
    const hostname = labels.monitor_hostname?.trim();
    if (!hostname || ["null", "unknown", "undefined"].includes(hostname.toLowerCase())) continue;
    const service = labels.monitor_name || "unknown";
    const url = labels.monitor_url || "";
    const type = labels.monitor_type || "unknown";

    if (!result[hostname]) {
      result[hostname] = {
        hostname,
        status: null,
        response_time: null,
        cert_valid: null,
        cert_days_remaining: null,
        services: {},
      };
    }

    const host = result[hostname];

    if (!host.services[service]) {
      host.services[service] = {
        name: service,
        type,
        url,
        status: null,
        response_time: null,
        cert_valid: null,
        cert_days_remaining: null,
      };
    }

    const svc = host.services[service];

    if (metric === "monitor_status") {
      host.status = Math.max(host.status ?? -1, value);
      svc.status = value;
    }

    if (metric === "monitor_response_time") {
      host.response_time = Math.max(host.response_time ?? 0, value);
      svc.response_time = value;
    }

    if (metric === "monitor_cert_is_valid") {
      svc.cert_valid = value;
      host.cert_valid = host.cert_valid === false || value === 0 ? false : true;
    }

    if (metric === "monitor_cert_days_remaining") {
      svc.cert_days_remaining = value;
      host.cert_days_remaining = Math.min(
        host.cert_days_remaining ?? Infinity,
        value
      );
    }
  }

  return Object.values(result).map((host) => ({
    ...host,
    services: Object.values(host.services),
  }));
}

async function fetchAndStore() {
  if (!metricsUrl) {
    throw new Error("KUMA_METRICS_URL or UK_URL must be set");
  }

  const db = await getDbClient();

  try {
    await ensureDeviceSchema(db);
    const response = await axios.get(metricsUrl, {
      auth: {
        username: "",
        password: apiKey,
      },
    });

    const metrics = parsePrometheusMetrics(response.data);
    const aggregated = aggregateByHostname(metrics);
    const columns = await snapshotColumns(db, "uptime_kuma_data");

    for (const host of aggregated) {
      const status = host.status === 1 ? "up" : host.status === 0 ? "down" : "unknown";

      await db.query("BEGIN");
      try {
        const { deviceKey } = await upsertDeviceFromSource(db, {
          source: "uptime_kuma",
          sourceId: host.hostname,
          name: host.hostname,
          status,
          rawData: host,
        });

        await storeKumaSnapshot(db, columns, deviceKey, host, status);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }

    console.log(`✓ Uptime Kuma data synced for ${aggregated.length} hosts`);
  } catch (error) {
    console.error("✗ Uptime Kuma fetch error:", error.response?.data || error.message);
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchAndStore().catch(() => { process.exitCode = 1; });
}
