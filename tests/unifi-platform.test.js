import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentFor, availableAddresses, desiredSettings, readInventory, safeRecord, dnsComparison, settingsRevision, writeSettings, enqueueIpChange } from '../scripts/unifi-platform.js';
import { queueDnsMove, processUnifiJobs } from '../scripts/unifi-jobs.js';

const network={_id:'lan',name:'LAN',ip_subnet:'10.0.0.1/24',dhcpd_enabled:true};
const mac='00:11:22:33:44:55';
const client={_id:'u',userId:'u',kind:'client',mac,ip:'10.0.0.10',network_id:'lan',use_fixedip:false,connected:true};
const snapshot={site:'default',networks:[network],records:[{device:client,kind:'client'}],checkedAt:'2026-10-18T12:00:00Z'};
const assignment=()=>assignmentFor(client,[network]);

test('inventory merges offline reservations with connected clients without importing controller secrets',async()=>{
 const http={async get(path){return {data:{meta:{rc:'ok'},data:path.endsWith('/sta')?[{...client,_id:'sta',password:'secret'}]:path.endsWith('/user')?[{...client,_id:'user',use_fixedip:true,fixed_ip:'10.0.0.20'},{_id:'offline',mac:'aa:bb:cc:dd:ee:ff',last_ip:'10.0.0.30',fixed_ip:'10.0.0.40',use_fixedip:true}]:path.endsWith('/networkconf')?[{...network,x_ipsec_pre_shared_key:'secret'}]:[]}};}};
 const result=await readInventory(http);
 assert.equal(result.records.length,2);assert.equal(result.records[0].device.userId,'user');
 assert.equal(result.records[1].device.connected,false);assert.equal(result.records[1].device.ip,'10.0.0.30');
 assert.ok(!JSON.stringify(result).includes('secret'));
});

test('assignment distinguishes automatic, fixed, static, unknown, and unsupported hardware',()=>{
 assert.equal(assignment().mode,'automatic');
 assert.equal(assignmentFor({...client,use_fixedip:true,fixed_ip:'10.0.0.20'},[network]).configuredIp,'10.0.0.20');
 const hardware={...client,kind:'managed_device',type:'usw',adopted:true,config_network:{type:'static',ip:'10.0.0.11',gateway:'10.0.0.1',dns1:'10.0.0.2'}};
 assert.equal(assignmentFor(hardware,[network]).mode,'static');assert.equal(assignmentFor(hardware,[network]).editable,true);
 assert.equal(assignmentFor({...hardware,type:'udm'},[network]).editable,false);
 assert.equal(assignmentFor({...client,use_fixedip:undefined},[network]).mode,'unknown');
 assert.equal(assignmentFor(null).editable,false);
 assert.deepEqual(safeRecord({config_network:{type:'static',password:'secret'}},'managed_device').config_network,{type:'static'});
});

test('availability excludes offline reservations, current addresses, infrastructure, and pending assignments',()=>{
 const data={...snapshot,records:[...snapshot.records,{device:{mac:'aa:bb:cc:dd:ee:ff',ip:'10.0.0.11',fixed_ip:'10.0.0.12',use_fixedip:true}}]};
 const result=availableAddresses(data,assignment(),mac,{startIp:'10.0.0.10',endIp:'10.0.0.14'},[{mac:'ff:ff:ff:ff:ff:ff',ip:'10.0.0.13'}]);
 assert.deepEqual(result.addresses.map(r=>r.ip),['10.0.0.10','10.0.0.14']);assert.equal(result.total,2);assert.ok(result.addresses[0].current);
 assert.equal(availableAddresses(data,assignment(),mac,{startIp:'10.0.0.1',endIp:'10.0.0.2'}).total,1);
 for(const range of [{startIp:'10.0.1.1',endIp:'10.0.1.20'},{startIp:'::1',endIp:'::2'},{startIp:'10.0.0.0',endIp:'10.0.0.255'}]) assert.throws(()=>availableAddresses(data,assignment(),mac,range));
});

test('address pages and custom validation handle exhaustion, boundaries, and conflicts',()=>{
 const range={startIp:'10.0.0.10',endIp:'10.0.0.109'};
 const page=availableAddresses(snapshot,assignment(),mac,range);assert.equal(page.addresses.length,50);assert.equal(page.nextOffset,50);
 const second=availableAddresses(snapshot,assignment(),mac,range,[],50);assert.equal(second.addresses[0].ip,'10.0.0.60');assert.equal(second.nextOffset,null);
 for(const ip of ['10.0.0.0','10.0.0.255','10.0.1.2','bad','::1','10.0.0.1']) assert.throws(()=>desiredSettings(assignment(),'fixed',ip,snapshot,mac));
 assert.equal(desiredSettings(assignment(),'fixed','10.0.0.80',snapshot,mac).ip,'10.0.0.80');
 assert.throws(()=>desiredSettings(assignment(),'fixed','10.0.0.80',snapshot,mac,[{mac:'ff:ff:ff:ff:ff:ff',ip:'10.0.0.80'}]),/already/);
});

