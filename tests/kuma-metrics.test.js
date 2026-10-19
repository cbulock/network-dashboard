import test from "node:test";
import assert from "node:assert/strict";
import { parsePrometheusMetrics, aggregateByHostname } from "../scripts/fetch-uptime-kuma.js";

test("exporter metrics and placeholder hosts cannot create device health sources", () => {
  const metrics = parsePrometheusMetrics([
    'process_cpu_seconds_total 5',
    'monitor_status{monitor_hostname="null",monitor_name="nas6",monitor_type="group"} 1',
    'monitor_status{monitor_hostname="unknown",monitor_name="placeholder"} 1',
    'monitor_status{monitor_name="no host",instance="exporter"} 1',
    'monitor_uptime_ratio{monitor_hostname="unused",monitor_name="history"} 1',
    'monitor_status{monitor_hostname="nas6",monitor_name="ssh",monitor_type="port"} 1',
    'monitor_response_time{monitor_hostname="nas6",monitor_name="ssh",monitor_type="port"} 2',
  ].join('\n'));
  const hosts = aggregateByHostname(metrics);
  assert.deepEqual(hosts.map(host => host.hostname), ['nas6']);
  assert.equal(hosts[0].status, 1);
  assert.equal(hosts[0].services[0].response_time, 2);
});
