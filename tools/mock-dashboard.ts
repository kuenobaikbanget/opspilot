import type { AiProvider, EndpointMonitor, Host, HostList, HostMetric, HostSystemdStatus } from "../packages/contracts/src/index";

const scenarios = ["populated", "empty", "incidents-error"] as const;
type Scenario = (typeof scenarios)[number];
const sampleInterval = 15_000;
const iso = (ms: number) => new Date(ms).toISOString();
const fixtureId = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const thresholds: HostList["thresholds"] = { cpu_percent: 85, memory_percent: 90, disk_percent: 90 };

const hostFixtures = [
  { id: fixtureId(1), hostname: "mock-edge-01", status: "online", age: 0, usage: [94, 81, 51] },
  { id: fixtureId(2), hostname: "mock-db-01", status: "online", age: 0, usage: [31, 55, 87] },
  { id: fixtureId(3), hostname: "mock-worker-01", status: "online", age: 180_000, usage: [41, 66, 61] },
  { id: fixtureId(4), hostname: "mock-legacy-01", status: "offline", age: 900_000, usage: [58, 63, 72] },
  { id: fixtureId(5), hostname: "mock-new-01", status: "online", age: 0, usage: null },
  { id: fixtureId(6), hostname: "mock-safe-01", status: "online", age: 0, usage: [34, 46, 38] },
  { id: fixtureId(7), hostname: "mock-near-limit-01", status: "online", age: 0, usage: [84, 49, 42] },
] as const;
type HostFixture = (typeof hostFixtures)[number];