test('managed-device writes preserve unrelated settings and revisions ignore JSON key order',async()=>{
 const hardware={...client,kind:'managed_device',type:'uap',adopted:true,config_network:{type:'static',ip:'10.0.0.10',gateway:'10.0.0.1',dns1:'10.0.0.2',dns2:'10.0.0.3',dnssuffix:'home'}};
 const desired=desiredSettings(assignmentFor(hardware,[network]),'fixed','10.0.0.80',snapshot,mac);
 assert.equal(desired.config.dns2,'10.0.0.3');assert.equal(desired.config.gateway,'10.0.0.1');assert.equal(desired.config.dnssuffix,'home');
 let sent;await writeSettings({async put(path,payload){sent={path,payload};return{data:{meta:{rc:'ok'}}};}},desired,'test site');
 assert.match(sent.path,/test%20site\/rest\/device\/u$/);assert.deepEqual(sent.payload,{config_network:desired.config});
 assert.equal(settingsRevision({a:1,b:2}),settingsRevision({b:2,a:1}));
 assert.equal(settingsRevision({config:{type:'dhcp',ip:'old'}}),settingsRevision({config:{type:'dhcp'}}));
});

test('DNS comparison uses managed hostname, all UniFi addresses, and actual records',()=>{
 const base={hostname:'server',ips:['10.0.0.10','10.0.0.11'],lastSync:'now',unifiSync:'now',records:[{ip:'10.0.0.11',names:['server','alias']},{ip:'10.0.0.99',names:['different']}]};
 assert.equal(dnsComparison(base).state,'matched');
 const mismatch=dnsComparison({...base,ips:['10.0.0.10']});assert.equal(mismatch.state,'mismatch');assert.equal(mismatch.mismatches.length,1);
 assert.equal(dnsComparison({...base,records:[]}).state,'missing');
 assert.equal(dnsComparison({...base,ips:[]}).state,'unknown');assert.equal(dnsComparison({...base,unifiError:'offline'}).state,'unknown');assert.equal(dnsComparison({...base,dnsError:'offline'}).hasMismatch,false);
 assert.equal(dnsComparison({...base,operation:{state:'pending'}}).state,'pending');assert.equal(dnsComparison({...base,operation:{state:'failed'}}).state,'failed');
});

test('enqueue rejects stale settings before writes and captures DNS linkage durably',async()=>{
 const writes=[];const db={async query(sql,values){writes.push({sql,values});return{rows:[]};}};
 const device={id:1,mac,primaryIp:'10.0.0.10',hostname:'server',dns:{revision:'rev'},dnsComparison:{records:[{ip:'10.0.0.10',names:['server','alias']}]}};
 await assert.rejects(enqueueIpChange(db,device,snapshot,{mode:'fixed',ip:'10.0.0.80',expectedRevision:'stale'}),/changed/);assert.equal(writes.length,0);
 await enqueueIpChange(db,device,snapshot,{mode:'fixed',ip:'10.0.0.80',expectedRevision:assignment().revision});
 const insert=writes.find(q=>q.sql.includes('INSERT'));assert.equal(insert.values[7],'server');assert.equal(insert.values[10],'10.0.0.10');
});

test('DNS movement refuses old controller capabilities, changed records, or a non-UniFi target',async()=>{
 const device={id:1,hostname:'server',allIps:['10.0.0.80'],unifi:{},dns:{revision:'rev'},dnsComparison:{records:[{ip:'10.0.0.10',names:['server']}]}};
 const writes=[];const db={async query(sql,values){writes.push({sql,values});return{rows:[]};}};
 await assert.rejects(queueDnsMove(db,device,'10.0.0.80',{request:async()=>({revision:'rev'})}),/upgrade/);assert.equal(writes.length,0);
 await assert.rejects(queueDnsMove(db,device,'10.0.0.80',{request:async()=>({revision:'different',capabilities:['hostname.move']})}),/changed/);
 await assert.rejects(queueDnsMove(db,device,'10.0.0.99'),/reported by UniFi/);
 await queueDnsMove(db,device,'10.0.0.80',{request:async()=>({revision:'rev',capabilities:['hostname.move']})});
 assert.equal(writes[0].values[5],'10.0.0.10');
});

