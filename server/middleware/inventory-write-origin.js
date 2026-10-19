import { createError, defineEventHandler, getHeader, getRequestURL } from 'h3';

// Inventory hostname writes now reach DNS infrastructure. Reject browser
// cross-origin writes; originless JSON requests still support local collectors.
export default defineEventHandler(event => {
  if (!['POST','PATCH','PUT','DELETE'].includes(event.method) ||
      !(event.path.startsWith('/api/inventory/') || event.path === '/api/devices')) return;
  const origin = getHeader(event,'origin');
  if (getHeader(event,'sec-fetch-site') === 'cross-site' || (origin && origin !== getRequestURL(event).origin)) {
    throw createError({statusCode:403,statusMessage:'Inventory changes must come from this dashboard.'});
  }
  if (!getHeader(event,'content-type')?.toLowerCase().startsWith('application/json')) {
    throw createError({statusCode:415,statusMessage:'Inventory updates require application/json.'});
  }
});
