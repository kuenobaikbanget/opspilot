"use client";

import type { EndpointMonitor } from "@opspilot/contracts";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { Badge, Button, ButtonLink, Field, Input, Notice, Select } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { api } from "../../../lib/api";
import { useWorkspace } from "../workspace";
import { WorkspaceNotices } from "../workspace-header";

type Step = 0 | 1;

const steps = [
  { title: "Configure endpoint", summary: "Name the endpoint and set the target URL to probe" },
  { title: "Verify endpoint", summary: "Run an initial HTTP reachability check from the Hub" },
] as const;

export default function NewMonitorPage() {
  const { fleet, refresh, updateEndpoint } = useWorkspace();
  const id = useId();
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [expectedStatus, setExpectedStatus] = useState("200");
  const [agentId, setAgentId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [created, setCreated] = useState<EndpointMonitor | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const checkRequest = useRef<AbortController | null>(null);
  const checkGeneration = useRef(0);

  const hosts = fleet?.hosts ?? [];

  const abortCheck = useCallback(() => {
    checkGeneration.current += 1;
    checkRequest.current?.abort();
    checkRequest.current = null;
  }, []);

  useEffect(() => () => abortCheck(), [abortCheck]);

  async function runCheck(endpointId: string) {
    abortCheck();
    const generation = checkGeneration.current;
    const controller = new AbortController();
    checkRequest.current = controller;
    setChecking(true);
    setCheckError("");
    let aborted = false;
    try {
      const result: { endpoint: EndpointMonitor } = await api(`/endpoints/${endpointId}/check`, "POST", {}, controller.signal);
      if (controller.signal.aborted || checkGeneration.current !== generation) {
        aborted = true;
        return;
      }
      setCreated(result.endpoint);
      updateEndpoint(result.endpoint);
    } catch (cause) {
      if (controller.signal.aborted || checkGeneration.current !== generation) {
        aborted = true;
        return;
      }
      setCheckError(cause instanceof Error ? cause.message : "Endpoint check failed.");
    } finally {
      if (checkGeneration.current === generation) {
        checkRequest.current = null;
        setChecking(false);
      }
    }
    if (!aborted) {
      await refresh();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = targetUrl.trim();
    const parsedStatus = Number(expectedStatus);

    if (!trimmedName || trimmedName.length > 80) {
      setSubmitError("Endpoint name (1–80 characters) is required.");
      return;
    }
    if (!trimmedUrl) {
      setSubmitError("Target URL is required.");
      return;
    }
    if (!Number.isInteger(parsedStatus) || parsedStatus < 100 || parsedStatus > 599) {
      setSubmitError("Expected HTTP status must be an integer between 100 and 599.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const result: { endpoint: EndpointMonitor } = await api("/endpoints", "POST", {
        name: trimmedName,
        targetUrl: trimmedUrl,
        expectedStatus: parsedStatus,
        agentId: agentId || null,
        serviceName: serviceName.trim() || null,
      });
      setCreated(result.endpoint);
      setStep(1);
      void runCheck(result.endpoint.id);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Could not create endpoint monitor.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    abortCheck();
    setStep(0);
    setName("");
    setTargetUrl("");
    setExpectedStatus("200");
    setAgentId("");
    setServiceName("");
    setSubmitError("");
    setCreated(null);
    setChecking(false);
    setCheckError("");
  }

  return <>
    <WorkspaceNotices />
    <section className="onboarding" aria-labelledby={`${id}-title`}>
      <ButtonLink href="/services" size="sm" className="onboarding-back"><WorkspaceIcon name="back" />Back to Services</ButtonLink>
      <header className="onboarding-header">
        <h1 id={`${id}-title`} tabIndex={-1}>Add service</h1>
        <p>Configure an HTTP endpoint monitor probed independently from the Hub.</p>
      </header>

      <ol className="onboarding-progress" data-steps="2" aria-label="Service setup progress">
        {steps.map(({ title }, index) => {
          const state = index === step ? "active" : index < step ? "complete" : "upcoming";
          return (
            <li
              key={title}
              className="onboarding-progress-item"
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="onboarding-progress-marker" aria-hidden="true">{index + 1}</span>
              <div>
                <span>{title}</span>
                <span className="onboarding-step-status">
                  {state === "active" ? "In progress" : state === "complete" ? "Complete" : "Upcoming"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <ol className="onboarding-steps" aria-label="Service setup steps">
        <li className="onboarding-step" data-state={step === 0 ? "active" : "complete"}>
          <div className="onboarding-step-header">
            <div>
              <h2>1. Configure endpoint</h2>
              {step !== 0 && created && <p className="onboarding-step-status">{created.name} · {created.target_url}</p>}
            </div>
          </div>

          {step === 0 && (
            <form className="onboarding-step-body" onSubmit={event => void handleSubmit(event)} noValidate>
              {submitError && <Notice tone="danger" role="alert">{submitError}</Notice>}

              <div className="onboarding-form-grid">
                <Field id={`${id}-name`} label="Endpoint name" required hint="Short label shown in Services and Overview (1–80 characters).">
                  <Input
                    id={`${id}-name`}
                    value={name}
                    onChange={event => setName(event.currentTarget.value)}
                    placeholder="e.g. Public API health"
                    maxLength={80}
                    required
                    autoFocus
                  />
                </Field>

                <Field id={`${id}-url`} label="Target URL" required hint="HTTPS URL probed from the Hub. Private, loopback, and metadata addresses are blocked by default.">
                  <Input
                    id={`${id}-url`}
                    type="url"
                    value={targetUrl}
                    onChange={event => setTargetUrl(event.currentTarget.value)}
                    placeholder="https://api.example.com/health"
                    required
                  />
                </Field>

                <Field id={`${id}-status`} label="Expected HTTP status" hint="HTTP status code considered healthy (100–599).">
                  <Input
                    id={`${id}-status`}
                    type="number"
                    min={100}
                    max={599}
                    value={expectedStatus}
                    onChange={event => setExpectedStatus(event.currentTarget.value)}
                  />
                </Field>

                <Field id={`${id}-host`} label="Associated host (optional)" hint="Link this probe to an enrolled host if it checks a workload running there.">
                  <Select id={`${id}-host`} value={agentId} onChange={event => setAgentId(event.currentTarget.value)}>
                    <option value="">None (standalone endpoint)</option>
                    {hosts.map(host => (
                      <option key={host.id} value={host.id}>{host.hostname}</option>
                    ))}
                  </Select>
                </Field>

                <Field id={`${id}-service`} label="Service name (optional)" hint="Optional systemd or application unit name for context.">
                  <Input
                    id={`${id}-service`}
                    value={serviceName}
                    onChange={event => setServiceName(event.currentTarget.value)}
                    placeholder="e.g. api.service"
                    maxLength={80}
                  />
                </Field>
              </div>

              <div className="onboarding-actions">
                <ButtonLink href="/services" size="sm">Cancel</ButtonLink>
                <Button type="submit" variant="primary" size="sm" loading={submitting}>
                  {submitting ? "Creating endpoint…" : "Create and verify endpoint"}
                </Button>
              </div>
            </form>
          )}
        </li>

        <li className="onboarding-step" data-state={step === 1 ? "active" : "upcoming"}>
          <div className="onboarding-step-header">
            <div>
              <h2>2. Verify endpoint</h2>
              {step !== 1 && <p className="onboarding-step-status">{steps[1].summary}</p>}
            </div>
          </div>

          {step === 1 && created && (
            <div className="onboarding-step-body">
              <dl className="onboarding-details">
                <div><dt>Endpoint name</dt><dd>{created.name}</dd></div>
                <div><dt>Target URL</dt><dd>{created.target_url}</dd></div>
                <div><dt>Expected HTTP</dt><dd>{created.expected_status}</dd></div>
                <div><dt>Probe location</dt><dd>{created.probe_location}</dd></div>
              </dl>

              {checkError && <Notice tone="danger" role="alert">{checkError}</Notice>}

              {checking ? (
                <AsciiLoading label="Running initial endpoint check…" lines={2} widths={["68%", "44%"]} />
              ) : (
                <div className="onboarding-inline-actions" role="status">
                  <Badge tone={created.last_status === "up" ? "success" : created.last_status === "down" ? "danger" : "neutral"} dot>
                    {created.last_status === "up"
                      ? `Up · HTTP ${created.last_http_status ?? created.expected_status}${created.last_latency_ms !== null ? ` · ${created.last_latency_ms} ms` : ""}`
                      : created.last_status === "down"
                        ? `Down · ${created.last_http_status !== null ? `HTTP ${created.last_http_status}` : created.last_error ?? "unreachable"}`
                        : "Pending"}
                  </Badge>
                  <Button size="sm" onClick={() => void runCheck(created.id)}>Check again</Button>
                </div>
              )}

              <div className="onboarding-actions">
                <Button size="sm" disabled={checking} onClick={resetForm}>Add another endpoint</Button>
                <ButtonLink href="/services" variant="primary" size="sm">Finish</ButtonLink>
              </div>
            </div>
          )}
        </li>
      </ol>
    </section>
  </>;
}
