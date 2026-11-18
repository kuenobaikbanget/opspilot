import { validateEndpointTargetUrl } from "@opspilot/contracts";

export type EndpointProbeResult = {
  status: "up" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
};

/** Executes a bounded, redirect-free HTTP probe after revalidating target egress policy. */
export async function probeEndpointTarget(
  targetUrl: string,
  expectedStatus: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndpointProbeResult> {
  const allowLoopbackMock =
    env.NODE_ENV !== "production" && env.OPSPILOT_ALLOW_LOOPBACK_PROBES === "true";
  const safeUrl = validateEndpointTargetUrl(targetUrl, { allowLoopbackMock });
  if (!safeUrl) {
    return { status: "down", httpStatus: null, latencyMs: null, error: "blocked_target" };
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(safeUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel().catch(() => {});
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (response.status >= 300 && response.status < 400) {
      return { status: "down", httpStatus: response.status, latencyMs, error: "redirect_blocked" };
    }
    const ok = response.status === expectedStatus;
    return {
      status: ok ? "up" : "down",
      httpStatus: response.status,
      latencyMs,
      error: ok ? null : `http_${response.status}`,
    };
  } catch (cause) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const isTimeout =
      cause instanceof DOMException &&
      (cause.name === "TimeoutError" || cause.name === "AbortError");
    return {
      status: "down",
      httpStatus: null,
      latencyMs,
      error: isTimeout ? "timeout" : "connection_failed",
    };
  }
}
