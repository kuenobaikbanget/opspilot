import { expect, test } from "bun:test";

for (const scenario of [
  {
    name: "production environment",
    env: { NODE_ENV: "production", DATABASE_URL: "postgres://127.0.0.1:5432/opspilot" },
    reason: "Mock agent seeding is disabled in production",
  },
  {
    name: "non-loopback database",
    env: { NODE_ENV: "development", DATABASE_URL: "postgres://example.invalid/opspilot" },
    reason: "Mock agent seeding requires a loopback PostgreSQL connection",
  },
  {
    name: "non-loopback hub URL",
    env: {
      NODE_ENV: "development",
      DATABASE_URL: "postgres://127.0.0.1:5432/opspilot",
      MOCK_HUB_URL: "https://hub.example.invalid",
    },
    reason: "Mock agent connections require a loopback HTTP(S) Hub URL",
  },
]) {
  test(`mock-agents refuses ${scenario.name} before connecting`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../tools/mock-agents.ts", import.meta.url).pathname], {
      env: { PATH: process.env.PATH || "", ...scenario.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain(scenario.reason);
  });
}
