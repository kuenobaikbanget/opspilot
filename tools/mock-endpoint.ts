const port = Number(process.env.MOCK_ENDPOINT_PORT || 4101);
let mode: "healthy" | "degraded" = "healthy";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      if (mode === "degraded") {
        return Response.json(
          { ok: false, service: "storefront-api", status: "degraded", reason: "Simulated upstream overload" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { ok: true, service: "storefront-api", status: "healthy", uptimeSeconds: Math.floor(process.uptime()) },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname === "/mode" && req.method === "POST") {
      mode = mode === "healthy" ? "degraded" : "healthy";
      return Response.json({ mode });
    }
    return Response.json({ service: "storefront-api", mode, healthPath: "/health" });
  },
});

console.log(`Mock project endpoint listening on http://127.0.0.1:${server.port}/health`);
