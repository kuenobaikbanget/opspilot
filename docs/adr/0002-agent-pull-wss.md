# ADR-0002: Agent-initiated WSS and read-only tools

- Status: Accepted
- Context: Small VPS/homelab hosts should not expose inbound SSH or new agent API ports.
- Decision: Agent enrolls once over HTTPS, persists a 256-bit credential, initiates WSS outbound, sends metrics and receives enumerated diagnostic requests. Each request has ID, timeout and local service allowlist.
- Consequences: NAT-friendly, no SSH credentials in Hub. Agent offline means no live checks; add durable queue/reconnect for telemetry in future. Agent credentials must be rotated/revoked eventually.
- Rejected alternatives: inbound SSH as primary transport; remotely executing arbitrary shell; hub polling an open inbound agent port.
