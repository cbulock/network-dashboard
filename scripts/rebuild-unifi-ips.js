import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getDbClient, ensureDeviceSchema } from './device-registry.js';
import { normalizeSourceIps } from './source-identity.js';

export async function planIpRebuild(db) {
  const {rows}=await db.query(`SELECT d.id,d.ips,host(d.primary_ip) AS primary_ip,
    (SELECT jsonb_agg(s.raw_data) FROM device_sources s WHERE s.source='unifi' AND s.device_id=d.id) AS records FROM devices d ORDER BY d.id`);
  return rows.flatMap(row=>{
    const ips=normalizeSourceIps((row.records || []).filter(r=>r && r.active!==false).flatMap(r=>[r.ip,...(r.ipv6_addresses || [])])).sort();
    const old=normalizeSourceIps(row.ips || []).sort();
    return row.primary_ip || JSON.stringify(ips)!==JSON.stringify(old) ? [{id:row.id,previousIps:row.ips,previousPrimaryIp:row.primary_ip,ips}] : [];
  });
}
async function main() {
 const db=await getDbClient();
 try {
   if(process.argv.includes('--apply'))await ensureDeviceSchema(db);
   await db.query('BEGIN');
   if(process.argv.includes('--apply'))await db.query('LOCK TABLE devices,device_sources IN SHARE ROW EXCLUSIVE MODE');
   const changes=await planIpRebuild(db);
   if(process.argv.includes('--apply') && changes.length){
     mkdirSync('.data/repairs',{recursive:true});
     const manifest=`.data/repairs/unifi-ips-${Date.now()}.json`;
     writeFileSync(manifest,JSON.stringify({createdAt:new Date().toISOString(),changes},null,2));
     for(const change of changes)await db.query('UPDATE devices SET ips=$2::inet[],primary_ip=NULL WHERE id=$1',[change.id,change.ips]);
     console.log(JSON.stringify({applied:changes.length,manifest}));
   } else console.log(JSON.stringify({changes:changes.length,apply:process.argv.includes('--apply')}));
   await db.query('COMMIT');
 } catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
