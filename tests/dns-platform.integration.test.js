import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {ensureDeviceSchema,getInventoryDeviceDetails,findExistingDevice,updateInventoryDevice} from '../scripts/device-registry.js';
import {importDnsSnapshot} from '../scripts/fetch-dns-platform.js';
import {upsertDeviceFromSource} from '../scripts/device-registry.js';
import {queueDnsChange} from '../scripts/dns-platform.js';

test('Postgres: DNS discovery, precedence, ambiguity, removals, and transactional outbox', {skip:process.env.RUN_DB_TESTS!=='1'}, async()=>{
  const client=new pg.Client({connectionString:process.env.DATABASE_URL}); await client.connect();
  const db={query:(sql,values)=>client.query(sql.replace(/CREATE TABLE /g,'CREATE TEMP TABLE '),values)};
  const previous=process.env.DNS_PLATFORM_SSH_TARGET;
  process.env.DNS_PLATFORM_SSH_TARGET='dns-platform@test';
  try {
    await client.query('SET search_path TO pg_temp'); await ensureDeviceSchema(db);
    await client.query(`INSERT INTO devices(device_key,name,hostname,display_name,ips) VALUES
      ('server','Server','old-local','My server',ARRAY['192.0.2.2']::inet[]),
      ('manual','Manual',NULL,NULL,'{}');
      INSERT INTO device_ip_assignments(device_id,ip) VALUES(2,'192.0.2.10');
      INSERT INTO device_sources(source,source_id,device_id,status) VALUES('uptime_kuma','server',1,'down');`);
    const snapshot={zone:'bulock',revision:'a'.repeat(64),records:[
      {type:'A',value:'192.0.2.2',names:['files','old']},{type:'A',value:'192.0.2.10',names:['manual']},
      {type:'A',value:'192.0.2.20',names:['dns-only']},{type:'A',value:'127.0.0.1',names:['localhost']}]};
    await db.query(`INSERT INTO device_sources(source,source_id,device_id,raw_data) VALUES('unifi','server-u',1,'{"kind":"client","ip":"192.0.2.2","identity":{"ips":["192.0.2.2"]}}')`);
    // Attach by source id explicitly: a stale legacy array alone is not identity evidence.
    await db.query("UPDATE device_sources SET device_id=1 WHERE source='unifi' AND source_id='server-u'");
    await importDnsSnapshot(db,snapshot);
    let device=await getInventoryDeviceDetails(db,1);
    assert.equal(device.hostname,'files'); assert.equal(device.name,'My server'); assert.equal(device.status,'down');
    assert.equal((await getInventoryDeviceDetails(db,2)).hostname,null);
    assert.deepEqual((await getInventoryDeviceDetails(db,2)).allIps,[]);
    const dnsOnly=await findExistingDevice(db,{ips:['192.0.2.20']}); assert.equal(dnsOnly,null);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM devices')).rows[0].n,2);
    await importDnsSnapshot(db,snapshot);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM devices')).rows[0].n,2);
    await updateInventoryDevice(db,1,{hostname:'renamed',notes:'keep',dns:{targetIp:'192.0.2.2',expectedRevision:snapshot.revision}});
    device=await getInventoryDeviceDetails(db,1);
    assert.equal(device.hostname,'files'); assert.equal(device.notes,'keep'); assert.equal(device.dns.operation.state,'pending');
    await assert.rejects(()=>updateInventoryDevice(db,1,{hostname:'bad',notes:'rollback',dns:{targetIp:'192.0.2.2',expectedRevision:'stale'}}),/changed/);
    assert.equal((await getInventoryDeviceDetails(db,1)).notes,'keep');
    await client.query("INSERT INTO device_ip_assignments(device_id,ip) VALUES(2,'192.0.2.2')");
    await importDnsSnapshot(db,snapshot);
    assert.equal((await getInventoryDeviceDetails(db,1)).hostname,'files');
    assert.equal((await client.query("SELECT device_id FROM device_sources WHERE source='dns_platform' AND source_id='A:192.0.2.2'")).rows[0].device_id,1);
    await client.query("UPDATE device_sources SET device_id=1,link_method='manual' WHERE source='dns_platform' AND source_id='A:192.0.2.2'");
    await importDnsSnapshot(db,snapshot); assert.equal((await getInventoryDeviceDetails(db,1)).hostname,'files');
    await assert.rejects(()=>importDnsSnapshot(db,{...snapshot,records:[{type:'AAAA',value:'::1',names:['bad']}]}));
    assert.equal((await getInventoryDeviceDetails(db,1)).hostname,'files');
    await importDnsSnapshot(db,{...snapshot,revision:'b'.repeat(64),records:snapshot.records.filter(r=>r.value!=='192.0.2.20')});
    assert.equal(await findExistingDevice(db,{ips:['192.0.2.20']}),null);
    await db.query(`UPDATE device_sources SET raw_data=' {"kind":"client","ip":"192.0.2.3","identity":{"ips":["192.0.2.3"]}}' WHERE source='unifi'`);
    device=await getInventoryDeviceDetails(db,1); assert.equal(device.hostname,'files');assert.equal(device.dnsComparison.records[0].ip,'192.0.2.2');assert.deepEqual(device.allIps,['192.0.2.3']);
  } finally { if(previous===undefined) delete process.env.DNS_PLATFORM_SSH_TARGET; else process.env.DNS_PLATFORM_SSH_TARGET=previous; await client.end(); }
});
