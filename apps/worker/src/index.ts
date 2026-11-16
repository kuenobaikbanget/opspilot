import { SQL } from "bun";
import { generateDiagnosis, availableProviders } from "@opspilot/ai";
import type { Provider } from "@opspilot/contracts";
if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
const db=new SQL({url:process.env.DATABASE_URL,max:4,idleTimeout:30});
const interval=Math.max(1000,Number(process.env.INVESTIGATION_POLL_MS||3000));
async function poll(){
 const acquired=await db`UPDATE investigations SET status='running',started_at=NOW()
   WHERE id=(SELECT id FROM investigations WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING id,incident_id,provider`;
 if(!acquired.length)return;
 const job=acquired[0];
 try {
   if(!availableProviders().includes(job.provider as Provider))throw new Error("Missing provider key in worker environment");
   const i=await db`SELECT title,category FROM incidents WHERE id=${job.incident_id}`;
   if(!i.length)throw new Error("Incident not found");
   const evidence=await db`SELECT id,source,content FROM evidence WHERE incident_id=${job.incident_id} ORDER BY created_at DESC LIMIT 12`;
   const memories=await db`SELECT id,summary,resolution FROM incident_memory WHERE to_tsvector('simple',summary || ' ' || resolution) @@ plainto_tsquery('simple',${i[0].title}) ORDER BY created_at DESC LIMIT 5`;
   const diagnosis=await generateDiagnosis(job.provider as Provider,i[0] as {title:string;category:string},evidence as any,memories as any);
   await db`UPDATE investigations SET status='completed',result_json=${JSON.stringify(diagnosis)}::jsonb,completed_at=NOW() WHERE id=${job.id}`;
   console.log("Completed investigation",job.id);
 }catch(err:any){
   await db`UPDATE investigations SET status='failed',error=${String(err.message||err).slice(0,500)},completed_at=NOW() WHERE id=${job.id}`;
   console.error("Investigation failed",job.id,err.message);
 }
}
console.log("OpsPilot worker started; available AI providers:",availableProviders());
// Never overlap polls in one worker; DB SKIP LOCKED protects multiple workers.
while(true){try{await poll();}catch(err){console.error("Worker poll failed",err);}await Bun.sleep(interval);}
