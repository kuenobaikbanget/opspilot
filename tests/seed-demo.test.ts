import { test, expect } from "bun:test";

for (const scenario of [
  {
    name: "production database",
    env: { NODE_ENV: "production", DATABASE_URL: "postgres://127.0.0.1:1/demo" },
    reason: "Demo seeding is disabled in production",
  },
  {
    name: "non-loopback database",
    env: { NODE_ENV: "development", DATABASE_URL: "postgres://example.invalid/demo" },
    reason: "Demo seeding requires a loopback PostgreSQL connection",
  },
]) {
  test(`demo seed refuses ${scenario.name} before connecting`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../tools/seed-demo.ts", import.meta.url).pathname], {
      env: { PATH: process.env.PATH || "", ...scenario.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain(scenario.reason);
  });
}
