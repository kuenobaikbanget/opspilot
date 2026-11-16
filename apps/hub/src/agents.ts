import type { ServerWebSocket } from "bun";
import { db, hashSecret, audit } from "./db";
import { checkThresholds, checkConfigHashes, addEvidence } from "./incidents";
import { MAX_WS_MESSAGE_BYTES, safeTool, finitePercent, type AgentTelemetry, type DiagnosticResult, type DiagnosticTool } from "@opspilot/contracts";
import { randomBytes } from "node:crypto";

export type SocketData = { agentId: string };
const connections=new Map<string,ServerWebSocket<SocketData>>();
const pending=new Map<string,{agentId:string;incidentId:string;tool:string;resolve:(ok:boolean)=>void;timer:ReturnType<typeof setTimeout>}>();
const secret=()=>randomBytes(32).toString("base64url");
export async function enrollAgent(token:string,hostname:string,version:string) {
  const hash=hashSecret(token);
  const claimed=await db`UPDATE enrollment_tokens SET used_at=NOW() WHERE token_hash=${hash} AND used_at IS NULL AND expires_at>NOW() RETURNING id`;
  if (!claimed.length) return null;
  const agentSecret=secret();
  const rows=await db`INSERT INTO agents(hostname,token_hash,version) VALUES(${hostname.slice(0,100)},${hashSecret(agentSecret)},${version.slice(0,40)}) RETURNING id`;
  await audit("agent.enrolled",rows[0].id,{hostname});
  return {agentId: rows[0].id as string, agentSecret};
}
export async function authenticateAgent(req:Request):Promise<string|null> {
  const id=req.headers.get("x-opspilot-agent-id")||"";
  const bearer=req.headers.get("authorization")||"";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||!bearer.startsWith("Bearer "))return null;
  const hash=hashSecret(bearer.slice(7));
  const rows=await db`SELECT id FROM agents WHERE id=${id} AND token_hash=${hash}`;
  return rows.length ? rows[0].id as string : null;
}
export async function createEnrollmentToken() {
  const token=secret();
  await db`INSERT INTO enrollment_tokens(token_hash,expires_at) VALUES(${hashSecret(token)}, NOW()+INTERVAL '10 minutes')`;
  await audit("enrollment.created",null);
  return {token,expiresInSeconds:600};
}
export function socketOpened(ws:ServerWebSocket<SocketData>) {
  const existing=connections.get(ws.data.agentId);
  if (existing && existing!==ws) existing.close(4001,"Superseded by new session");
  connections.set(ws.data.agentId,ws);
  void db`UPDATE agents SET status='online',last_seen_at=NOW() WHERE id=${ws.data.agentId}`.execute().catch(console.error);
}
export function socketClosed(ws:ServerWebSocket<SocketData>) {
  if(connections.get(ws.data.agentId)===ws){connections.delete(ws.data.agentId);void db`UPDATE agents SET status='offline' WHERE id=${ws.data.agentId}`.execute().catch(console.error);}
}
export async function socketMessage(ws:ServerWebSocket<SocketData>,message:string|Buffer) {
  const raw=typeof message==="string"?message:message.toString();
  if(Buffer.byteLength(raw)>MAX_WS_MESSAGE_BYTES){ws.close(1009,"Message too large");return;}
  let msg:any;try{msg=JSON.parse(raw);}catch{return;}
  const agentId=ws.data.agentId;
  if(msg.type==="telemetry"){
    const m=msg as AgentTelemetry;
    if (![m.cpuPercent,m.memoryPercent,m.diskPercent].every(finitePercent) || !Number.isFinite(m.networkRxBytes) || !Number.isFinite(m.networkTxBytes) || !Number.isFinite(m.uptimeSeconds)) return;
    await db`INSERT INTO metric_samples(agent_id,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds) VALUES(${agentId},${m.cpuPercent},${m.memoryPercent},${m.diskPercent},${Math.max(0,Math.trunc(m.networkRxBytes))},${Math.max(0,Math.trunc(m.networkTxBytes))},${Math.max(0,Math.trunc(m.uptimeSeconds))})`;
    await db`UPDATE agents SET last_seen_at=NOW(),status='online' WHERE id=${agentId}`;
    await checkThresholds(agentId,m);
    if(m.configHashes && typeof m.configHashes==="object" && !Array.isArray(m.configHashes)) await checkConfigHashes(agentId,m.configHashes);
  } else if(msg.type==="diagnostic_result") {
    const r=msg as DiagnosticResult;
    const p=pending.get(r.requestId);
    if (!p||p.agentId!==agentId||p.tool!==r.tool)return;
    clearTimeout(p.timer);pending.delete(r.requestId);
    await addEvidence(p.incidentId,`tool:${r.tool}`,`success=${Boolean(r.ok)}; output=${String(r.content).slice(0,5000)}`);
    p.resolve(Boolean(r.ok));
  }
}
export function agentOnline(id:string){return connections.has(id);}
export async function requestDiagnostics(agentId:string,incidentId:string,tool:DiagnosticTool,service?:string):Promise<boolean> {
  const socket=connections.get(agentId);if(!socket)return false;
  const requestId=crypto.randomUUID();
  return new Promise<boolean>(resolve=>{
    const timer=setTimeout(()=>{pending.delete(requestId);resolve(false);},6000);
    pending.set(requestId,{agentId,incidentId,tool,resolve,timer});
    try{socket.send(JSON.stringify({type:"diagnostic_request",requestId,tool,...(service?{service}:{})}));}
    catch{clearTimeout(timer);pending.delete(requestId);resolve(false);}
  });
}
