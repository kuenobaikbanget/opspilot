# ADR-0001: Bun-native Hub + Bun.SQL, not Fastify in first scaffold

- Status: Accepted for starter
- Context: Bun is explicitly preferred; small product, WSS agent gateway and PostgreSQL required. A previous draft proposed Fastify.
- Decision: Use native `Bun.serve` HTTP/WebSocket and `Bun.SQL` to reduce dependencies and keep direct Bun runtime usage; retain typed modules and route separation.
- Consequences: Very small dependency footprint; explicit Bun runtime requirement. Manual routing/validation is more work; promote to Hono/Fastify only when routes/validation become unwieldy. Do not claim Fastify integration is present.
- Revisit trigger: >50 endpoints, repeated schema boilerplate, complex middlewares or broader developer collaboration.
