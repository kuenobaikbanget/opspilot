import { useEffect, useId, useState } from "react";
import { SYSTEMD_STALE_AFTER_SECONDS, type HostSystemdStatus } from "@opspilot/contracts";
import { api, ApiError } from "../lib/api";
import { Badge } from "./ui";

export const systemdStates = {
  running: { label: "Running", tone: "success" },
  stopped: { label: "Stopped", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
} as const;

export const systemdCollection = {
  observed: "Report received",
  disabled: "Collection disabled · No unit configured",
  unsupported: "Unsupported · No systemd system manager or systemctl",
  unavailable: "Collection unavailable · Check local configuration and access",
} as const;

export function isSystemdReportCurrent(
  status: HostSystemdStatus | null | undefined,
  expired = false,
  failed = false,
) {
  return Boolean(status?.report?.current && !expired && !failed);
}

export function HostSystemd({ hostId, refreshKey }: { hostId: string; refreshKey: number }) {
  const titleId = useId();
  const [result, setResult] = useState<HostSystemdStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let active = true;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const next: HostSystemdStatus = await api(`/hosts/${hostId}/services`);
        if (!active) return;
        setResult(next);
        setFailed(false);
        setExpired(false);
      } catch (cause) {
        if (active && !(cause instanceof ApiError && cause.status === 401)) setFailed(true);
      } finally {
        pending = false;
      }
    }
    void load();
    const poll = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [hostId, refreshKey]);

  useEffect(() => {
    if (!result?.report?.current) return;
    const remaining = SYSTEMD_STALE_AFTER_SECONDS * 1000 + Date.parse(result.report.observed_at) - Date.parse(result.checked_at);
    const expiry = window.setTimeout(() => setExpired(true), remaining + 1);
    return () => window.clearTimeout(expiry);
  }, [result]);

  const { report, service, online } = result ?? {};
  const current = isSystemdReportCurrent(result, expired, failed);
  const fresh = service?.freshness === "fresh" && current;
  return (
    <section className="host-systemd" aria-labelledby={titleId}>
      <h3 id={titleId}>systemd status</h3>
      {!result && !failed && <p className="muted small" role="status">Loading service status…</p>}
      {failed ? (
        <p className="muted small" role="status">Service refresh failed. {service ? "Showing the last received observation." : "Service status is unavailable."}</p>
      ) : result && (
        !report ? <p className="muted small">Not reported{online ? "" : " · Agent offline"}. This agent may not support systemd reporting.</p>
          : report.status !== "observed" && <p className="muted small">{current ? "" : online ? "Last report · " : "Agent offline · Last report: "}{systemdCollection[report.status]}.</p>
      )}
      {service && (
        <div className="host-systemd-observation">
          <strong>{service.name}</strong>
          <Badge tone={fresh ? systemdStates[service.state].tone : "neutral"} dot>{systemdStates[service.state].label}</Badge>
          <span className="tiny">{fresh ? "Fresh" : !failed && !online ? "Stale · Agent offline" : "Stale"} · Observed <time dateTime={service.observed_at}>{new Date(service.observed_at).toLocaleString()}</time></span>
        </div>
      )}
      <p className="tiny">Agent-reported unit state, not endpoint reachability.</p>
    </section>
  );
}
