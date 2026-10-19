import { defineEventHandler, readBody } from 'h3';
import { withInventoryDb } from '~/server/utils/inventory-db.js';
import { previewDeviceMerge, applyDeviceMerge } from '~/scripts/merge-devices.js';

export default defineEventHandler(async event => {
  const targetId = Number(event.context.params.id);
  const body = await readBody(event) || {};
  return withInventoryDb(async db => {
    await db.query('BEGIN');
    try {
      if (body.apply === true) {
        const result = await applyDeviceMerge(db, targetId, Number(body.otherId), body.revision);
        await db.query('COMMIT');
        return result;
      }
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const { snapshot, ...preview } = await previewDeviceMerge(db, targetId, Number(body.otherId));
      await db.query('ROLLBACK');
      return { ...preview, sources: snapshot.device_sources.map(s => ({ source: s.source, sourceId: s.source_id })),
        tags: [...new Set(snapshot.device_tag_assignments.map(t => t.tag_id))].length,
        addresses: snapshot.device_ip_assignments.length };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
});
