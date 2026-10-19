import {openDatabase,recordRuntimeHeartbeat} from '@adi/storage';import {startIngestWorker} from './ingest-worker.js';
startIngestWorker(config=>{
 if(typeof config.connectionString!=='string'||typeof config.schema!=='string')throw new Error('Invalid PostgreSQL worker configuration');
 const db=openDatabase({connectionString:config.connectionString,schema:config.schema,maxConnections:2});
 return {
  async policy(){
   // Start expiry before SQL, so slow I/O cannot extend stale credentials.
   const expiresAt=Date.now()+10000,result=(await db.query<{writable:boolean;installations:{id:string;token_hash:string;ingest_epoch:number}[]}>(`SELECT writable,
     CASE WHEN writable THEN (SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
       SELECT i.id,i.token_hash,u.ingest_epoch FROM installations i JOIN users u ON u.id=i.user_id
       WHERE i.enabled AND u.status='active' ORDER BY i.id LIMIT 10001
     ) x) ELSE '[]'::jsonb END AS installations
     FROM (SELECT recovery_id IS NULL AND collection_enabled
       AND NOT current_setting('transaction_read_only')::boolean AS writable FROM data_identity) policy`)).rows[0];
   if(!result||result.installations.length>10000)throw new Error('Policy unavailable or over capacity');return {expiresAt,writable:result.writable,installations:result.installations.map(row=>[row.id,{tokenHash:row.token_hash,enabled:true,admissionEpoch:row.ingest_epoch}])};
  },ingestJson:db.ingestJson,reportRuntime:value=>recordRuntimeHeartbeat(db,value),close:db.close,
 };
});
