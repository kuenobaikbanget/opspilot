import { expect, test } from "bun:test";

async function scenario(name: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../apps/web/test-fixtures/home-ui.tsx", import.meta.url).pathname, name], {
    env: { PATH: process.env.PATH || "", NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Home UI scenario ${name} failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

test("an authenticated host dashboard stays usable when the initial incident read fails", async () => {
  const { initial, related, incidentList } = await scenario("cold-failure");
  expect(initial.protectedVisible).toBe(true);
  expect(initial.loginVisible).toBe(false);
  expect(initial.incidentCount).toContain("Unavailable");
  expect(initial.alerts.join(" ")).toContain("Fixture incident failure");
  expect(related).toContain("Related incident data is unavailable.");
  expect(incidentList).not.toContain("No incidents recorded");
});

test("incident recovery removes its own error without hiding an unrelated action failure", async () => {
  const { failed, recovered } = await scenario("recovery");
  expect(failed.alerts.join(" ")).toContain("Fixture incident failure");
  expect(failed.alerts.join(" ")).toContain("Fixture sign-out failure");
  expect(recovered.protectedVisible).toBe(true);
  expect(recovered.incidentCount).toBe("1");
  expect(recovered.alerts.join(" ")).not.toContain("Fixture incident failure");
  expect(recovered.alerts.join(" ")).toContain("Fixture sign-out failure");
});

test("a failed incident refresh retains labeled cached observations until recovery", async () => {
  const { initial, cached, related, recovered } = await scenario("cached-failure");
  expect(initial.incidentCount).toBe("1");
  expect(cached.incidentCount).toBe("1");
  expect(cached.incidentContext).toContain("cached");
  expect(related).toContain("Fixture CPU incident");
  expect(recovered.incidentCount).toBe("1");
  expect(recovered.incidentContext).not.toContain("cached");
  expect(recovered.alerts).toEqual([]);
});

test("a rejected session shows login without fetching protected dashboard data", async () => {
  const { initial, requests } = await scenario("unauthorized");
  expect(initial.protectedVisible).toBe(false);
  expect(initial.loginVisible).toBe(true);
  expect(requests).toEqual(["/api/auth/me"]);
});

test("a failed session check offers recovery without treating the outage as authentication", async () => {
  const { initial, beforeRetry, recovered } = await scenario("session-recovery");
  expect(initial.protectedVisible).toBe(false);
  expect(initial.loginVisible).toBe(false);
  expect(initial.alerts.join(" ")).toContain("Fixture session failure");
  expect(beforeRetry).toEqual(["/api/auth/me"]);
  expect(recovered.protectedVisible).toBe(true);
  expect(recovered.incidentCount).toBe("1");
  expect(recovered.alerts).toEqual([]);
});

test("session expiry removes protected observations instead of reporting an incident outage", async () => {
  const { initial, expired } = await scenario("expired-session");
  expect(initial.protectedVisible).toBe(true);
  expect(expired.protectedVisible).toBe(false);
  expect(expired.loginVisible).toBe(true);
  expect(expired.incidentCount).toBeUndefined();
});

test("when dev auth is disabled, the dashboard opens without login and omits sign out", async () => {
  const { initial, requests } = await scenario("auth-disabled");
  expect(initial.protectedVisible).toBe(true);
  expect(initial.loginVisible).toBe(false);
  expect(initial.signOutVisible).toBe(false);
  expect(requests).toContain("/api/auth/me");
});

test("overview risk card and pressure inspector display the host systemd service and fail truthfully", async () => {
  const ok = await scenario("overview-services");
  expect(ok.riskServices).toContain("mock-edge-proxy.service");
  expect(ok.riskServices).toContain("Running");
  expect(ok.inspectorSystemd).toContain("mock-edge-proxy.service");
  expect(ok.inspectorSystemd).toContain("Fresh");

  const failed = await scenario("overview-services-error");
  expect(failed.riskServices).toContain("Unavailable");
  expect(failed.riskServices).not.toContain("Running");
  expect(failed.inspectorSystemd).toContain("Service status is unavailable.");
});

test("a matching incident whose investigation detail fails is unavailable, not never run", async () => {
  const { advisory, requests } = await scenario("investigation-unavailable");
  expect(requests).toContain("/api/incidents/d0000000-0000-4000-8000-000000000002");
  expect(advisory).toContain("Could not load the incident’s investigation record.");
  expect(advisory).not.toContain("Not run");
});

test("a same-host configuration drift incident is not attached to CPU pressure", async () => {
  const { advisory, requests } = await scenario("unrelated-investigation");
  expect(advisory).toContain("No incident for this resource on this device");
  expect(requests).not.toContain("/api/incidents/d0000000-0000-4000-8000-000000000002");
});

test("host history fetches only in Hosts and aborts when leaving", async () => {
  const { onOverview, onHosts, afterLeaving, historyAborted } = await scenario("host-history-visibility");
  expect(onOverview).toBe(0);
  expect(onHosts).toBe(1);
  expect(afterLeaving).toBe(1);
  expect(historyAborted).toBe(true);
});