test('worker reconciles a lost write response before retrying and waits for observed address before DNS',async()=>{
 const desired=desiredSettings(assignment(),'fixed','10.0.0.80',snapshot,mac);
 const job={id:'job',device_id:1,site:process.env.UNIFI_SITE||'default',mac,desired,baseline:assignment().settings,ip:'10.0.0.80',old_ip:'10.0.0.10',hostname:'server',state:'applying'};
 let observed=false,writeCount=0,dnsCount=0;const transitions=[];
 const db={async query(sql,values){if(sql.includes('SELECT *,host(ip)'))return{rows:[job]};if(sql.includes('pg_try'))return{rows:[{acquired:true}]};if(sql.startsWith('UPDATE unifi_ip_jobs'))transitions.push(values[1]);return{rows:[]};}};
 const fresh=()=>({...snapshot,records:[{device:{...client,use_fixedip:true,fixed_ip:'10.0.0.80',ip:observed?'10.0.0.80':'10.0.0.10'}}]});
 const options={connect:async()=>({}),refresh:async()=>fresh(),write:async()=>{writeCount++;},fetchDns:async()=>{},getDevice:async()=>({hostname:'server'}),queueDns:async()=>{dnsCount++;return'dns';}};
 await processUnifiJobs(db,options);assert.equal(writeCount,0);assert.equal(dnsCount,0);assert.ok(transitions.includes('waiting'));
 observed=true;await processUnifiJobs(db,options);assert.equal(writeCount,0);assert.equal(dnsCount,1);assert.ok(transitions.includes('dns_pending'));
});

test('external changes do not produce automatic DNS jobs; DNS failures retain the UniFi assignment',async()=>{
 let connects=0;await processUnifiJobs({async query(){return{rows:[]};}},{connect:async()=>{connects++;}});assert.equal(connects,0);
 const desired=desiredSettings(assignment(),'fixed','10.0.0.80',snapshot,mac);
 const job={id:'job',device_id:1,site:'default',mac,desired,baseline:assignment().settings,ip:'10.0.0.80',old_ip:'10.0.0.10',hostname:'server',state:'waiting'};
 const states=[];const db={async query(sql,values){if(sql.includes('SELECT *,host(ip)'))return{rows:[job]};if(sql.includes('pg_try'))return{rows:[{acquired:true}]};if(sql.startsWith('UPDATE unifi_ip_jobs'))states.push(values[1]);return{rows:[]};}};
 await processUnifiJobs(db,{connect:async()=>({}),refresh:async()=>({...snapshot,records:[{device:{...client,ip:'10.0.0.80',use_fixedip:true,fixed_ip:'10.0.0.80'}}]}),fetchDns:async()=>{},getDevice:async()=>({hostname:'server'}),queueDns:async()=>{throw new Error('DNS unavailable');}});
 assert.ok(states.includes('dns_failed'));assert.ok(!states.includes('failed'));
});

test('switching to Automatic waits for a changed observed address and preserves concurrent hostname edits',async()=>{
 const baseline=assignmentFor({...client,use_fixedip:true,fixed_ip:client.ip},[network]);
 const desired=desiredSettings(baseline,'automatic',null,snapshot,mac);
 const job={id:'auto',device_id:1,site:'default',mac,desired,baseline:baseline.settings,ip:null,old_ip:client.ip,hostname:'server',state:'waiting'};
 let currentIp=client.ip,hostname='server',queued=0;const states=[];
 const db={async query(sql,values){if(sql.includes('SELECT *,host(ip)'))return{rows:[job]};if(sql.includes('pg_try'))return{rows:[{acquired:true}]};if(sql.startsWith('UPDATE unifi_ip_jobs'))states.push(values[1]);return{rows:[]};}};
 const options={connect:async()=>({}),refresh:async()=>({...snapshot,records:[{device:{...client,ip:currentIp}}]}),fetchDns:async()=>{},getDevice:async()=>({hostname}),queueDns:async(db,device,ip)=>{assert.equal(ip,'10.0.0.80');queued++;return'dns';}};
 await processUnifiJobs(db,options);assert.equal(queued,0);assert.equal(job.state,'waiting');
 currentIp='10.0.0.80';hostname='newer-name';await processUnifiJobs(db,options);assert.equal(queued,0);assert.ok(states.includes('dns_failed'));
 job.state='waiting';hostname='server';await processUnifiJobs(db,options);assert.equal(queued,1);
});

test('disabled reservations do not consume an otherwise unused address',()=>{
 const data={...snapshot,records:[...snapshot.records,{device:{mac:'aa:bb:cc:dd:ee:ff',ip:'10.0.0.11',fixed_ip:'10.0.0.12',use_fixedip:false}}]};
 const result=availableAddresses(data,assignment(),mac,{startIp:'10.0.0.12',endIp:'10.0.0.12'});
 assert.equal(result.total,1);assert.equal(result.addresses[0].ip,'10.0.0.12');
 const exhausted=availableAddresses(data,assignment(),mac,{startIp:'10.0.0.11',endIp:'10.0.0.11'});
 assert.equal(exhausted.total,0);assert.deepEqual(exhausted.addresses,[]);
});
