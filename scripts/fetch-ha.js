import "dotenv/config";
import axios from "axios";
import {
  ensureDeviceSchema,
  getDbClient,
  upsertDeviceFromSource,
} from "./device-registry.js";
import { homeAssistantIdentity } from "./source-identity.js";
import { snapshotColumns, storeHomeAssistantSnapshot } from "./source-snapshots.js";

async function fetchHomeAssistantData() {
  const db = await getDbClient();
  try {
    await ensureDeviceSchema(db);
    const columns = await snapshotColumns(db, "ha_data");

    const res = await axios.get(`${process.env.HA_URL}/api/states`, {
      headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` },
    });

    const devices = res.data;

    for (const device of devices) {
      const entityId = device.entity_id;
      const friendlyName = device.attributes.friendly_name || entityId;
      const { ips, mac } = homeAssistantIdentity(device);
      const ip = ips[0] ?? null;
      const status = device.state;
      const attributes = device.attributes;
      const lastUpdated = device.last_updated || device.last_changed || new Date();

      await storeHomeAssistantSnapshot(db, columns, { entityId, friendlyName, ip, mac, status, attributes, lastUpdated });

      await upsertDeviceFromSource(db, {
        source: "home_assistant",
        sourceId: entityId,
        mac,
        ips,
        name: friendlyName,
        status,
        lastSeen: lastUpdated,
        details: {
          entity_id: entityId,
          attributes,
        },
      });
    }

    console.log("✓ Home Assistant data updated");
  } catch (error) {
    console.error("✗ Home Assistant fetch error:", error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

fetchHomeAssistantData();
