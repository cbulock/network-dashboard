import { defineEventHandler, getQuery } from "h3";
import { listInventoryDevices } from "~/scripts/device-registry.js";
import { withInventoryDb } from "~/server/utils/inventory-db.js";

export default defineEventHandler(async (event) => {
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
});
