"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { AI_PROVIDER_PRESETS, type AiProvider, type ProviderProtocol, type UpdateAiProviderRequest } from "@opspilot/contracts";
import { api, ApiError } from "../lib/api";
import { Badge, Button, Field, Input, Notice, Panel, Select } from "./ui";

type Props = {
  providers: AiProvider[];
  encryptionConfigured: boolean;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
};
type Draft = { name: string; protocol: ProviderProtocol; baseUrl: string; apiKey: string; defaultModel: string; enabled: boolean };
type Errors = Partial<Record<keyof Draft, string>>;
type Preset = keyof typeof AI_PROVIDER_PRESETS | "custom";
const emptyDraft = (): Draft => ({ ...AI_PROVIDER_PRESETS.openai, apiKey: "", enabled: true });
const protocolLabels: Record<ProviderProtocol, string> = { "openai-compatible": "OpenAI-compatible", anthropic: "Anthropic", gemini: "Gemini" };
const testErrors: Record<string, string> = {
  provider_timeout: "The connection test timed out. Worker availability or queue delays may also be the cause; this does not establish that the endpoint is down.",
  credential_unavailable: "The stored credential could not be opened. Check the server encryption key or replace this connection's API key.",
  provider_changed: "The configuration changed before the test finished. Run a new test for the current configuration.",
  provider_disabled: "The connection was disabled before the test ran.",
  provider_configuration: "The server's AI transport configuration is unsafe. Ask the server administrator to review it.",
  invalid_endpoint: "The endpoint URL is not supported.",
  endpoint_not_public: "The endpoint did not resolve exclusively to public addresses.",
  dns_failed: "The endpoint hostname could not be resolved.",
  provider_redirect: "The endpoint returned a redirect. Redirects are not followed.",
  provider_http: "The endpoint returned an unsuccessful HTTP status.",
  provider_response_too_large: "The endpoint response exceeded the response limit.",
  provider_invalid_response: "The endpoint did not return a compatible diagnosis.",
  provider_network: "The endpoint connection failed. Check the endpoint and server network access.",
};

function TestResult({ provider }: { provider: AiProvider }) {
  const test = provider.lastTest;
  if (!test) return <span className="muted">Not tested</span>;
  const current = test.revision === provider.revision;
  const passed = current && test.status === "completed";
  return <div className="provider-test-result">
    {!current && <strong>Not tested for current configuration</strong>}
    <Badge tone={passed ? "success" : test.status === "failed" ? "danger" : test.status === "completed" ? "neutral" : "warning"}>
      {passed ? "Connection test passed" : test.status === "completed" ? "Previous connection test passed" : test.status}
    </Badge>
    <small>Model: {test.model} · Revision {test.revision}</small>
    <small>Requested <time dateTime={test.requestedAt}>{new Date(test.requestedAt).toLocaleString()}</time></small>
    {test.startedAt && <small>Started <time dateTime={test.startedAt}>{new Date(test.startedAt).toLocaleString()}</time></small>}
    {test.completedAt && <small>Finished <time dateTime={test.completedAt}>{new Date(test.completedAt).toLocaleString()}</time></small>}
    {(test.status === "queued" || test.status === "running") && <small>Deadline <time dateTime={test.expiresAt}>{new Date(test.expiresAt).toLocaleString()}</time></small>}
    {test.status === "failed" && <small>{testErrors[test.errorCode ?? ""] ?? "The connection test failed. Review the configuration and run a new test."}{test.httpStatus !== null ? ` HTTP ${test.httpStatus}.` : ""}</small>}
  </div>;
}

