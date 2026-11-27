/**
 * Privacy consent contract shared by Hub, Worker and Web.
 *
 * External AI/LLM egress (incident evidence, config diffs, diagnostic logs, synthetic
 * connection tests) is blocked unless the workspace explicitly grants
 * `aiEgressConsentGranted`. The gate fails closed everywhere: absent consent means no
 * external send, on both the Hub queueing path and the Worker execution path.
 */

/** Version of the consent text the operator agreed to; bump on material changes. */
export const PRIVACY_CONSENT_VERSION = "opspilot-privacy-consent-v1";

/** Persisted workspace privacy settings (Postgres `privacy_settings`, migration 017). */
export type PrivacyConsentSettings = {
  aiEgressConsentGranted: boolean;
  consentVersion: string;
  consentedAt: string | null;
  consentedBy: string | null;
  redactPii: boolean;
  updatedAt: string;
};

/** Admin-supplied update; at least one field must be present. */
export type UpdatePrivacyConsentRequest = {
  aiEgressConsentGranted?: boolean;
  redactPii?: boolean;
  consentedBy?: string;
};

/** Error code returned when external AI egress is attempted without consent. */
export const PRIVACY_CONSENT_REQUIRED = "privacy_consent_required";

function requestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict structural validation for consent updates: only the three known keys, booleans
 * for the flags, and a bounded non-empty actor label. Returns null on any violation.
 */
export function parseUpdatePrivacyConsentRequest(value: unknown): UpdatePrivacyConsentRequest | null {
  if (!requestObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !["aiEgressConsentGranted", "redactPii", "consentedBy"].includes(key))) {
    return null;
  }
  const result: UpdatePrivacyConsentRequest = {};
  if (Object.hasOwn(value, "aiEgressConsentGranted")) {
    if (typeof value.aiEgressConsentGranted !== "boolean") return null;
    result.aiEgressConsentGranted = value.aiEgressConsentGranted;
  }
  if (Object.hasOwn(value, "redactPii")) {
    if (typeof value.redactPii !== "boolean") return null;
    result.redactPii = value.redactPii;
  }
  if (Object.hasOwn(value, "consentedBy")) {
    if (typeof value.consentedBy !== "string") return null;
    const trimmed = value.consentedBy.trim();
    if (!trimmed.length || trimmed.length > 120) return null;
    result.consentedBy = trimmed;
  }
  return result;
}

/** Shape of the raw `privacy_settings` row (or null when the row is absent). */
export type PrivacySettingsRow = {
  ai_egress_consent_granted: boolean;
  consent_version: string;
  consented_at: Date | string | null;
  consented_by: string | null;
  redact_pii: boolean;
  updated_at: Date | string;
} | null;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Maps a `privacy_settings` row (or its absence) to the public DTO; absent means deny-by-default. */
export function rowToPrivacyConsentSettings(row: PrivacySettingsRow): PrivacyConsentSettings {
  if (!row) {
    return {
      aiEgressConsentGranted: false,
      consentVersion: PRIVACY_CONSENT_VERSION,
      consentedAt: null,
      consentedBy: null,
      redactPii: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    aiEgressConsentGranted: row.ai_egress_consent_granted === true,
    consentVersion: row.consent_version || PRIVACY_CONSENT_VERSION,
    consentedAt: toIso(row.consented_at),
    consentedBy: row.consented_by ?? null,
    redactPii: row.redact_pii === true,
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/** True only when explicit, currently-granted egress consent exists. */
export function hasAiEgressConsent(settings: Pick<PrivacyConsentSettings, "aiEgressConsentGranted">): boolean {
  return settings.aiEgressConsentGranted === true;
}
