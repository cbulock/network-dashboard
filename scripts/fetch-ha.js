import "dotenv/config";
import pkg from "pg";
import axios from "axios";

const { Client } = pkg;
const db = new Client({ connectionString: process.env.DATABASE_URL });

async function fetchHomeAssistantData() {
    try {
        await db.connect();

        const res = await axios.get(`${process.env.HA_URL}/api/states`, {
            headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` },
        });

        const devices = res.data;

        for (const device of devices) {
            const entityId = device.entity_id;
            const friendlyName = device.attributes.friendly_name || "Unknown";
            const ip = device.attributes.ip && device.attributes.ip !== "Unknown" ? device.attributes.ip : null;
            const mac = device.attributes.mac && device.attributes.mac !== "Unknown" ? device.attributes.mac : null;
            const status = device.state;
            const attributes = JSON.stringify(device.attributes);

            await db.query(
                `INSERT INTO ha_data (entity_id, friendly_name, ip, mac, status, attributes, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (entity_id) DO UPDATE
         SET entity_id = EXCLUDED.entity_id, friendly_name = EXCLUDED.friendly_name, ip = EXCLUDED.ip, mac = EXCLUDED.mac, status = EXCLUDED.status, attributes = EXCLUDED.attributes, last_updated = NOW();`,
                [entityId, friendlyName, ip, mac, status, attributes]
            );
        }

        console.log("✅ Home Assistant data updated!");
    } catch (error) {
        console.error("❌ Home Assistant fetch error:", error.message);
    } finally {
        await db.end();
    }
}

fetchHomeAssistantData();
