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
  const { initial, incidentList } = await scenario("cold-failure");
  expect(initial.protectedVisible).toBe(true);
  expect(initial.loginVisible).toBe(false);
  expect(initial.incidentCount).toContain("Unavailable");
  expect(initial.alerts.join(" ")).toContain("Fixture incident failure");
  expect(initial.relatedIncident).not.toContain("No open incident");
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
  const { initial, cached, recovered } = await scenario("cached-failure");
  expect(initial.incidentCount).toBe("1");
  expect(cached.incidentCount).toBe("1");
  expect(cached.incidentContext).toContain("cached");
  expect(cached.relatedIncident).toContain("Fixture CPU incident");
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
