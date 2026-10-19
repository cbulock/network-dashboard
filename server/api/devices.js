import { createError, defineEventHandler, getQuery, readBody } from "h3";
import { listInventoryDevices } from "~/scripts/device-registry.js";
import { withInventoryDb } from "~/server/utils/inventory-db.js";

export default defineEventHandler(async (event) => {
  if (event.method === "GET") {
    const query = getQuery(event);
    const tags = Array.isArray(query.tag)
      ? query.tag
      : query.tag
        ? [query.tag]
        : [];

    return withInventoryDb(async (db) => {
      const devices = await listInventoryDevices(db, {
        search: query.search,
        sortBy: query.sortBy,
        sortDir: query.sortDir,
        tags,
        vlanId: query.vlanId,
      });

      return { devices };
    });
  }

  if (event.method === "POST") {
    const body = await readBody(event);
    const targetDeviceKey = body?.targetDeviceKey;
    const mappings = Array.isArray(body?.mappings) ? body.mappings : [];

    if (!targetDeviceKey || !mappings.length) {
      throw createError({
        statusCode: 400,
        statusMessage: "targetDeviceKey and mappings are required",
      });
    }

    return withInventoryDb(async (db) => {
      const targetRes = await db.query(
        "SELECT id FROM devices WHERE device_key = $1 LIMIT 1",
        [targetDeviceKey]
      );
      const target = targetRes.rows[0];

      if (!target) {
        throw createError({
          statusCode: 404,
          statusMessage: "Target device not found",
        });
      }

      for (const mapping of mappings) {
        const source = mapping?.source ? String(mapping.source) : null;
        const sourceId = mapping?.sourceId ? String(mapping.sourceId) : null;

        if (!source || !sourceId) {
          continue;
        }

        await db.query(
          `
            UPDATE device_sources
            SET device_id = $1, link_method = 'manual', mapped_device_key = $4
            WHERE source = $2 AND source_id = $3
          `,
          [target.id, source, sourceId, targetDeviceKey]
        );
      }

      return { ok: true };
    });
  }

  throw createError({
    statusCode: 405,
    statusMessage: "Method not allowed",
  });
});
