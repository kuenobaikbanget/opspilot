import { expect, test } from "bun:test";

async function scenario(name: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../apps/web/test-fixtures/services-ui.tsx", import.meta.url).pathname, name], {
    env: { PATH: process.env.PATH || "", NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Services UI scenario ${name} failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

// Phrases that would attribute a failure to another signal without evidence.
const causalityClaims = /\b(caused by|because of|due to|root cause:|the host (is|was) (causing|responsible))\b/i;

test("services reference case separates host CPU, process state and a fresh 503 endpoint, with no causality claims", async () => {
  const { initial, inspected, afterCheck, requests } = await scenario("reference");

  // Workload panel: measured process state with source time, distinct from endpoint checks.
  expect(initial.workloads).toContain("storefront-api.service");
  expect(initial.workloads).toContain("Running");
  expect(initial.workloads).toContain("Fresh");
  expect(initial.workloads).toContain("not endpoint reachability");

  // Endpoint list: distinct identities with truthful freshness; stale keeps its historical outcome.
  expect(initial.endpointPanel).toContain("1 up · 1 down · 1 pending · 1 stale of 4 configured");
  expect(initial.endpointPanel).toContain("Down · HTTP 503");
  expect(initial.endpointPanel).toContain("Pending");
  expect(initial.endpointPanel).toContain("Stale, last result Up · HTTP 200");
  expect(initial.endpointPanel).toContain("Probe hub-local");

  // Endpoint investigation: observed vs expected, probe location, check time, no root cause inferred.
  expect(inspected.pressed.join(" ")).toContain("storefront-api");
  expect(inspected.inspector).toContain("storefront-api");
  expect(inspected.inspector).toContain("Down · HTTP 503");
  expect(inspected.inspector).toContain("HTTP 200"); // expected response
  expect(inspected.inspector).toContain("hub-local");
  expect(inspected.inspector).toContain("Last checked");
  expect(inspected.inspector).toContain("No root cause inferred");
  expect(inspected.inspector).toContain("not causality");
  expect(inspected.inspector).not.toMatch(causalityClaims);
  expect(inspected.pageText).not.toMatch(causalityClaims);

  // Check now runs a real POST and the refreshed result stops being stale.
  expect(requests).toContain("POST /api/endpoints/e0000000-0000-4000-8000-000000000004/check");
  expect(afterCheck.endpointPanel).toContain("2 up · 1 down · 1 pending · 0 stale of 4 configured");
});

test("an offline agent keeps its own historical state while its endpoint stays independently up", async () => {
  const { scoped, inspected } = await scenario("offline-endpoint-up");

  // Host workload panel for backup-01: agent offline, retained observation explicitly stale.
  expect(scoped.workloads).toContain("Agent offline");
  expect(scoped.workloads).toContain("Stale");
  expect(scoped.workloads).toContain("backup-web.service");

  // Scoped to backup-01: the endpoint count uses the scoped identity, not list-page length.
  expect(scoped.endpointPanel).toContain("backup-01: 1 up · 0 down · 0 pending · 0 stale of 1 configured");
  expect(scoped.endpointPanel).toContain("backup-01 · Agent offline");

  // Inspector states independence explicitly and still infers no root cause.
  expect(inspected.inspector).toContain("Up · HTTP 200");
  expect(inspected.inspector).toContain("The agent for backup-01 is offline");
  expect(inspected.inspector).toContain("not from the agent");
  expect(inspected.inspector).toContain("No root cause inferred");
  expect(inspected.pageText).not.toMatch(causalityClaims);
});

test("not-configured, confirmed empty and unavailable endpoint lists stay distinct", async () => {
  const notConfigured = await scenario("not-configured");
  expect(notConfigured.endpointPanel).toContain("No endpoint monitors are configured for backup-01");
  expect(notConfigured.endpointPanel).not.toContain("No endpoint monitors configured.");

  const empty = await scenario("empty");
  expect(empty.endpointPanel).toContain("No endpoint monitors configured.");

  const { failed, recovered } = await scenario("error");
  expect(failed.endpointPanel).toContain("Endpoint monitors are unavailable");
  expect(failed.endpointPanel).toContain("Fixture endpoints outage");
  expect(failed.endpointPanel).not.toContain("of 4 configured");
  expect(recovered.endpointPanel).toContain("1 up · 1 down · 1 pending · 1 stale of 4 configured");
});

test("a failed host service read reports unavailable instead of a process state", async () => {
  const { workloads } = await scenario("host-services-error");
  expect(workloads).toContain("Service refresh failed");
  expect(workloads).toContain("Service status is unavailable");
  expect(workloads).not.toContain("Running");
});

test("a failed Check now surfaces the error, keeps the last result and re-enables the control", async () => {
  const { inspector, alerts, checkButtonDisabled, requests } = await scenario("check-failure");
  expect(requests).toContain("POST /api/endpoints/e0000000-0000-4000-8000-000000000001/check");
  expect(alerts.join(" ")).toContain("Fixture check outage");
  expect(inspector).toContain("Down · HTTP 503"); // retained, labeled by its own check time
  expect(inspector).toContain("No root cause inferred");
  expect(checkButtonDisabled).toBe(false);
});

test("add service refuses to save an empty form and exposes only the hub-local probe location", async () => {
  const { probeField, alerts, posts } = await scenario("add-service-empty");
  expect(probeField).toEqual({ value: "hub-local", readOnly: true });
  expect(alerts.join(" ")).toContain("Endpoint name (1–80 characters) is required.");
  expect(posts).toEqual([]);
});
