import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {ensureDeviceSchema,getInventoryDeviceDetails,upsertDeviceFromSource,findExistingDevice} from '../scripts/device-registry.js';
import {syncUnifiRecords} from '../scripts/fetch-unifi.js';
import {importDnsSnapshot} from '../scripts/fetch-dns-platform.js';
import {enqueueIpChange,rebuildIpProjection} from '../scripts/unifi-platform.js';
import {processUnifiJobs} from '../scripts/unifi-jobs.js';
import {planIpRebuild} from '../scripts/rebuild-unifi-ips.js';

test('Postgres: authoritative IPs, durable operation conflicts, observed-address DNS movement, and idempotent rebuild', {skip:process.env.RUN_DB_TESTS!=='1'},async()=>{
 const connection=new pg.Client({connectionString:process.env.DATABASE_URL});await connection.connect();
 const db={query:(sql,values)=>connection.query(sql.replace(/CREATE TABLE /g,'CREATE TEMP TABLE '),values)};
 try {
  await connection.query('SET search_path TO pg_temp');await ensureDeviceSchema(db);
  const mac='00:11:22:33:44:55';
  const record={_id:'u',userId:'u',mac,kind:'client',ip:'10.0.0.10',network_id:'lan',use_fixedip:false,connected:true};
  const snapshot={site:process.env.UNIFI_SITE||'default',networks:[{_id:'lan',ip_subnet:'10.0.0.1/24',name:'LAN',dhcpd_enabled:true}],records:[{device:record,kind:'client'}],checkedAt:new Date().toISOString()};
  await syncUnifiRecords(db,null,{snapshot});
  const {rows:[row]}=await db.query('SELECT id FROM devices');
  await db.query("UPDATE devices SET notes='Keep notes',display_name='My server',primary_ip='10.0.0.99' WHERE id=$1",[row.id]);
  await db.query("INSERT INTO device_ip_assignments(device_id,ip) VALUES($1,'10.0.0.99')",[row.id]);
  await upsertDeviceFromSource(db,{source:'home_assistant',sourceId:'tracker',mac,ip:'10.0.0.88'});
  await upsertDeviceFromSource(db,{source:'uptime_kuma',sourceId:'server',mac,ip:'10.0.0.77',status:'up'});
  await importDnsSnapshot(db,{zone:'bulock',revision:'a'.repeat(64),records:[{type:'A',value:'10.0.0.10',names:['server','files']}]});
  let device=await getInventoryDeviceDetails(db,row.id);
  assert.deepEqual(device.allIps,['10.0.0.10']);assert.deepEqual(device.assignedIps,[]);assert.equal(device.status,'up');assert.equal(device.dnsComparison.state,'matched');
  assert.equal(await findExistingDevice(db,{ips:['10.0.0.99']}),null);
  assert.equal(await findExistingDevice(db,{ips:['10.0.0.88']}),null);
  const id=await enqueueIpChange(db,device,snapshot,{expectedRevision:device.unifi.revision,mode:'fixed',ip:'10.0.0.30'});
  await assert.rejects(enqueueIpChange(db,device,snapshot,{expectedRevision:device.unifi.revision,mode:'fixed',ip:'10.0.0.31'}),error=>error.code==='23505');
  record.use_fixedip=true;record.fixed_ip='10.0.0.30';record.ip='10.0.0.30';
  const refresh=async()=>{await syncUnifiRecords(db,null,{snapshot});return snapshot;};
  await processUnifiJobs(db,{connect:async()=>({}),refresh,fetchDns:async()=>{},request:async()=>({revision:'a'.repeat(64),capabilities:['hostname.move']}),write:async()=>{throw new Error('Already applied; must not replay.');}});
  const {rows:[job]}=await db.query('SELECT * FROM unifi_ip_jobs WHERE id=$1',[id]);assert.equal(job.state,'dns_pending');
  const {rows:[dns]}=await db.query('SELECT * FROM dns_platform_jobs WHERE id=$1',[job.dns_job_id]);assert.equal(dns.hostname,'server');assert.equal(dns.move_from,'10.0.0.10');assert.equal(dns.ip,'10.0.0.30');
  device=await getInventoryDeviceDetails(db,row.id);assert.equal(device.hostname,'server');assert.deepEqual(device.allIps,['10.0.0.30']);assert.equal(device.dnsComparison.state,'pending');assert.equal(device.dnsComparison.records[0].ip,'10.0.0.10');
  assert.equal(device.notes,'Keep notes');assert.equal(device.displayName,'My server');
  await rebuildIpProjection(db);assert.deepEqual(await planIpRebuild(db),[]);
  await db.query("UPDATE dns_platform_jobs SET state='failed',error='Resolver unavailable' WHERE id=$1",[dns.id]);
  await processUnifiJobs(db,{connect:async()=>({}),refresh});
  assert.equal((await db.query('SELECT state FROM unifi_ip_jobs WHERE id=$1',[id])).rows[0].state,'dns_failed');
  assert.deepEqual((await getInventoryDeviceDetails(db,row.id)).allIps,['10.0.0.30']);
 } finally {await connection.end();}
});
