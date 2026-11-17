import { db, audit } from "./db";
import { createSession, checkPassword, isAuthed, sessionCookie, logoutCookie } from "./auth";
import { authenticateAgent, createEnrollmentToken, enrollAgent, socketOpened, socketClosed, socketMessage, agentOnline, requestDiagnostics, type SocketData } from "./agents";
import { createIncident } from "./incidents";
import type { Provider, DiagnosticTool, Host, HostList, HostMetric } from "@opspilot/contracts";

const port=Number(process.env.PORT||3001);
if(process.env.NODE_ENV==="production" && !process.env.ADMIN_PASSWORD_HASH) throw new Error("ADMIN_PASSWORD_HASH required in production");
const providers=()=>["openai","anthropic","gemini"].filter(p=>Boolean(process.env[({openai:"OPENAI_API_KEY",anthropic:"ANTHROPIC_API_KEY",gemini:"GEMINI_API_KEY"} as Record<string,string>)[p]]));
function j(data:unknown,status=200,headers:Record<string,string>={}){return Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});}
async function body(req:Request):Promise<any> { const raw=await req.text(); if(raw.length>16000)throw new Error("Body too large"); try{return JSON.parse(raw||"{}");}catch{throw new SyntaxError("Invalid JSON body");} }
const invalid=(error:string,status=400)=>j({error},status);
function urlUUID(s:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);}
type HostRow = Omit<Host, "status" | "last_seen_at" | "created_at" | "sampled_at"> & {
  last_seen_at: Date | null; created_at: Date; sampled_at: Date | null;
};
type HostMetricRow = Omit<HostMetric, "sampled_at"> & { sampled_at: Date };
async function router(req:Request):Promise<Response>{
  const path=new URL(req.url).pathname; const method=req.method.toUpperCase();
  if(path==="/healthz") {try{await db`SELECT 1`;return j({ok:true,db:true});}catch{return j({ok:false,db:false},503);}}
  if(method==="POST"){
    const origin=req.headers.get("origin");
    if(origin && origin!==(process.env.ALLOWED_ORIGIN||"http://localhost:3000"))return invalid("Forbidden origin",403);
  }
  if(path==="/api/auth/login" && method==="POST"){
    const data=await body(req); const password=String(data.password||"");
    if(password.length>256)return invalid("Invalid credentials",401);
    if(!(await checkPassword(password))) {await new Promise(r=>setTimeout(r,300));return invalid("Invalid credentials",401);}
    await audit("admin.login",null);
    return j({ok:true},200,{"Set-Cookie":sessionCookie(createSession())});
  }
  if(!isAuthed(req))return invalid("Unauthorized",401);
  if(path==="/api/auth/me" && method==="GET")return j({authenticated:true,role:"admin"});
  if(path==="/api/auth/logout"&&method==="POST")return j({ok:true},200,{"Set-Cookie":logoutCookie()});
  if(path==="/api/ai/providers"&&method==="GET")return j({available:providers(),configuration:"server-environment"});
  if(path==="/api/agents/enrollment-token"&&method==="POST")return j(await createEnrollmentToken(),201);
  if(path==="/api/hosts"&&method==="GET"){
    const limit=100;
    const [fleet,rows]=await Promise.all([
      db<{id:string}[]>`SELECT id FROM agents`,
      db<HostRow[]>`SELECT a.id,a.hostname,a.version,a.last_seen_at,a.created_at, m.cpu_percent,m.memory_percent,m.disk_percent, m.sampled_at
        FROM agents a LEFT JOIN LATERAL (SELECT cpu_percent,memory_percent,disk_percent,sampled_at FROM metric_samples WHERE agent_id=a.id ORDER BY sampled_at DESC LIMIT 1) m ON true ORDER BY a.created_at DESC,a.id LIMIT ${limit}`
    ]);
    const hosts:Host[]=rows.map(row=>({
      ...row,status:agentOnline(row.id)?"online":"offline",
      last_seen_at:row.last_seen_at?.toISOString()??null,
      created_at:row.created_at.toISOString(),sampled_at:row.sampled_at?.toISOString()??null
    }));
    const result:HostList={
      hosts,total:fleet.length,online:fleet.reduce((count,host)=>count+Number(agentOnline(host.id)),0),
      limit,observed_at:new Date().toISOString(),stale_after_seconds:60
    };
    return j(result);
  }
  let match=path.match(/^\/api\/hosts\/([^/]+)\/metrics$/);
  if(match && method==="GET"){
    if(!urlUUID(match[1]))return invalid("Invalid host id");
    const host=await db<{id:string}[]>`SELECT id FROM agents WHERE id=${match[1]}`;
    if(!host.length)return invalid("Host not found",404);
    const rows=await db<HostMetricRow[]>`SELECT sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes::double precision AS network_rx_bytes,network_tx_bytes::double precision AS network_tx_bytes FROM metric_samples WHERE agent_id=${match[1]} ORDER BY sampled_at DESC LIMIT 120`;
    const metrics:HostMetric[]=rows.map(row=>({...row,sampled_at:row.sampled_at.toISOString()}));
    return j(metrics);
  }
  if(path==="/api/incidents"&&method==="GET") {
    return j(await db`SELECT i.*,a.hostname FROM incidents i JOIN agents a ON a.id=i.agent_id ORDER BY i.created_at DESC LIMIT 100`);
  }
  if(path==="/api/incidents"&&method==="POST"){
    const data=await body(req);
    if(!urlUUID(String(data.agentId||"")) || typeof data.title!=="string" || data.title.length<3 || data.title.length>160)return invalid("agentId and title (3-160 chars) required");
    const host=await db`SELECT id FROM agents WHERE id=${data.agentId}`;if(!host.length)return invalid("Host not found",404);
    const id=await createIncident(data.agentId,"manual",data.title.trim(),"manual","Created by administrator; investigate to collect live evidence.");
    return j({id},201);
  }
  match=path.match(/^\/api\/incidents\/([^/]+)$/);
  if(match&&method==="GET"){
    if(!urlUUID(match[1]))return invalid("Invalid incident id");
    const incident=await db`SELECT i.*,a.hostname FROM incidents i JOIN agents a ON a.id=i.agent_id WHERE i.id=${match[1]}`;
    if(!incident.length)return invalid("Not found",404);
    const evidence=await db`SELECT id,source,content,created_at FROM evidence WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 50`;
    const investigations=await db`SELECT id,provider,status,result_json,error,created_at,completed_at FROM investigations WHERE incident_id=${match[1]} ORDER BY created_at DESC LIMIT 10`;
    return j({incident:incident[0],evidence,investigations});
  }
  match=path.match(/^\/api\/incidents\/([^/]+)\/investigate$/);
  if(match&&method==="POST"){
    if(!urlUUID(match[1]))return invalid("Invalid incident id");
    const data=await body(req);const provider=data.provider as Provider;
    if(!["openai","anthropic","gemini"].includes(provider))return invalid("Invalid provider");
    if(!providers().includes(provider))return invalid("Provider key is not configured on hub/worker",503);
    const rows=await db`SELECT agent_id,category,status FROM incidents WHERE id=${match[1]}`;
    if(!rows.length)return invalid("Not found",404);
    if(rows[0].status!=="open")return invalid("Incident is resolved",409);
    const id=match[1],agentId=rows[0].agent_id as string;
    const tools:Array<[DiagnosticTool,string?]> = rows[0].category==="disk" ? [["disk_usage"]] : [["disk_usage"],["listening_ports"],["service_status","nginx"],["docker_status"]];
    if(agentOnline(agentId)) await Promise.allSettled(tools.map(([tool,service])=>requestDiagnostics(agentId,id,tool,service)));
    const queued=await db`INSERT INTO investigations(incident_id,provider) VALUES(${id},${provider}) RETURNING id`;
    await audit("investigation.queued",queued[0].id,{incidentId:id,provider});
    return j({id:queued[0].id,status:"queued",liveAgent:agentOnline(agentId)},202);
  }
  match=path.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
  if(match&&method==="POST"){
    if(!urlUUID(match[1]))return invalid("Invalid incident id");
    const data=await body(req);const resolution=String(data.resolution||"").trim();
    if(resolution.length<8||resolution.length>3000)return invalid("Resolution must be 8-3000 characters");
    const incident=await db`UPDATE incidents SET status='resolved',resolution=${resolution},resolved_at=NOW() WHERE id=${match[1]} AND status='open' RETURNING id,title`;
    if(!incident.length)return invalid("Not found or already resolved",404);
    await db`INSERT INTO incident_memory(incident_id,summary,resolution) VALUES(${match[1]},${incident[0].title},${resolution}) ON CONFLICT(incident_id) DO UPDATE SET resolution=excluded.resolution`;
    await audit("incident.resolved",match[1]);return j({ok:true});
  }
  if(path==="/api/memory"&&method==="GET"){
    const q=new URL(req.url).searchParams.get("q")?.slice(0,100)||"";
    if(q){return j(await db`SELECT id,incident_id,summary,resolution,created_at FROM incident_memory WHERE to_tsvector('simple',summary || ' ' || resolution) @@ plainto_tsquery('simple',${q}) ORDER BY created_at DESC LIMIT 20`);}
    return j(await db`SELECT id,incident_id,summary,resolution,created_at FROM incident_memory ORDER BY created_at DESC LIMIT 20`);
  }
  return invalid("Not found",404);
}
const server=Bun.serve<SocketData>({
  port,hostname:"0.0.0.0",maxRequestBodySize:64*1024,
  async fetch(req,server){
    const url=new URL(req.url);
    try {
      if(url.pathname==="/api/agents/enroll"&&req.method==="POST"){
        const origin=req.headers.get("origin");if(origin)return invalid("Agent requests must not have browser origin",403);
        const data=await body(req);
        if(typeof data.token!=="string"||typeof data.hostname!=="string"||data.hostname.length>100||!data.hostname.length)return invalid("Bad enrollment request");
        const result=await enrollAgent(data.token,data.hostname,String(data.version||"dev"));
        return result?j(result,201):invalid("Invalid/expired token",401);
      }
      if(url.pathname==="/api/agents/connect"){
        const origin=req.headers.get("origin");if(origin)return invalid("Browser WebSocket not allowed",403);
        const agentId=await authenticateAgent(req);
        if(!agentId)return invalid("Invalid agent identity",401);
        if(server.upgrade(req,{data:{agentId}}))return;
        return invalid("Upgrade failed",400);
      }
      return await router(req);
    }catch(e:any){if(e instanceof SyntaxError)return invalid("Invalid JSON body",400);if(e?.message==="Body too large")return invalid("Body too large",413);console.error("Request failed",e?.message);return invalid("Internal error",500);}
  },
  websocket:{
    maxPayloadLength:64*1024,
    open(ws){socketOpened(ws);},
    message(ws,msg){void socketMessage(ws,msg).catch(e=>console.error("WS message failed",e));},
    close(ws){socketClosed(ws);},
  }
});
console.log(`OpsPilot Hub listening on http://localhost:${server.port}`);
