import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, defineEventHandler, toNodeListener } from 'h3';
import guard from '../server/middleware/inventory-write-origin.js';

test('inventory writes reject browser cross-origin and form posts but accept same-origin JSON', async()=>{
  const app=createApp().use(guard).use(defineEventHandler(()=>({ok:true})));
  const server=createServer(toNodeListener(app)); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const url=origin+'/api/inventory/devices/1';
  try {
    assert.equal((await fetch(url,{method:'PATCH',headers:{'content-type':'application/json',origin:'https://other.example'},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await fetch(url,{method:'PATCH',headers:{'content-type':'application/json',origin},body:'{}'})).status,200);
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
    assert.equal((await fetch(url)).status,200);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
