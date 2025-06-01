import "dotenv/config";
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import pkg from "pg";

const controllerHost = process.env.UNIFI_HOST;
const username = process.env.UNIFI_USER;
const password = process.env.UNIFI_PASS;
const site = 'default';

const { Client } = pkg;
const db = new Client({ connectionString: process.env.DATABASE_URL });

const jar = new CookieJar();
const client = wrapper(axios.create({
    baseURL: controllerHost,
    jar,
    withCredentials: true,
}));

async function fetchUnifiData() {
    try {
        // 🔌 Connect to the database
        await db.connect();

        // 🔐 Login
        await client.post('/api/auth/login', {
            username,
            password,
        });

        // 📡 Get clients
        const res = await client.get(`/proxy/network/api/s/${site}/stat/sta`);
        const clients = res.data.data;

        for (const client of clients) {
            const unifiId = client._id || null;
            const mac = client.mac || null;
            const hostname = client.hostname || client.name || "Unknown";
            const ip = client.ip || null;

            console.log(`Processing client: ${hostname} (${mac}) - IP: ${ip}`);

            await db.query(
                `INSERT INTO unifi_data (unifi_id, mac, hostname, ip, raw)
                 VALUES ($1, $2::macaddr, $3, $4::inet, $5)
                 ON CONFLICT (unifi_id) DO UPDATE
                 SET mac = EXCLUDED.mac, hostname = EXCLUDED.hostname, ip = EXCLUDED.ip, raw = EXCLUDED.raw;`,
                [unifiId, mac, hostname, ip, client]
            );
        }
    } catch (err) {
        console.error('Error:', err.response?.data || err.message);
    } finally {
        // 🔌 Disconnect when done
        await db.end();
    }
}

fetchUnifiData();