export function ProviderSettings({ providers, encryptionConfigured, loading, error, onRefresh }: Props) {
  const [editor, setEditor] = useState<{ provider: AiProvider | null } | null>(null);
  const [preset, setPreset] = useState<Preset | "">("openai");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const clear = () => { setDraft(emptyDraft()); setEditor(null); setDeleting(null); };
    window.addEventListener("opspilot-unauthorized", clear);
    window.addEventListener("opspilot-clear-provider-draft", clear);
    return () => {
      mounted.current = false;
      window.removeEventListener("opspilot-unauthorized", clear);
      window.removeEventListener("opspilot-clear-provider-draft", clear);
    };
  }, []);
  useEffect(() => { if (editor) editorHeading.current?.focus(); }, [editor]);
  useEffect(() => {
    if (editor || pending !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
    else heading.current?.focus();
  }, [editor, pending]);

  const destinationChanged = !!editor?.provider && (draft.protocol !== editor.provider.protocol || draft.baseUrl.trim().replace(/\/+$/, "") !== editor.provider.baseUrl);
  const keyRequired = !editor?.provider || destinationChanged;
  const locked = !encryptionConfigured || !!error || pending !== null;
  const hint = destinationChanged ? "The API destination changed. Enter a new key; the stored key cannot be sent to a changed destination." : editor?.provider ? "Leave blank to keep the stored key" : "Stored encrypted on the server. The saved key is never returned to your browser.";

  function openEditor(provider: AiProvider | null, button: HTMLButtonElement) {
    trigger.current = button;
    setDraft(provider ? { name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, defaultModel: provider.defaultModel, enabled: provider.enabled, apiKey: "" } : emptyDraft());
    setPreset(provider ? "" : "openai");
    setErrors({}); setActionError(""); setMessage(""); setDeleting(null);
    setEditor({ provider });
  }
  function closeEditor() {
    restoreFocus.current = true;
    setDraft(emptyDraft()); setEditor(null); setErrors({});
  }
  function choosePreset(value: Preset) {
    setPreset(value);
    const fields = value === "custom" ? { name: "", protocol: "openai-compatible" as const, baseUrl: "", defaultModel: "" } : AI_PROVIDER_PRESETS[value];
    setDraft(old => ({ ...old, ...fields, apiKey: "" }));
    setErrors({});
  }
  function described(field: keyof Draft, hasHint = false) {
    return [hasHint ? `provider-${field}-hint` : "", errors[field] ? `provider-${field}-error` : ""].filter(Boolean).join(" ") || undefined;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || locked) return;
    const next: Errors = {};
    const name = draft.name.trim(), model = draft.defaultModel.trim(), key = draft.apiKey.trim();
    if (!name || name.length > 80) next.name = "Enter a name between 1 and 80 characters.";
    if (!model || model.length > 200) next.defaultModel = "Enter an explicit model between 1 and 200 characters.";
    if (keyRequired && !key) next.apiKey = destinationChanged ? "Enter a new API key for the changed destination." : "Enter an API key.";
    if (draft.apiKey && (!key || key.length > 4096 || /[\s\p{Cc}]/u.test(key))) next.apiKey = "Use a key of 1–4096 characters without internal whitespace or control characters.";
    try {
      const url = new URL(draft.baseUrl.trim());
      if (draft.baseUrl.trim().length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) next.baseUrl = "Enter a public HTTPS API root without credentials, query or fragment.";
    } catch { next.baseUrl = "Enter a valid public HTTPS API root."; }
    setErrors(next);
    if (Object.keys(next).length) {
      const first = Object.keys(next)[0];
      document.getElementById(`provider-${first}`)?.focus();
      return;
    }
    const payload: UpdateAiProviderRequest = { name, protocol: draft.protocol, baseUrl: draft.baseUrl.trim(), defaultModel: model, enabled: draft.enabled };
    if (key) payload.apiKey = key;
    setPending("save"); setActionError(""); setMessage("");
    try {
      await api(editor.provider ? `/ai/providers/${editor.provider.id}` : "/ai/providers", editor.provider ? "PATCH" : "POST", payload);
      if (!mounted.current) return;
      closeEditor();
      setMessage("Provider saved. Saving does not run a connection test.");
      await onRefresh();
    } catch (cause) {
      if (!mounted.current) return;
      setActionError(cause instanceof ApiError && cause.code === "credential_unavailable" ? "Server encryption is unavailable. Ask the administrator to configure AI_PROVIDER_ENCRYPTION_KEY on the Hub and Worker." : cause instanceof Error ? cause.message : "Unable to save the provider.");
    } finally { if (mounted.current) setPending(null); }
  }
  async function runAction(provider: AiProvider, action: "test" | "delete") {
    setPending(`${action}:${provider.id}`); setActionError(""); setMessage("");
    try {
      await api(`/ai/providers/${provider.id}${action === "test" ? "/test" : ""}`, action === "test" ? "POST" : "DELETE", action === "test" ? {} : undefined);
      if (!mounted.current) return;
      if (action === "delete") {
        setDeleting(null);
        if (editor?.provider?.id === provider.id) { setDraft(emptyDraft()); setEditor(null); }
        heading.current?.focus();
        setMessage("Provider deleted. Historical investigation reports are preserved.");
      } else setMessage("Connection test queued. Waiting for the Worker; no incident evidence is sent.");
      await onRefresh();
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : "The provider action failed.");
    } finally { if (mounted.current) setPending(null); }
  }

  return <Panel className="provider-settings" role="region" aria-labelledby="provider-settings-title">
    <div className="panel-head provider-settings-head">
      <div><h2 id="provider-settings-title" ref={heading} tabIndex={-1}>AI providers</h2><p>Manage encrypted credentials and choose where AI requests are sent. Saving a connection does not verify its endpoint.</p></div>
      <Button variant="primary" disabled={locked || loading || providers.length >= 100} onClick={e => openEditor(null, e.currentTarget)}>Add provider</Button>
    </div>
    {loading && <p className="muted" role="status">Refreshing provider metadata…</p>}
    {error && <Notice tone="danger" role="alert"><p>{error} Previously loaded metadata may be stale. Investigations and provider actions are disabled until refresh succeeds.</p><Button size="sm" onClick={() => void onRefresh()} disabled={loading}>Retry provider refresh</Button></Notice>}
    {!loading && !error && !encryptionConfigured && <Notice tone="warning">Server encryption is not configured. Set a valid AI_PROVIDER_ENCRYPTION_KEY on the Hub and Worker to enable provider changes, tests and investigations. No master key is entered in this browser.</Notice>}
    {actionError && <Notice tone="danger" role="alert">{actionError}</Notice>}
    {message && <Notice tone="info" role="status">{message}</Notice>}
    <p id="provider-test-disclosure" className="muted small">Test connection: Sends a synthetic prompt to this endpoint and may incur API charges. No incident evidence is sent.</p>
    {providers.length ? <div className="provider-table-scroll" role="region" aria-label="AI provider connections" tabIndex={0} aria-busy={loading}>
      <table className="provider-table"><thead><tr><th scope="col">Name / protocol</th><th scope="col">Endpoint</th><th scope="col">Default model</th><th scope="col">Enabled</th><th scope="col">Last connection test</th><th scope="col">Actions</th></tr></thead>
        <tbody>{providers.map(provider => {
          const active = provider.lastTest?.status === "queued" || provider.lastTest?.status === "running";
          return <Fragment key={provider.id}><tr>
            <th scope="row"><strong>{provider.name}</strong><small>{protocolLabels[provider.protocol]}</small><small>Revision {provider.revision} · {provider.hasApiKey ? "Key configured" : "Key unavailable"}</small></th>
            <td className="provider-endpoint">{provider.baseUrl}</td><td>{provider.defaultModel}</td><td><Badge tone="neutral">{provider.enabled ? "Enabled" : "Disabled"}</Badge></td>
            <td><TestResult provider={provider} /></td>
            <td><div className="provider-actions">
              <Button size="sm" disabled={locked} aria-label={`Edit ${provider.name}`} onClick={e => openEditor(provider, e.currentTarget)}>Edit</Button>
              <Button size="sm" disabled={locked || !provider.enabled || !provider.hasApiKey || active} loading={pending === `test:${provider.id}`} aria-label={`Test connection for ${provider.name}`} aria-describedby="provider-test-disclosure" onClick={() => void runAction(provider, "test")}>Test connection</Button>
              <Button size="sm" variant="danger" disabled={locked} aria-label={`Delete ${provider.name}`} aria-expanded={deleting === provider.id} aria-controls={`provider-delete-${provider.id}`} onClick={() => { setDeleting(provider.id); setActionError(""); }}>Delete</Button>
            </div></td>
          </tr>{deleting === provider.id && <tr><td colSpan={6}><div className="provider-delete-confirm" id={`provider-delete-${provider.id}`}>
            <p>Delete <strong>{provider.name}</strong> and its stored credential? Historical investigation reports are preserved. Queued investigations can no longer use this connection.</p>
            <div className="provider-actions"><Button variant="danger" size="sm" loading={pending === `delete:${provider.id}`} disabled={locked} onClick={() => void runAction(provider, "delete")}>Confirm delete {provider.name}</Button><Button size="sm" disabled={pending !== null} onClick={() => { setDeleting(null); document.querySelector<HTMLButtonElement>(`[aria-controls="provider-delete-${provider.id}"]`)?.focus(); }}>Cancel delete</Button></div>
          </div></td></tr>}</Fragment>;
        })}</tbody>
      </table>
    </div> : !loading && !error && <div className="empty">No AI providers yet. Use Add provider to store a connection, then explicitly test it before investigating an incident.</div>}
    {providers.length >= 100 && <p className="muted small">The 100-connection limit has been reached. Delete an unused connection before adding another.</p>}
    {editor && <form className="provider-editor" onSubmit={save} noValidate>
      <h3 ref={editorHeading} tabIndex={-1}>{editor.provider ? `Edit ${editor.provider.name}` : "Add provider"}</h3>
      <div className="provider-form-grid">
        <Field id="provider-preset" label="Provider preset" hint="Presets only fill editable fields; they do not discover models or test credentials."><Select id="provider-preset" value={preset} disabled={pending !== null} aria-describedby="provider-preset-hint" onChange={e => choosePreset(e.target.value as Preset)}><option value="" disabled>Current configuration</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="custom">Custom OpenAI-compatible</option></Select></Field>
        <Field id="provider-name" label="Name" error={errors.name} required><Input id="provider-name" value={draft.name} maxLength={80} disabled={pending !== null} required aria-invalid={!!errors.name} aria-describedby={described("name")} onChange={e => setDraft(old => ({ ...old, name: e.target.value }))} /></Field>
        <Field id="provider-protocol" label="API protocol" hint="OpenAI-compatible means Chat Completions, not Responses API." required><Select id="provider-protocol" value={draft.protocol} disabled={pending !== null} required aria-describedby="provider-protocol-hint" onChange={e => setDraft(old => ({ ...old, protocol: e.target.value as ProviderProtocol }))}>{Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field id="provider-baseUrl" label="Base URL" hint="Public HTTPS API root, such as https://api.openai.com/v1; not an operation URL. Private networks and redirects are blocked." error={errors.baseUrl} required><Input id="provider-baseUrl" type="url" value={draft.baseUrl} maxLength={2048} disabled={pending !== null} required aria-invalid={!!errors.baseUrl} aria-describedby={described("baseUrl", true)} onChange={e => setDraft(old => ({ ...old, baseUrl: e.target.value }))} /></Field>
        <Field id="provider-apiKey" label="API key" hint={hint} error={errors.apiKey} required={keyRequired}><Input id="provider-apiKey" type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} maxLength={4096} disabled={pending !== null} required={keyRequired} aria-invalid={!!errors.apiKey} aria-describedby={described("apiKey", true)} onChange={e => setDraft(old => ({ ...old, apiKey: e.target.value }))} /></Field>
        <Field id="provider-defaultModel" label="Default model" hint="Use an explicit model supported by this endpoint. No automatic fallback is used." error={errors.defaultModel} required><Input id="provider-defaultModel" value={draft.defaultModel} maxLength={200} disabled={pending !== null} required aria-invalid={!!errors.defaultModel} aria-describedby={described("defaultModel", true)} onChange={e => setDraft(old => ({ ...old, defaultModel: e.target.value }))} /></Field>
        <Field id="provider-enabled" label="Enabled" hint="Disabled connections cannot be tested or selected for new investigations."><input id="provider-enabled" type="checkbox" checked={draft.enabled} disabled={pending !== null} aria-describedby="provider-enabled-hint" onChange={e => setDraft(old => ({ ...old, enabled: e.target.checked }))} /></Field>
      </div>
      <div className="provider-actions"><Button type="submit" variant="primary" loading={pending === "save"} disabled={locked}>Save provider</Button><Button disabled={pending !== null} onClick={closeEditor}>Cancel</Button></div>
    </form>}
  </Panel>;
}
