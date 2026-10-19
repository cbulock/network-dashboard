// Liveness only: upstream outages must not make the HTTP process unhealthy.
export default defineEventHandler(() => ({ status: 'ok' }));
