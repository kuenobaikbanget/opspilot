import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (process.env.NODE_ENV === "production") throw new Error("Demo seeding is disabled in production");
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Demo seeding requires a loopback PostgreSQL connection");
}

// Reserved fixture identities make reruns a no-op without overwriting user edits.
function demoId(group: number, index: number) {
  return `d3e${group.toString(16).padStart(5, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}
const hosts = [
  { name: "web-01", cpu: 87, memory: 61, disk: 42 },
  { name: "db-01", cpu: 23, memory: 68, disk: 94 },
  { name: "web-02", cpu: 18, memory: 44, disk: 38 },
  { name: "worker-01", cpu: 36, memory: 52, disk: 57 },
  { name: "backup-01", cpu: 14, memory: 28, disk: 31 },
  { name: "edge-01", cpu: null, memory: null, disk: null },
].map((host, index) => ({ ...host, id: demoId(1, index), hostname: `${host.name} (Demo data)` }));
const incidents = [
  { host: 0, category: "cpu", title: "High CPU on web-01", minutes: 15, resolution: null,
    evidence: "Synthetic CPU samples approach 87%. This is a host observation example, not evidence of service reachability or root cause." },
  { host: 1, category: "disk", title: "Disk utilization on db-01", minutes: 35, resolution: null,
    evidence: "Synthetic disk utilization is 94%. No filesystem was inspected and no real disk pressure is asserted." },
  { host: 3, category: "config_drift", title: "Configuration hash changed on worker-01", minutes: 50, resolution: null,
    evidence: "Illustrative nginx configuration hashes differ. No real configuration file was read. A byte change does not establish causation." },
  { host: 2, category: "manual", title: "Resolved upstream timeout example", minutes: 120,
    resolution: "Demo data — human-confirmed resolution example: an operator corrected an upstream port and verified the response. No configuration change or HTTP check was performed by this fixture.",
    evidence: "Authored example of a previously reported upstream timeout; this is not collected diagnostic output." },
  { host: 4, category: "disk", title: "Resolved backup retention example", minutes: 240,
    resolution: "Demo data — human-confirmed resolution example: an operator adjusted backup retention and confirmed free space. No files were deleted or backup policy changed by this fixture.",
    evidence: "Authored historical backup-capacity example; this is not a real backup failure or measured recovery." },
];
const sql = new SQL(url);
try {
  const inserted = await sql.begin(async tx => {
    // Serialize concurrent seed invocations, without locking ordinary host writes.
    await tx`SELECT pg_advisory_xact_lock(73460711)`;
    let existing = 0;
    for (const host of hosts) {
      const rows = await tx`SELECT hostname,version FROM agents WHERE id=${host.id}`;
      if (!rows.length) continue;
      if (rows[0].hostname !== host.hostname || rows[0].version !== "demo-fixture") {
        throw new Error("Reserved demo identity belongs to another record; no changes applied");
      }
      existing++;
    }
    if (existing === hosts.length) return false;
    if (existing) throw new Error("Demo hosts are partially present; refusing to overwrite or repair existing data");

    const now = Date.now();
    for (const [index, host] of hosts.entries()) {
      const sampleEnd = new Date(now - (index === 4 ? 180 : 5) * 60_000);
      // Discard the random credential: fixtures cannot authenticate an agent.
      const tokenHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
      await tx`INSERT INTO agents(id,hostname,token_hash,version,created_at,last_seen_at,status)
        VALUES(${host.id},${host.hostname},${tokenHash},'demo-fixture',${new Date(now - 86_400_000 - index * 1000)},${host.cpu === null ? null : sampleEnd},'offline')`;
      if (host.cpu === null) continue;
      await tx`INSERT INTO metric_samples(agent_id,sampled_at,cpu_percent,memory_percent,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds)
        SELECT ${host.id}::uuid,${sampleEnd}::timestamptz - (79 - sample) * INTERVAL '15 seconds',
          LEAST(100,GREATEST(0,${host.cpu}::double precision * (0.25 + 0.75 * sample / 79.0) + SIN(sample / 4.0) * 3)),
          LEAST(100,GREATEST(0,${host.memory}::double precision + SIN(sample / 8.0) * 1.5)),${host.disk}::double precision,
          4000000 + sample * 960000,2000000 + sample * 320000,864000 + sample * 15
        FROM generate_series(0,79) AS series(sample) WHERE sample NOT BETWEEN 32 AND 38`;
    }

    for (const [index, incident] of incidents.entries()) {
      const id = demoId(2, index);
      const evidenceId = demoId(3, index);
      const createdAt = new Date(now - incident.minutes * 60_000);
      const resolvedAt = incident.resolution ? new Date(createdAt.getTime() + 30 * 60_000) : null;
      await tx`INSERT INTO incidents(id,agent_id,title,category,status,created_at,resolved_at,resolution)
        VALUES(${id},${hosts[incident.host].id},${`Demo data — ${incident.title}`},${incident.category},${incident.resolution ? "resolved" : "open"},${createdAt},${resolvedAt},${incident.resolution})`;
      await tx`INSERT INTO evidence(id,incident_id,source,content,created_at)
        VALUES(${evidenceId},${id},'demo_fixture',${`Demo data — ${incident.evidence}`},${createdAt})`;
      if (incident.resolution) {
        await tx`INSERT INTO incident_memory(id,incident_id,summary,resolution,created_at)
          VALUES(${demoId(5, index)},${id},${`Demo data — ${incident.title}`},${incident.resolution},${resolvedAt})`;
      }
      if (index === 0) {
        const report = {
          probable_cause: "Demo data — authored AI-hypothesis example, not a model result. A CPU-intensive workload is one possibility; the synthetic host samples alone cannot identify the cause.",
          confidence: "low",
          evidence_ids: [evidenceId],
          missing_evidence: ["Real process measurements", "Independent endpoint observations"],
          recommended_checks: ["Review measured process utilization before attributing host CPU to a service."],
        };
        await tx`INSERT INTO investigations(id,incident_id,provider,status,result_json,created_at,started_at,completed_at)
          VALUES(${demoId(4, index)},${id},'openai','completed',${report}::jsonb,${createdAt},${createdAt},${createdAt})`;
      }
      if (index === 1) {
        await tx`INSERT INTO investigations(id,incident_id,provider,status,error,created_at,started_at,completed_at)
          VALUES(${demoId(4, index)},${id},'openai','failed','Demo data — simulated provider timeout. No provider request was made.',${createdAt},${createdAt},${createdAt})`;
      }
    }
    await tx`INSERT INTO audit_events(action,target_id,data) VALUES('demo.seed','local-demo-v1',${{ hosts: hosts.length, incidents: incidents.length, synthetic: true }}::jsonb)`;
    return true;
  });
  console.log(inserted
    ? "Demo data inserted: 6 offline hosts, 365 historical samples (with gaps), 5 incidents, 5 evidence records, 2 terminal investigation examples and 2 resolution memories. No agents, probes or AI calls started."
    : "Demo hosts already exist; no records changed.");
} finally {
  await sql.close();
}