function metric(usage: NonNullable<HostFixture["usage"]>, time: number, baseline: number): HostMetric {
  const [cpu, memory, disk] = usage;
  const tick = time / sampleInterval;
  const index = Math.max(0, (baseline - time) / sampleInterval);
  return {
    sampled_at: iso(time),
    cpu_percent: cpu - (index * 11) % 25,
    memory_percent: memory - (index * 3) % 17,
    disk_percent: disk - index % 8,
    network_rx_bytes: tick * 35_000,
    network_tx_bytes: tick * 12_000,
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function startDashboardMock(port: number, scenario: Scenario) {
  if (process.env.NODE_ENV === "production") throw new Error("Dashboard mock cannot run in production");
  const startedAt = Math.floor(Date.now() / sampleInterval) * sampleInterval;
  const fixtures = scenario === "empty" ? [] : hostFixtures;
  const sampleTime = (fixture: HostFixture, now: number) => fixture.age ? startedAt - fixture.age : now;
  const incident = (n: number, host: HostFixture, title: string, category: string, age: number, resolution: string | null = null) => ({
    id: fixtureId(n), agent_id: host.id, hostname: host.hostname, title, category,
    status: resolution ? "resolved" : "open", created_at: iso(startedAt - age),
    resolved_at: resolution ? iso(startedAt - age + 300_000) : null, resolution,
  });
  const incidents = scenario === "empty" ? [] : [
    incident(11, hostFixtures[0], "Mock CPU pressure on edge", "cpu", 300_000),
    incident(12, hostFixtures[1], "Mock database config change", "config_drift", 600_000),
    incident(13, hostFixtures[3], "Mock legacy disk pressure", "disk", 3_600_000, "Mock resolution: removed obsolete cache files and confirmed disk usage fell."),
  ];
  const memories = incidents.flatMap(record => record.resolution && record.resolved_at
    ? [{ id: fixtureId(23), incident_id: record.id, summary: record.title, resolution: record.resolution, created_at: record.resolved_at }]
    : []);
  const evidence = {
    id: fixtureId(21), source: "threshold", content: "Mock sample: CPU reached 94% against an 85% threshold.",
    created_at: iso(startedAt - 300_000),
  };
  const provider: AiProvider = {
    id: fixtureId(31), name: "Mock AI connection", protocol: "openai-compatible", baseUrl: "https://ai.example.invalid/v1",
    defaultModel: "mock-model", enabled: false, revision: 1, hasApiKey: false,
    createdAt: iso(startedAt - 86_400_000), updatedAt: iso(startedAt - 86_400_000), lastTest: null,
  };
  const investigation = {
    id: fixtureId(22), status: "completed", error: null,
    provider: { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, model: provider.defaultModel },
    result_json: {
      probable_cause: "Mock hypothesis: background work may be competing for CPU.", confidence: 0.65,
      evidence_ids: [evidence.id], recommended_checks: ["Compare process usage with the mock workload schedule."],
    },
  };
  const endpoint = (n: number, name: string, agent_id: string | null, last_status: EndpointMonitor["last_status"], time: number): EndpointMonitor => ({
    id: fixtureId(n), agent_id, service_name: null, name: `Mock ${name}`, target_url: `https://${name}.example.invalid/health`,
    expected_status: 200, probe_location: "mock-fixture", last_status,
    last_http_status: last_status === "up" ? 200 : last_status === "down" ? 503 : null,
    last_latency_ms: last_status === "unknown" ? null : 48, last_error: null,
    last_checked_at: last_status === "unknown" ? null : iso(time),
  });

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 16 * 1024,
    fetch(request) {
      if (request.method !== "GET") return json({ error: "Dashboard mock is read-only; no action was run." }, 405, { Allow: "GET" });
      const url = new URL(request.url);
      const now = Date.now();
      const currentSample = Math.floor(now / sampleInterval) * sampleInterval;
      const incidentError = () => json({ error: "Mock incident API is unavailable" }, 503);
      switch (url.pathname) {
        case "/api/auth/me":
          return json({ authenticated: true, role: "admin", authDisabled: true });
        case "/api/hosts": {
          const hosts: Host[] = fixtures.map(fixture => {
            const sample = fixture.usage ? metric(fixture.usage, sampleTime(fixture, currentSample), startedAt - fixture.age) : null;
            return {
              id: fixture.id, hostname: fixture.hostname, status: fixture.status, version: "mock", protocol_version: 2, capabilities: ["telemetry", "systemd_status", "diagnostics"],
              created_at: iso(startedAt - 86_400_000), last_seen_at: iso(fixture.status === "online" ? now : startedAt - fixture.age),
              sampled_at: sample?.sampled_at ?? null, cpu_percent: sample?.cpu_percent ?? null,
              memory_percent: sample?.memory_percent ?? null, disk_percent: sample?.disk_percent ?? null,
            };
          });
          return json({ hosts, total: hosts.length, online: hosts.filter(host => host.status === "online").length,
            limit: 100, observed_at: iso(now), stale_after_seconds: 60, thresholds } satisfies HostList);
        }
        case "/api/services":
          return json({ endpoints: scenario === "empty" ? [] : [
            endpoint(41, "storefront", hostFixtures[0].id, "down", currentSample),
            endpoint(42, "legacy-web", hostFixtures[3].id, "up", currentSample),
            endpoint(43, "status-page", null, "unknown", currentSample),
          ] });
        case "/api/incidents":
          return scenario === "incidents-error" ? incidentError() : json(incidents);
        case "/api/memory": {
          if (scenario === "incidents-error") return incidentError();
          const terms = (url.searchParams.get("q") ?? "").slice(0, 100).toLowerCase().trim().split(/\s+/);
          return json(memories.filter(record => {
            const text = `${record.summary} ${record.resolution}`.toLowerCase();
            return terms.every(term => text.includes(term));
          }));
        }
        case "/api/ai/providers":
          return json({ providers: scenario === "empty" ? [] : [provider], encryptionConfigured: false });
        case "/api/agents/install-config":
          return json({ error: "Agent installation is not configured in the dashboard mock" }, 503);
      }

      const hostMatch = /^\/api\/hosts\/([^/]+)\/(metrics|services)$/.exec(url.pathname);
      if (hostMatch) {
        const [, id, view] = hostMatch;
        if (!uuid.test(id)) return json({ error: "Invalid host id" }, 400);
        const fixture = fixtures.find(host => host.id === id);
        if (!fixture) return json({ error: "Host not found" }, 404);
        const latest = sampleTime(fixture, currentSample);
        if (view === "metrics") {
          const samples: HostMetric[] = [];
          if (fixture.usage) {
            const baseline = startedAt - fixture.age;
            for (let index = 0; index < 32; index++) {
              const time = latest - index * sampleInterval;
              if (time <= baseline - 9 * sampleInterval && time >= baseline - 14 * sampleInterval) continue;
              samples.push(metric(fixture.usage, time, baseline));
            }
          }
          return json(samples);
        }
        const online = fixture.status === "online";
        const status: HostSystemdStatus = { agent_id: id, online, checked_at: iso(now), report: null, service: null };
        if (fixture === hostFixtures[2]) status.report = { status: "unsupported", observed_at: iso(latest), current: true };
        if (fixture === hostFixtures[0] || fixture === hostFixtures[3]) {
          status.report = { status: "observed", observed_at: iso(latest), current: online };
          status.service = {
            id: fixtureId(online ? 51 : 52), agent_id: id, name: online ? "mock-storefront.service" : "mock-legacy-web.service",
            state: online ? "failed" : "running", runtime: "systemd", source: "agent_systemd", observed_at: iso(latest),
            freshness: online ? "fresh" : "stale",
          };
        }
        return json(status);
      }

      const incidentMatch = /^\/api\/incidents\/([^/]+)$/.exec(url.pathname);
      if (incidentMatch) {
        if (!uuid.test(incidentMatch[1])) return json({ error: "Invalid incident id" }, 400);
        if (scenario === "incidents-error") return incidentError();
        const record = incidents.find(item => item.id === incidentMatch[1]);
        if (!record) return json({ error: "Incident not found" }, 404);
        const hasInvestigation = record.id === fixtureId(11);
        return json({ incident: record, evidence: hasInvestigation ? [evidence] : [], investigations: hasInvestigation ? [investigation] : [] });
      }
      return json({ error: "Not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const scenario = process.env.MOCK_DASHBOARD_SCENARIO ?? "populated";
  if (!scenarios.includes(scenario as Scenario)) throw new Error(`MOCK_DASHBOARD_SCENARIO must be one of: ${scenarios.join(", ")}`);
  const port = Number(process.env.MOCK_DASHBOARD_PORT ?? 4102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MOCK_DASHBOARD_PORT must be an integer from 1 to 65535");
  const server = startDashboardMock(port, scenario as Scenario);
  console.log(`Dashboard mock (${scenario}) listening on ${server.url.origin}`);
}
