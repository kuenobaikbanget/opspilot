import { expect, test } from "bun:test";
import type { HostList, HostMetric, HostSystemdStatus, ServicesPayload } from "../packages/contracts/src/index";
import { startDashboardMock } from "../tools/mock-dashboard";

test("dashboard fixture distinguishes connectivity, telemetry age, and endpoint reachability", async () => {
  const server = startDashboardMock(0, "populated");
  try {
    const fleet: HostList = await (await fetch(new URL("/api/hosts", server.url))).json();
    const stale = fleet.hosts.find(host => host.hostname === "mock-worker-01")!;
    const offline = fleet.hosts.find(host => host.status === "offline")!;
    const unsampled = fleet.hosts.find(host => host.sampled_at === null)!;
    expect(stale.status).toBe("online");
    expect(Date.parse(fleet.observed_at) - Date.parse(stale.sampled_at!)).toBeGreaterThan(fleet.stale_after_seconds * 1000);
    expect(unsampled.cpu_percent).toBeNull();

    const history: HostMetric[] = await (await fetch(new URL(`/api/hosts/${offline.id}/metrics`, server.url))).json();
    expect(history[0]).toMatchObject({ sampled_at: offline.sampled_at });
    expect(history.some((sample, i) => i > 0 && Date.parse(history[i - 1].sampled_at) - Date.parse(sample.sampled_at) > 60_000)).toBe(true);
    const status: HostSystemdStatus = await (await fetch(new URL(`/api/hosts/${offline.id}/services`, server.url))).json();
    expect(status.service?.freshness).toBe("stale");
    const services: ServicesPayload = await (await fetch(new URL("/api/services", server.url))).json();
    expect(services.endpoints.find(endpoint => endpoint.agent_id === offline.id)?.last_status).toBe("up");
  } finally {
    await server.stop(true);
  }
});

test("empty fleet, partial incident outage and unsupported requests remain distinguishable", async () => {
  const empty = startDashboardMock(0, "empty");
  const outage = startDashboardMock(0, "incidents-error");
  try {
    const [emptyFleet, emptyIncidents, failedIncidents, liveFleet, mutation, missingRoute, invalidHost] = await Promise.all([
      fetch(new URL("/api/hosts", empty.url)), fetch(new URL("/api/incidents", empty.url)),
      fetch(new URL("/api/incidents", outage.url)), fetch(new URL("/api/hosts", outage.url)),
      fetch(new URL("/api/agents/enrollment-token", outage.url), { method: "POST", body: "{}" }),
      fetch(new URL("/api/not-a-mock-route", empty.url)), fetch(new URL("/api/hosts/not-a-uuid/metrics", empty.url)),
    ]);
    expect(await emptyFleet.json()).toMatchObject({ hosts: [], total: 0, online: 0 });
    expect(await emptyIncidents.json()).toEqual([]);
    expect(failedIncidents.status).toBe(503);
    expect(liveFleet.status).toBe(200);
    expect(mutation.status).toBe(405);
    expect(missingRoute.status).toBe(404);
    expect(invalidHost.status).toBe(400);
  } finally {
    await Promise.all([empty.stop(true), outage.stop(true)]);
  }
});

test("dashboard mock refuses production before opening a listener", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../tools/mock-dashboard.ts", import.meta.url).pathname], {
    env: { NODE_ENV: "production" }, stdout: "ignore", stderr: "pipe",
  });
  expect(await new Response(child.stderr).text()).toContain("Dashboard mock cannot run in production");
  expect(await child.exited).not.toBe(0);
});
