import test from 'node:test';
import assert from 'node:assert/strict';
import { saveVlan, saveReservedRange } from '../scripts/network-registry.js';
import { rangesOverlap, vlanSubnetsOverlap } from '../utils/network-match.js';
function fixture() {
  return { queries: [], async query(sql, values=[]) {
    this.queries.push({sql, values});
    if (sql.startsWith('SELECT') && sql.includes('FROM vlans')) return { rows: [{id:1, vlanId:10, name:'LAN', subnet:'10.0.0.0/24'}] };
    if (sql.startsWith('SELECT') && sql.includes('FROM virtual_subnets')) return { rows: [{id:2, slug:'servers', name:'Servers', startIp:'10.0.0.10', endIp:'10.0.0.20'}] };
    return {rows:[{id:values.at(-1)}]};
  }};
}
test('inclusive range overlap rejects shared endpoints and containment, allows adjacent ranges and different families',()=>{
 const a={startIp:'10.0.0.10',endIp:'10.0.0.20'};
 for(const b of [{startIp:'10.0.0.20',endIp:'10.0.0.30'},{startIp:'10.0.0.1',endIp:'10.0.0.50'},{startIp:'10.0.0.12',endIp:'10.0.0.15'}]) assert.equal(rangesOverlap(a,b),true);
 assert.equal(rangesOverlap(a,{startIp:'10.0.0.21',endIp:'10.0.0.30'}),false);
 assert.equal(rangesOverlap(a,{startIp:'::1',endIp:'::ff'}),false);
 assert.equal(rangesOverlap({startIp:'2001:db8::1',endIp:'2001:db8::ff'},{startIp:'2001:0db8::ff',endIp:'2001:db8::100'}),true);
});
test('VLAN overlap includes nested IPv4 and IPv6 networks',()=>{
 for(const [a,b] of [['10.0.0.0/24','10.0.0.128/25'],['2001:db8::/32','2001:db8:1::/48']]) {
 assert.equal(vlanSubnetsOverlap(a,b),true); assert.equal(vlanSubnetsOverlap(b,a),true);
 }
 assert.equal(vlanSubnetsOverlap('10.0.0.0/24','10.0.1.0/24'),false);
 assert.equal(vlanSubnetsOverlap('0.0.0.0/0','::/0'),false);
});
test('creates reject conflicts without updating existing entries and roll back',async()=>{
 for(const [save,payload] of [[saveVlan,{vlanId:10,name:'Duplicate'}],[saveVlan,{vlanId:20,name:'Nested',subnet:'10.0.0.128/25'}],[saveReservedRange,{name:'Other',startIp:'10.0.0.20',endIp:'10.0.0.30'}],[saveReservedRange,{name:'Servers',startIp:'10.0.1.1',endIp:'10.0.1.2'}]]) {
 const db=fixture(); await assert.rejects(save(db,payload),/already used|overlaps/);
 assert.equal(db.queries.at(-1).sql,'ROLLBACK');
 assert.ok(!db.queries.some(q=>/^(INSERT|UPDATE)/.test(q.sql)));
 }
});
test('edits exclude themselves, preserve identity, and commit after validation under lock',async()=>{
 for(const [save,payload,id] of [[saveVlan,{vlanId:20,name:'Renamed',subnet:'10.0.0.0/24'},1],[saveReservedRange,{name:'Renamed',slug:'servers',startIp:'10.0.0.10',endIp:'10.0.0.20'},2]]) {
 const db=fixture(); await save(db,payload,id);
 assert.equal(db.queries[0].sql,'BEGIN'); assert.match(db.queries[1].sql,/LOCK TABLE/);
 const update=db.queries.find(q=>q.sql.startsWith('UPDATE')); assert.equal(update.values.at(-1),id);
 assert.equal(db.queries.at(-1).sql,'COMMIT');
 await assert.rejects(save(fixture(),payload,999),/not found/);
 }
});
test('invalid VLAN inputs are rejected before transaction',async()=>{
 for(const payload of [{vlanId:1.5,name:'Bad'},{vlanId:4095,name:'Bad'},{vlanId:10,name:'Bad',subnet:'10.0.0.1/24'},{vlanId:10,name:'Bad',subnet:'::/129'}]) {
 const db=fixture(); await assert.rejects(saveVlan(db,payload)); assert.equal(db.queries.length,0);
 }
});
test('edits reject another entry conflicts and leave persistence untouched', async()=>{
 for (const [save,payload,id] of [[saveVlan,{vlanId:20,name:'Other',subnet:'10.0.0.0/25'},3],[saveReservedRange,{name:'Other',startIp:'10.0.0.1',endIp:'10.0.0.30'},3]]) {
  const db=fixture(); const original=db.query.bind(db);
  db.query=async(sql,values)=>{const result=await original(sql,values); if(sql.startsWith('SELECT')) result.rows.push({id:3,vlanId:30,name:'Other',slug:'other',subnet:'10.1.0.0/24',startIp:'10.1.0.1',endIp:'10.1.0.2'}); return result;};
  await assert.rejects(save(db,payload,id),/overlaps/);
  assert.ok(!db.queries.some(q=>q.sql.startsWith('UPDATE')));
 }
});
