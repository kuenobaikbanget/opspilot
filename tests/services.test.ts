import { expect, test } from "bun:test";
import { validateEndpointTargetUrl } from "../packages/contracts/src/index";
import { probeEndpointTarget } from "../packages/ai/src/endpoint-probe";

test("endpoint URL validation rejects unsafe schemes, credentials, metadata and private addresses", () => {
  expect(validateEndpointTargetUrl("file:///etc/passwd")).toBeNull();
  expect(validateEndpointTargetUrl("https://user:pass@example.com/health")).toBeNull();
  expect(validateEndpointTargetUrl("https://example.com/health#frag")).toBeNull();
  expect(validateEndpointTargetUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
  expect(validateEndpointTargetUrl("https://metadata.google.internal/computeMetadata/v1/")).toBeNull();
  expect(validateEndpointTargetUrl("https://10.0.0.5/health")).toBeNull();
  expect(validateEndpointTargetUrl("https://192.168.1.10/health")).toBeNull();
  expect(validateEndpointTargetUrl("http://example.com/health")).toBeNull();
  expect(validateEndpointTargetUrl("http://127.0.0.1:4101/health")).toBeNull();
  expect(validateEndpointTargetUrl("https://api.example.com/health")).toBe("https://api.example.com/health");
  expect(validateEndpointTargetUrl("http://127.0.0.1:4101/health", { allowLoopbackMock: true })).toBe(
    "http://127.0.0.1:4101/health",
  );
});

test("endpoint prober blocks disallowed targets and reports up, down and redirect_blocked accurately", async () => {
  const blocked = await probeEndpointTarget("http://169.254.169.254/latest/meta-data/", 200, {
    NODE_ENV: "development",
    OPSPILOT_ALLOW_LOOPBACK_PROBES: "true",
  });
  expect(blocked.status).toBe("down");
  expect(blocked.error).toBe("blocked_target");

  const loopbackDenied = await probeEndpointTarget("http://127.0.0.1:4101/health", 200, {
    NODE_ENV: "production",
    OPSPILOT_ALLOW_LOOPBACK_PROBES: "true",
  });
  expect(loopbackDenied.status).toBe("down");
  expect(loopbackDenied.error).toBe("blocked_target");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/ok") return new Response("ok", { status: 200 });
      if (pathname === "/fail") return new Response("err", { status: 503 });
      return Response.redirect("http://127.0.0.1:4101/ok", 302);
    },
  });
  try {
    const env = { NODE_ENV: "development", OPSPILOT_ALLOW_LOOPBACK_PROBES: "true" };
    const up = await probeEndpointTarget(`http://127.0.0.1:${server.port}/ok`, 200, env);
    expect(up.status).toBe("up");
    expect(up.httpStatus).toBe(200);
    expect(up.error).toBeNull();

    const down = await probeEndpointTarget(`http://127.0.0.1:${server.port}/fail`, 200, env);
    expect(down.status).toBe("down");
    expect(down.httpStatus).toBe(503);
    expect(down.error).toBe("http_503");

    const redirect = await probeEndpointTarget(`http://127.0.0.1:${server.port}/redir`, 200, env);
    expect(redirect.status).toBe("down");
    expect(redirect.error).toBe("redirect_blocked");
  } finally {
    await server.stop(true);
  }
});
