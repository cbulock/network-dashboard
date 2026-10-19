import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotCache, deviceFromSnapshot, getIpAvailability } from '../scripts/unifi-availability.js';
import { createIpChoices } from '../utils/ip-choices.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };
const network={_id:'lan',name:'LAN',ip_subnet:'10.0.0.1/24',dhcpd_enabled:true};
const mac='00:11:22:33:44:55';
const snapshot={checkedAt:'now',networks:[network],records:[{device:{_id:'u',userId:'u',kind:'client',mac,ip:'10.0.0.10',network_id:'lan',use_fixedip:false,connected:true}}]};
const device={mac,hostname:'host',dns:{records:[{ip:'10.0.0.9',names:['host']}],lastSync:'now'},unifi:{}};

test('availability coalesces controller reads, expires, and forces fresh write checks',async()=>{
 let time=0,calls=0;const cache=createSnapshotCache(async()=>++calls,{now:()=>time,ttl:20});
 assert.deepEqual(await Promise.all([cache.get(),cache.get()]),[1,1]);
 assert.equal(await cache.get(),1);assert.equal(await cache.get({fresh:true}),2);
 time=21;assert.equal(await cache.get(),3);
});
test('older controller responses cannot overwrite a forced fresh snapshot; failed refresh invalidates cache',async()=>{
 const first=deferred(),second=deferred();let calls=0;
 const cache=createSnapshotCache(()=>[++calls===1?first:second][0].promise);
 const old=cache.get();await Promise.resolve();const fresh=cache.get({fresh:true});await Promise.resolve();
 second.resolve('new');await fresh;first.resolve('old');await old;assert.equal(await cache.get(),'new');
 let fail=false,count=0;const unstable=createSnapshotCache(async()=>{count++;if(fail)throw Error('offline');return count;});
 await unstable.get();fail=true;await assert.rejects(unstable.get({fresh:true}));fail=false;assert.equal(await unstable.get(),3);
});
test('read-only availability preloads range pages, checks pending conflicts and keeps DNS evidence',async()=>{
 const queries=[];const db={async query(sql){queries.push(sql);return {rows:sql.includes('virtual_subnets')?[{id:1,name:'Long',startIp:'10.0.0.10',endIp:'10.0.0.109'},{id:2,name:'Other network',startIp:'10.1.0.10',endIp:'10.1.0.20'}]:[{mac:'other',ip:'10.0.0.11'}]};}};
 const result=await getIpAvailability(db,device,snapshot);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT')));assert.equal(result.ranges[0].availability.addresses.length,50);
 assert.equal(result.ranges[0].total,99);assert.equal(result.ranges[1].compatible,false);
 assert.equal(result.device.primaryIp,'10.0.0.10');assert.equal(result.device.dnsComparison.state,'mismatch');
 assert.equal((await getIpAvailability(db,device,snapshot,{rangeId:1,offset:50})).addresses.length,49);
 await assert.rejects(getIpAvailability(db,device,snapshot,{rangeId:99}),/not found/);
 await assert.rejects(getIpAvailability(db,device,snapshot,{offset:-1}),/Invalid/);
 assert.equal(deviceFromSnapshot({...device,mac:null},{...snapshot,records:[{device:{ip:'10.0.0.20'}}]}).primaryIp,null);
});
test('range switching uses preloaded choices immediately without another request',async()=>{
 let calls=0;const pages=[1,2].map(id=>({id,availability:{addresses:[{ip:`10.0.0.${id}`}],total:1}}));
 const picker=createIpChoices(async()=>{calls++;return {checkedAt:'now',ranges:pages,addresses:[],device};});
 await picker.load();await picker.load('2');assert.equal(calls,1);assert.equal(picker.pending.value,false);assert.equal(picker.page.value.addresses[0].ip,'10.0.0.2');
});
test('late responses and cancellations do not replace the current range or leave controls busy',async()=>{
 const requests=[];const picker=createIpChoices(()=>{const request=deferred();requests.push(request);return request.promise;});
 const first=picker.load('1'),second=picker.load('2');
 requests[1].resolve({checkedAt:'new',ranges:[],addresses:[{ip:'new'}],device});await second;
 requests[0].resolve({checkedAt:'old',ranges:[],addresses:[{ip:'old'}],device});await first;
 assert.equal(picker.page.value.addresses[0].ip,'new');
 const third=picker.load('3');picker.cancel();requests[2].reject(Error('aborted'));await third;
 assert.equal(picker.pending.value,false);assert.equal(picker.error.value,'');
});
test('refresh keeps cached choices visible and reports failures instead of accepting stale availability',async()=>{
 let fail=false;const picker=createIpChoices(async()=>{if(fail)throw Error('offline');return {checkedAt:'now',ranges:[],addresses:[{ip:'current'}],device};});
 await picker.load('1');fail=true;const refresh=picker.load('1',0,{fresh:true});
 assert.equal(picker.page.value.addresses[0].ip,'current');assert.equal(picker.pending.value,true);
 await refresh;assert.equal(picker.error.value,'offline');assert.equal(picker.pending.value,false);
});
