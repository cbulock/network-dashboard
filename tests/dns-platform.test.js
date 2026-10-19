import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { hostname, deviceAddress, normalizeSnapshot, selectDnsRecord, queueDnsChange } from '../scripts/dns-platform.js';
import { processDnsJobs, runDnsWorker } from '../scripts/dns-worker.js';

test('DNS names normalize and reject injection, wildcards, empty labels and invalid lengths', () => {
  assert.equal(hostname(' FILES.BULOCK. '),'files.bulock');
  for (const value of ['', 'a..b', '-host', 'host_', '*.bulock', 'x;reboot', 'a'.repeat(64)]) assert.throws(() => hostname(value));
  assert.equal(deviceAddress('10.0.0.2/32'),true);
  for (const ip of ['127.0.0.1','0.0.0.0','169.254.2.3','224.0.0.1','::1']) assert.equal(deviceAddress(ip),false);
});
test('snapshot validates atomically, retains shared names, and selection follows chosen then primary address', () => {
  const records=[{type:'A',value:'10.0.0.2',names:['files','shared']},{type:'A',value:'10.0.0.10',names:['other','shared']}];
  const snapshot=normalizeSnapshot({zone:'bulock',revision:'abc',records});
  assert.deepEqual(snapshot.records[0].names,['files','shared']);
  assert.equal(selectDnsRecord(snapshot.records,'10.0.0.10','10.0.0.2').names[0],'other');
  assert.equal(selectDnsRecord(snapshot.records,null,'10.0.0.2').names[0],'files');
  assert.equal(selectDnsRecord(snapshot.records,null,null).ip,'10.0.0.2');
  assert.throws(() => normalizeSnapshot({zone:'bulock',revision:'abc',records:[...records,records[0]]}));
});
test('unchanged hostname and target never enqueue a deployment', async () => {
  await queueDnsChange({query(){throw new Error('should not query');}},1,{hostname:'files',dns:{targetIp:'10.0.0.2'}},{hostname:'files',dns:{targetIp:'10.0.0.2'}});
});
test('worker reconciles lost responses with the same request ID and distinguishes failed DNS jobs', async () => {
  const job={id:'a',hostname:'files',ip:'10.0.0.2',expected_revision:'rev',state:'pending'};
  const writes=[];
  const db={async query(sql,values){if(sql.startsWith('SELECT'))return {rows:[job]}; writes.push(values); return {rows:[]};}};
  const seen=[];
  await processDnsJobs(db,async req=>{seen.push(req);throw new Error('timeout');});
  assert.equal(writes[0][0],'a');
  await processDnsJobs(db,async req=>{seen.push(req);return {id:'a',state:'failed',error:'Conflict',conflict:true};});
  assert.equal(seen[0].id,seen[1].id);
  assert.equal(writes[1][1],'failed');
  assert.equal(writes[1][3],'Conflict');
});

test('worker recovers an idle connection failure and reacquires ownership before processing jobs', async () => {
  const events=[];
  let stopped=false;
  let connection=0;
  let current;
  await runDnsWorker({
    async connect() {
      const id=++connection;
      const db=new EventEmitter();
      db.query=async () => { events.push(`lock${id}`); return {rows:[{acquired:id!==2}]}; };
      db.end=async () => {events.push(`close${id}`);};
      db.id=id;
      current=db;
      return db;
    },
    async ensure() {},
    async processIpJobs() {},
    async processJobs(db) {events.push(`jobs${db.id}`); return false;},
    async importRecords(db) {events.push(`import${db.id}`); if(db.id===3)stopped=true;},
    async sleep(ms) {if(ms===2000 && current.id===1) current.emit('error',new Error('connection lost'));},
    shouldStop:()=>stopped,
    log:()=>{},
  });
  assert.deepEqual(events,['lock1','jobs1','import1','close1','lock2','close2','lock3','jobs3','import3','close3']);
});
