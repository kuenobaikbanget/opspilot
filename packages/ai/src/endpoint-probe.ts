import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateEndpointTargetUrl } from "@opspilot/contracts";
import { isAllowedProbeAddress, resolvePinnedAddress, type PinnedAddress } from "./egress";

export const PROBE_MAX_REDIRECTS = 5;
export const PROBE_TOTAL_TIMEOUT_MS = 5000;
export const PROBE_CONNECT_TIMEOUT_MS = 3000;
export const PROBE_MAX_HEADER_BYTES = 16 * 1024;
/** Response bodies are never stored; reads stop after this cap. */
export const PROBE_MAX_BODY_BYTES = 256 * 1024;

export type EndpointProbeResult = {
  status: "up" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
};

/** Injection exists only in code for isolated tests; never via runtime configuration. */
export type EndpointProbeDeps = {
  resolve?: typeof lookup;
  totalTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
};

type HopResult =
  | { kind: "response"; status: number; location: string | null }
  | { kind: "error"; error: string };

/** One bounded GET against the pinned address; the lookup callback always returns it. */
function requestOnce(
  target: URL,
  pinned: PinnedAddress,
  bounds: { totalTimeoutMs: number; connectTimeoutMs: number },
): Promise<HopResult> {
  const { promise, resolve } = Promise.withResolvers<HopResult>();
  const isHttps = target.protocol === "https:";
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  let req: ClientRequest | undefined;
  let settled = false;
  let connectTimer: NodeJS.Timeout | undefined;
  const finish = (result: HopResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(totalTimer);
    clearTimeout(connectTimer);
    resolve(result);
  };
  const totalTimer = setTimeout(() => {
    req?.destroy();
    finish({ kind: "error", error: "timeout" });
  }, bounds.totalTimeoutMs);
  const options: RequestOptions & { autoSelectFamily: false } = {
    method: "GET",
    agent: false,
    family: pinned.family,
    autoSelectFamily: false,
    rejectUnauthorized: true,
    servername: isIP(hostname) ? undefined : hostname,
    maxHeaderSize: PROBE_MAX_HEADER_BYTES,
    headers: {
      accept: "*/*",
      "accept-encoding": "identity",
      "user-agent": "opspilot-endpoint-probe/1.0",
    },
    lookup: (_host, lookupOptions, callback) => {
      if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    },
  };
  req = (isHttps ? httpsRequest : httpRequest)(target, options, (res: IncomingMessage) => {
    const status = res.statusCode ?? 0;
    const location = res.headers.location ?? null;
    let read = 0;
    // Status is known at headers; the body is read only up to the cap, never stored.
    res.on("data", (chunk: Buffer) => {
      read += chunk.length;
      if (read > PROBE_MAX_BODY_BYTES) {
        res.destroy();
        finish({ kind: "response", status, location });
      }
    });
    res.on("end", () => finish({ kind: "response", status, location }));
    res.on("aborted", () => finish({ kind: "response", status, location }));
    res.on("error", () => finish({ kind: "response", status, location }));
  });
  req.on("socket", (socket) => {
    connectTimer = setTimeout(() => {
      req?.destroy();
      finish({ kind: "error", error: "timeout" });
    }, bounds.connectTimeoutMs);
    socket.once(isHttps ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
  });
  req.on("error", (error: NodeJS.ErrnoException) => {
    finish({ kind: "error", error: error.code === "ETIMEDOUT" ? "timeout" : "connection_failed" });
  });
  req.end();
  return promise;
}

/**
 * Executes a bounded HTTP(S) probe. The target URL and every redirect hop are
 * re-validated against the egress policy, DNS is resolved and every answer checked,
 * and the socket is pinned to one validated address (DNS-rebinding defense). Redirects
 * are followed manually up to `maxRedirects`, re-validating each hop. There is no
 * generic URL-fetch tool: this function is only called with stored monitor targets.
 */
export async function probeEndpointTarget(
  targetUrl: string,
  expectedStatus: number,
  env: NodeJS.ProcessEnv = process.env,
  deps: EndpointProbeDeps = {},
): Promise<EndpointProbeResult> {
  const allowLoopbackMock =
    env.NODE_ENV !== "production" && env.OPSPILOT_ALLOW_LOOPBACK_PROBES === "true";
  const startedAt = performance.now();
  const bounds = {
    totalTimeoutMs: deps.totalTimeoutMs ?? PROBE_TOTAL_TIMEOUT_MS,
    connectTimeoutMs: deps.connectTimeoutMs ?? PROBE_CONNECT_TIMEOUT_MS,
  };
  const maxRedirects = deps.maxRedirects ?? PROBE_MAX_REDIRECTS;
  const resolve = deps.resolve ?? lookup;
  const latency = () => Math.max(0, Math.round(performance.now() - startedAt));
  const down = (error: string, httpStatus: number | null = null): EndpointProbeResult => ({
    status: "down",
    httpStatus,
    latencyMs: latency(),
    error,
  });

  // TLS verification must never be disabled through the environment.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return down("tls_verification_disabled");

  let current: string | null = validateEndpointTargetUrl(targetUrl, { allowLoopbackMock });
  if (!current) return down("blocked_target");

  for (let hop = 0; ; hop++) {
    const parsed: URL = new URL(current);
    // Re-validate scheme/credentials/host on the initial URL and on every redirect hop.
    current = validateEndpointTargetUrl(current, { allowLoopbackMock });
    if (!current) return down(hop === 0 ? "blocked_target" : "redirect_blocked");
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    let pinned: PinnedAddress;
    if (isIP(hostname)) {
      if (!isAllowedProbeAddress(hostname, { allowLoopback: allowLoopbackMock })) {
        return down(hop === 0 ? "blocked_target" : "redirect_blocked");
      }
      pinned = { address: hostname, family: isIP(hostname) === 6 ? 6 : 4 };
    } else {
      const resolved = await resolvePinnedAddress(hostname, resolve, { allowLoopback: allowLoopbackMock });
      if (!resolved) return down(hop === 0 ? "dns_blocked" : "redirect_blocked");
      pinned = resolved;
    }

    const result = await requestOnce(parsed, pinned, bounds);
    if (result.kind === "error") return down(result.error);
    const { status, location } = result;
    if (status >= 300 && status < 400 && location) {
      if (hop >= maxRedirects) return down("redirect_limit", status);
      try {
        current = new URL(location, parsed).toString();
      } catch {
        return down("redirect_blocked", status);
      }
      continue;
    }
    const ok = status === expectedStatus;
    return {
      status: ok ? "up" : "down",
      httpStatus: status,
      latencyMs: latency(),
      error: ok ? null : `http_${status}`,
    };
  }
}
