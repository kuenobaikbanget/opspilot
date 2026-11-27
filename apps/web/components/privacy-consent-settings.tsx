"use client";

import { useState } from "react";
import type { PrivacyConsentSettings } from "@opspilot/contracts";
import { Badge, Button, Notice, Panel } from "./ui";

type Props = {
  consent: PrivacyConsentSettings | null;
  loading: boolean;
  error: string;
  onUpdate: (aiEgressConsentGranted: boolean, redactPii: boolean) => Promise<string | null>;
  onRefresh: () => Promise<void>;
};

/**
 * Minimal privacy consent control. External AI/LLM egress (investigations and
 * connection tests) is blocked server-side until consent is granted here; the toggle
 * never transmits secrets — only two booleans go to the Hub.
 */
export function PrivacyConsentSettings({ consent, loading, error, onUpdate, onRefresh }: Props) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const granted = consent?.aiEgressConsentGranted === true;
  const redactPii = consent?.redactPii === true;

  async function toggle() {
    if (pending || !consent) return;
    setPending(true);
    setMessage("");
    try {
      const failure = await onUpdate(!granted, redactPii);
      if (failure) setMessage(failure);
      else {
        setMessage(!granted
          ? "Consent granted. External AI providers may now receive redacted incident data; every send still passes the redaction pipeline."
          : "Consent revoked. Investigations and connection tests are blocked until consent is granted again.");
        await onRefresh();
      }
    } finally {
      setPending(false);
    }
  }

  async function togglePii() {
    if (pending || !consent) return;
    setPending(true);
    setMessage("");
    try {
      const failure = await onUpdate(granted, !redactPii);
      if (failure) setMessage(failure);
      else {
        setMessage(!redactPii
          ? "PII redaction enabled: email addresses and IP addresses are also redacted from evidence before storage and before any external AI call."
          : "PII redaction disabled: only credentials, tokens, keys and connection strings are redacted.");
        await onRefresh();
      }
    } finally {
      setPending(false);
    }
  }

  return <Panel className="privacy-consent-settings" role="region" aria-labelledby="privacy-consent-title">
    <div className="panel-head">
      <div>
        <h2 id="privacy-consent-title">Privacy consent</h2>
        <p>Control whether diagnostic logs, config diffs and incident evidence may be sent to an external AI provider.</p>
      </div>
      <Badge tone={granted ? "success" : "warning"}>{granted ? "Egress consent granted" : "Egress consent not granted"}</Badge>
    </div>
    {loading && !consent && <p className="muted" role="status">Loading privacy settings…</p>}
    {error && <Notice tone="danger" role="alert"><p>{error}</p><Button size="sm" onClick={() => void onRefresh()} disabled={loading}>Retry</Button></Notice>}
    {message && <Notice tone="info" role="status">{message}</Notice>}
    {consent && <>
      <p className="muted small">
        Without consent, investigations and connection tests fail closed with <code>privacy_consent_required</code> and the blocked attempt is audited.
        With consent, all outbound data still passes the redaction pipeline first (tokens, keys, private keys, connection strings, credentials).
        {consent.consentedAt && <> Consent version <code>{consent.consentVersion}</code>{consent.consentedBy ? `, granted by ${consent.consentedBy}` : ""} on <time dateTime={consent.consentedAt}>{new Date(consent.consentedAt).toLocaleString()}</time>.</>}
      </p>
      <div className="provider-actions">
        <Button size="sm" variant={granted ? "danger" : "primary"} loading={pending} disabled={loading} onClick={() => void toggle()}>
          {granted ? "Revoke egress consent" : "Grant egress consent"}
        </Button>
        <Button size="sm" disabled={pending || loading} onClick={() => void togglePii()}>
          {redactPii ? "Disable PII redaction" : "Enable PII redaction"}
        </Button>
      </div>
    </>}
  </Panel>;
}
