// kuma-metrics-to-pg.js
import 'dotenv/config';
import axios from 'axios';
import pkg from 'pg';

const uptimeKumaURL = process.env.UK_URL;
const apiKey = process.env.UK_API_KEY;

const { Client } = pkg;
const db = new Client({ connectionString: process.env.DATABASE_URL });

function parsePrometheusMetrics(raw) {
    const lines = raw.split('\n');
    const metrics = [];

    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') continue;

        const [metricWithLabels, valueStr] = line.split(/ (?![^{}]*})/); // smarter split
        const value = parseFloat(valueStr);

        const [metric, rawLabels] = metricWithLabels.split('{');
        const labels = {};

        if (rawLabels) {
            rawLabels
                .replace(/}$/, '')
                .split(',')
                .forEach(pair => {
                    const [k, v] = pair.split('=');
                    labels[k] = v.replace(/"/g, '');
                });
        }

        metrics.push({ metric, labels, value });
    }

    return metrics;
}

function aggregateByHostname(metrics) {
    const result = {};

    for (const { metric, labels, value } of metrics) {
        const hostname = labels.monitor_hostname || 'unknown';
        const service = labels.monitor_name || 'unknown';
        const url = labels.monitor_url || '';
        const type = labels.monitor_type || 'unknown';

        if (!result[hostname]) {
            result[hostname] = {
                hostname,
                status: null,
                response_time: null,
                cert_valid: null,
                cert_days_remaining: null,
                services: {} // now tracking individual services
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

        if (metric === 'monitor_status') {
            host.status = Math.max(host.status ?? -1, value); // keep worst-case at host level
            svc.status = value;
        }

        if (metric === 'monitor_response_time') {
            host.response_time = Math.max(host.response_time ?? 0, value);
            svc.response_time = value;
        }

        if (metric === 'monitor_cert_is_valid') {
            svc.cert_valid = value;
            host.cert_valid = (host.cert_valid === false || value === 0) ? false : true;
        }

        if (metric === 'monitor_cert_days_remaining') {
            svc.cert_days_remaining = value;
            host.cert_days_remaining = Math.min(host.cert_days_remaining ?? Infinity, value);
        }
    }

    // Convert service maps to arrays
    return Object.values(result).map(host => ({
        ...host,
        services: Object.values(host.services),
    }));
}


async function insertIntoPostgres(data) {
    await db.connect();

    const table = 'uptime_kuma_data';

    for (const row of data) {
        await db.query(
            `
      INSERT INTO ${table} (hostname, status, raw)
      VALUES ($1, $2, $3)
      ON CONFLICT (hostname) DO UPDATE SET
        status = EXCLUDED.status,
        raw = EXCLUDED.raw;
      `,
            [
                row.hostname,
                row.status,
                row,
            ]
        );
    }

    await db.end();
    console.log('✅ Data inserted into Postgres');
}

async function run() {
    try {
        const response = await axios.get(`${uptimeKumaURL}/metrics`, {
            auth: {
                username: '', // blank username
                password: apiKey,
            },
        });

        const metrics = parsePrometheusMetrics(response.data);
        const aggregated = aggregateByHostname(metrics);
        await insertIntoPostgres(aggregated);
    } catch (err) {
        console.error('❌ Error:', err.response?.data || err.message);
        process.exit(1);
    }
}

run();
