"use client";

import type { AgentInstallConfig, HostList } from "@opspilot/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildAgentInstallCommand } from "../lib/agent-install";
import { AsciiCardSkeleton, AsciiLoading, usePrefersReducedMotion } from "./ascii-card-reveal";
import { Button, ButtonLink, Field, Notice, Select } from "./ui";

type Props = {
  onBack: () => void;
  onUnauthorized: () => void;
  fleet: HostList | null;
  fleetError: string;
  onRefresh: () => void;
};

type InstallConfig =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: AgentInstallConfig };

type InstallCommand = { text: string; expires: number };
type CopyStatus = "idle" | "pending" | "copied" | "failed";
type Step = 0 | 1 | 2;

const steps = [
  { title: "Configure server", summary: "Review the Hub and pinned agent release" },
  { title: "Install agent", summary: "Run the one-time command on your server" },
  { title: "Verify connection", summary: "Check agent connectivity and recent telemetry" },
] as const;

class UnauthorizedError extends Error {}

async function request<T>(path: string, signal: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(`/api/agents/${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    method,
  });
  if (response.status === 401) throw new UnauthorizedError();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function Icon({ name }: { name: "left" | "right" | "check" | "complete" | "lock" | "copy" }) {
  return (
    <svg className="onboarding-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {name === "left" && <path d="m12 19-7-7 7-7M5 12h14" />}
      {name === "right" && <path d="M5 12h14m-7-7 7 7-7 7" />}
      {name === "check" && <path d="m5 12 4 4L19 6" />}
      {name === "complete" && <><circle cx="12" cy="12" r="10" /><path d="m8 12 2.5 2.5L16 9" /></>}
      {name === "lock" && <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>}
      {name === "copy" && <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>}
    </svg>
  );
}

const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Inline single-character braille spinner for terminal-style waiting states. */
function BrailleSpinner() {
  const reducedMotion = usePrefersReducedMotion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setFrame(current => (current + 1) % brailleFrames.length);
    }, 90);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    <span className="onboarding-contact-spinner" aria-hidden="true">
      {brailleFrames[reducedMotion ? 0 : frame]}
    </span>
  );
}

export function ServerOnboarding({ onBack, onUnauthorized, fleet, fleetError, onRefresh }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [installConfig, setInstallConfig] = useState<InstallConfig>({ status: "loading" });
  const [configRetry, setConfigRetry] = useState(0);
  const [command, setCommand] = useState<InstallCommand | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [commandExpired, setCommandExpired] = useState(false);
  const [installBaseline, setInstallBaseline] = useState<number | null>(null);
  const [selectedHostId, setSelectedHostId] = useState("");
  const [verifyAfter, setVerifyAfter] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const activeHeading = useRef<HTMLHeadingElement>(null);
  const pageActive = useRef(false);
  const generation = useRef(0);
  const tokenRequest = useRef<AbortController | null>(null);
  const configRequest = useRef<AbortController | null>(null);
  const commandRef = useRef<InstallCommand | null>(null);
  const unauthorizedCallback = useRef(onUnauthorized);
  unauthorizedCallback.current = onUnauthorized;
  const id = useId();

  const invalidateCommand = useCallback(() => {
    generation.current++;
    tokenRequest.current?.abort();
    tokenRequest.current = null;
    commandRef.current = null;
  }, []);

  const clearCommand = useCallback(() => {
    invalidateCommand();
    setCommand(null);
    setGenerating(false);
    setGenerationError("");
    setCopyStatus("idle");
    setCommandExpired(false);
  }, [invalidateCommand]);

  const leave = useCallback(() => {
    pageActive.current = false;
    configRequest.current?.abort();
    clearCommand();
  }, [clearCommand]);

  const unauthorized = useCallback(() => {
    leave();
    unauthorizedCallback.current();
  }, [leave]);

  useEffect(() => {
    pageActive.current = true;
    window.addEventListener("pagehide", clearCommand);
    return () => {
      pageActive.current = false;
      window.removeEventListener("pagehide", clearCommand);
      invalidateCommand();
    };
  }, [clearCommand, invalidateCommand]);

  useEffect(() => {
    const controller = new AbortController();
    configRequest.current = controller;
    void request<AgentInstallConfig>("install-config", controller.signal)
      .then(value => {
        if (pageActive.current && !controller.signal.aborted) setInstallConfig({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (!pageActive.current || controller.signal.aborted) return;
        if (error instanceof UnauthorizedError) unauthorized();
        else setInstallConfig({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [configRetry, unauthorized]);

  useEffect(() => {
    activeHeading.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!command) return;
    const timer = window.setTimeout(() => {
      if (commandRef.current !== command) return;
      clearCommand();
      setCommandExpired(true);
    }, Math.max(0, command.expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [clearCommand, command]);

  useEffect(() => {
    if (step !== 2) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  async function generateCommand() {
    if (!pageActive.current || installConfig.status !== "ready" || tokenRequest.current) return;
    clearCommand();
    setInstallBaseline(null);
    const current = generation.current;
    const controller = new AbortController();
    tokenRequest.current = controller;
    const startedAt = Date.now();
    setGenerating(true);
    try {
      const result = await request<{ token: string; expiresInSeconds: number }>("enrollment-token", controller.signal, "POST");
      if (generation.current !== current) return;
      // The response carries a TTL, not an absolute timestamp. Start the browser timer before issuance.
      const expires = startedAt + result.expiresInSeconds * 1000;
      if (Date.now() >= expires) {
        setCommandExpired(true);
        return;
      }
      const next = { text: buildAgentInstallCommand(installConfig.value, result.token), expires };
      commandRef.current = next;
      setCommand(next);
      const observed = Date.parse(fleet?.observed_at ?? "");
      setInstallBaseline(Number.isFinite(observed) ? observed : startedAt);
    } catch (error) {
      if (generation.current !== current) return;
      if (error instanceof UnauthorizedError) unauthorized();
      else setGenerationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === current) {
        tokenRequest.current = null;
        setGenerating(false);
      }
    }
  }

  async function copyCommand() {
    const secret = commandRef.current;
    if (!pageActive.current || !secret || copyStatus === "pending") return;
    if (Date.now() >= secret.expires) {
      clearCommand();
      setCommandExpired(true);
      return;
    }
    setCopyStatus("pending");
    try {
      await navigator.clipboard.writeText(secret.text);
      if (commandRef.current === secret && Date.now() < secret.expires) setCopyStatus("copied");
    } catch {
      if (commandRef.current === secret && Date.now() < secret.expires) setCopyStatus("failed");
    }
  }

  function backToHosts() {
    leave();
    onBack();
  }

  function goTo(next: Step) {
    if (next === step) return;
    if (next === 1) void generateCommand();
    else clearCommand();
    setStep(next);
    setSelectedHostId("");
    if (next === 2) {
      const observed = Date.parse(fleet?.observed_at ?? "");
      setVerifyAfter(Number.isFinite(observed) ? observed : null);
      setNow(Date.now());
      onRefresh();
    }
  }

  const loopback = installConfig.status === "ready" && installConfig.value.mode === "loopback-development";
  const observedAt = Date.parse(fleet?.observed_at ?? "");
  const staleAfter = (fleet?.stale_after_seconds ?? 0) * 1000;
  const fleetCurrent = !fleetError && Number.isFinite(observedAt) && now - observedAt <= staleAfter
    && (verifyAfter === null || observedAt > verifyAfter);
  const selectedHost = fleet?.hosts.find(host => host.id === selectedHostId);
  // A new enrollment is a cue to verify, not proof it used this command.
  const newHostListed = installBaseline !== null && Boolean(fleet?.hosts.some(host => Date.parse(host.created_at) > installBaseline));
  const waitingForAgent = installBaseline !== null && !newHostListed && !commandExpired && !fleetError;
  const canContinueToVerification = installBaseline !== null && !generating && newHostListed;

  useEffect(() => {
    if (step !== 1 || installBaseline === null || newHostListed || commandExpired || fleetError) return;
    const timer = window.setInterval(() => onRefresh(), 3000);
    return () => window.clearInterval(timer);
  }, [step, installBaseline, newHostListed, commandExpired, fleetError, onRefresh]);
  const sampledAt = Date.parse(selectedHost?.sampled_at ?? "");
  const verificationReason = fleetError ? "Fleet data is unavailable. Refresh the fleet to continue."
    : !fleetCurrent ? "Waiting for a current fleet observation."
    : !fleet?.hosts.length ? "No enrolled hosts found. If the install succeeded, wait for the agent to appear and refresh the fleet."
    : !selectedHost ? (selectedHostId ? "This host is no longer listed. Select another host." : loopback ? "Select this machine from the host list." : "Select the server where you ran the installer.")
    : selectedHost.status !== "online" ? "The selected agent was offline at the last fleet update."
    : !Number.isFinite(sampledAt) ? "The selected agent has not sent telemetry yet."
    : sampledAt > observedAt ? "The sample timestamp is later than the fleet observation. Refresh the fleet to check again."
    : Math.max(now, observedAt) - sampledAt > staleAfter ? "The last telemetry sample is stale. Wait for a fresh sample."
    : null;

  return (
    <section className="onboarding" aria-labelledby={`${id}-title`}>
      <ButtonLink href="/hosts" size="sm" className="onboarding-back" onNavigate={leave}><Icon name="left" /> Back to Hosts</ButtonLink>
      <header className="onboarding-header">
        <h1 id={`${id}-title`}>Connect server</h1>
        <p>{loopback ? "Run the OpsPilot agent on this Linux machine and check that the local Hub receives telemetry." : "Install the OpsPilot agent on a Linux server and check that the Hub receives telemetry."}</p>
      </header>

      <ol className="onboarding-progress" role="list" aria-label="Server setup progress">
        {steps.map(({ title }, index) => {
          const state = index === step ? "active" : index < step ? "complete" : "upcoming";
          return (
            <li key={title} className="onboarding-progress-item" data-state={state} aria-current={state === "active" ? "step" : undefined}>
              <span className="onboarding-progress-marker" aria-hidden="true">{state === "complete" ? <Icon name="check" /> : index + 1}</span>
              <div><span>{title}</span><span className="onboarding-step-status">{state === "active" ? "In progress" : state === "complete" ? "Complete" : "Upcoming"}</span></div>
            </li>
          );
        })}
      </ol>

      <ol className="onboarding-steps" role="list" aria-label="Server setup steps">
        {steps.map(({ title, summary }, index) => {
          const active = index === step;
          const complete = index < step;
          return (
            <li key={title} className="onboarding-step" data-state={active ? "active" : complete ? "complete" : "upcoming"}>
              <div className="onboarding-step-header">
                {!active && <span className="onboarding-step-number"><Icon name={complete ? "complete" : "lock"} /></span>}
                <div>
                  <h2 ref={active ? activeHeading : undefined} tabIndex={active ? -1 : undefined}>{index + 1}. {title}</h2>
                  {!active && <p className="onboarding-step-status">{complete ? (index === 0 ? "Installation configuration reviewed" : "Install command generated") : loopback && index === 1 ? "Run the one-time command on this machine" : summary}</p>}
                </div>
                {!active && complete && <Button size="sm" onClick={() => goTo(index === 0 ? 0 : 1)}>Review<span className="sr-only"> {title.toLowerCase()} step</span></Button>}
              </div>

              {active && index === 0 && (
                <div className="onboarding-step-body">
                  {installConfig.status === "ready" && (loopback ? (
                    <>
                      <Notice tone="warning">Development only. Run from a trusted OpsPilot checkout on the Hub machine, not on a remote server or in a container.</Notice>
                      <p>Requires amd64 or arm64 Linux, Bash, curl, CA certificates, tar, awk, and sha256sum. No sudo or systemd.</p>
                    </>
                  ) : (
                    <>
                      <p>Choose the Linux server you want to connect. Run the installer there yourself as root or with sudo. OpsPilot does not open an SSH session.</p>
                      <p>Requires amd64 or arm64 Linux with running systemd, Bash, curl, and CA certificates. The server must be able to reach the Hub over HTTPS.</p>
                    </>
                  ))}
                  {installConfig.status === "loading" && <AsciiLoading id={`${id}-config-status`} label="Loading installation configuration…" />}
                  {installConfig.status === "error" && (
                    <>
                      <Notice id={`${id}-config-status`} tone="warning" role="alert">
                        {installConfig.message}. Install commands are unavailable until the Hub configuration can be loaded. Manual enrollment remains available.
                      </Notice>
                      <div className="onboarding-inline-actions">
                        <Button size="sm" onClick={() => { setInstallConfig({ status: "loading" }); setConfigRetry(retry => retry + 1); }}>Retry configuration</Button>
                      </div>
                    </>
                  )}
                  {installConfig.status === "ready" && (
                    <dl className="onboarding-details">
                      <div><dt>Hub address</dt><dd>{installConfig.value.hubUrl}</dd></div>
                      <div><dt>Pinned release</dt><dd>{installConfig.value.version}</dd></div>
                    </dl>
                  )}
                  <div className="onboarding-actions">
                    <ButtonLink href="/hosts" size="sm" onNavigate={leave}>Cancel</ButtonLink>
                    <Button variant="primary" size="sm" disabled={installConfig.status !== "ready"} aria-describedby={installConfig.status !== "ready" ? `${id}-config-status` : undefined} onClick={() => goTo(1)}>Continue to installation <Icon name="right" /></Button>
                  </div>
                </div>
              )}

              {active && index === 1 && (
                <div className="onboarding-step-body">
                  <p>{loopback
                    ? "Run the command in Bash from the root of your OpsPilot checkout as a regular user. Keep the agent running while you verify. Ctrl+C stops it and removes its temporary local state."
                    : "Copy the command and run it in Bash on the intended server. The installer verifies the pinned release archive and starts a non-root systemd service."}</p>
                  {installConfig.status === "ready" && (
                    <dl className="onboarding-details">
                      <div><dt>Hub address</dt><dd>{installConfig.value.hubUrl}</dd></div>
                      <div><dt>Pinned release</dt><dd>{installConfig.value.version}</dd></div>
                    </dl>
                  )}
                  <div className="onboarding-terminal">
                    <div className="onboarding-terminal-header">
                      <span>Bash</span>
                      <Button size="sm" disabled={!command} loading={copyStatus === "pending"} aria-describedby={!command ? `${id}-command-status` : undefined} onClick={() => void copyCommand()}><Icon name="copy" /> Copy install command</Button>
                    </div>
                    {command ? (
                      <pre tabIndex={0} aria-label="Install command"><code>{command.text}</code></pre>
                    ) : (
                      <p id={`${id}-command-status`} role="status">{generating ? "Preparing your install command…" : commandExpired ? "Command expired. Generate another if you still need to install." : generationError ? "Install command unavailable." : "Install command not generated yet."}</p>
                    )}
                  </div>
                  {command && <p className="onboarding-caption">Use once before approximately <time dateTime={new Date(command.expires).toISOString()}>{new Date(command.expires).toLocaleTimeString()}</time>. Regenerating the command won’t revoke this token or clear it from your clipboard or shell history.</p>}
                  <div className="onboarding-inline-actions">
                    <Button size="sm" loading={generating} disabled={installConfig.status !== "ready"} onClick={() => void generateCommand()}>{generationError ? "Retry command" : "Regenerate command"}</Button>
                    {copyStatus === "copied" && <span className="onboarding-caption" role="status">Install command copied.</span>}
                  </div>
                  {generationError && <Notice tone="danger" role="alert">{generationError}. Try generating the install command again.</Notice>}
                  {copyStatus === "failed" && <Notice tone="warning" role="alert">Clipboard unavailable. Select and copy the install command manually.</Notice>}
                  {installBaseline !== null && (
                    <div className="onboarding-contact-status" id={`${id}-contact-status`} role="status">
                      {!fleetError && !newHostListed && !commandExpired && <BrailleSpinner />}
                      <span>{fleetError ? "Can’t check for new agents. Refresh the fleet to keep waiting."
                        : newHostListed ? "A new host appeared in the fleet. Verify its hostname in the next step."
                        : commandExpired ? "No new host observed. Check the installation or regenerate the command."
                        : "Waiting for an agent to contact the Hub…"}</span>
                      {fleetError && <Button size="sm" onClick={onRefresh}>Refresh fleet</Button>}
                    </div>
                  )}
                  <div className="onboarding-actions">
                    <Button size="sm" onClick={() => goTo(0)}><Icon name="left" /> Back</Button>
                    <Button
                      variant="primary"
                      size="sm"
                      className={!canContinueToVerification ? "onboarding-verify-button onboarding-verify-button--waiting" : "onboarding-verify-button"}
                      loading={waitingForAgent || generating}
                      disabled={!canContinueToVerification}
                      aria-describedby={installBaseline !== null ? `${id}-contact-status` : undefined}
                      onClick={() => goTo(2)}
                    >
                      {canContinueToVerification ? (
                        <>Continue to verification <Icon name="right" /></>
                      ) : (
                        <>
                          <AsciiCardSkeleton
                            as="span"
                            variant="terminal"
                            lines={1}
                            widths={["18ch"]}
                            animate={waitingForAgent || generating}
                            className="onboarding-button-matrix"
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {generating
                              ? "Preparing install command"
                              : commandExpired
                                ? "Install command expired. Regenerate the command and connect a server to continue."
                                : generationError
                                  ? "Install command unavailable. Retry generating the command to continue."
                                  : fleetError
                                    ? "Fleet unavailable. Refresh the fleet to detect a connected server."
                                    : waitingForAgent
                                      ? "Waiting for target server to connect"
                                      : "Generate an install command and connect a server to continue."}
                          </span>
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {active && index === 2 && (
                <div className="onboarding-step-body">
                  <p>{loopback ? "While the agent is running, select this machine by hostname or agent ID." : "Select the server where you ran the installer. Match its hostname and, if there are duplicates, the agent ID."} The fleet does not link hosts to the one-time command.</p>
                  {fleetError && <Notice tone="warning" role="alert">{fleetError}</Notice>}
                  <div className="onboarding-host-picker">
                    <Field id={`${id}-host`} label="Installed server">
                      <Select id={`${id}-host`} value={selectedHostId} disabled={!fleetCurrent || !fleet?.hosts.length} aria-describedby={`${id}-verification-status`} onChange={event => setSelectedHostId(event.currentTarget.value)}>
                        <option value="">Select an enrolled host</option>
                        {selectedHostId && !selectedHost && <option value={selectedHostId} disabled>Previously selected host is no longer listed</option>}
                        {fleet?.hosts.map(host => <option value={host.id} key={host.id}>{host.hostname} · {host.id}</option>)}
                      </Select>
                    </Field>
                    <Button size="sm" onClick={onRefresh}>Refresh fleet</Button>
                  </div>
                  {selectedHost && (
                    <dl className="onboarding-details">
                      <div><dt>Agent state{fleetCurrent ? "" : " (last observed)"}</dt><dd>{selectedHost.status === "online" ? "Online" : "Offline"}</dd></div>
                      {([
                        ["Last contact", selectedHost.last_seen_at],
                        ["Latest telemetry", selectedHost.sampled_at],
                      ] as const).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : "Not observed"}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!fleet && !fleetError
                    ? <AsciiLoading id={`${id}-verification-status`} label="Waiting for a current fleet observation." />
                    : <p id={`${id}-verification-status`} role="status">{verificationReason ?? "The selected agent is online and has sent fresh telemetry."}</p>}
                  <div className="onboarding-actions">
                    <Button size="sm" onClick={() => goTo(1)}><Icon name="left" /> Back</Button>
                    <Button variant="primary" size="sm" disabled={verificationReason !== null} aria-describedby={`${id}-verification-status`} onClick={backToHosts}>Finish <Icon name="check" /></Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
