import type { SQL } from "bun";
import {
  PRIVACY_CONSENT_REQUIRED,
  PRIVACY_CONSENT_VERSION,
  hasAiEgressConsent,
  parseUpdatePrivacyConsentRequest,
  rowToPrivacyConsentSettings,
  type PrivacyConsentSettings,
  type PrivacySettingsRow,
  type UpdatePrivacyConsentRequest,
} from "@opspilot/contracts";
import { aiOrigin, apiError, j, jsonBody } from "./http";

/**
 * Privacy consent gate (Phase 4.2). This module deliberately takes an explicit SQL
 * executor everywhere (no module-level DB import) so it stays unit-testable and is
 * shared verbatim by the Worker.
 *
 * Fail-closed rule: external AI/LLM egress (incident evidence, config diffs, diagnostic
 * logs, synthetic connection tests, embeddings) is only allowed when the persisted
 * `privacy_settings.ai_egress_consent_granted` flag is TRUE. Absent consent blocks the
 * send with {@link PrivacyConsentError} and writes a `privacy.egress_blocked` audit event.
 */

export class PrivacyConsentError extends Error {
  readonly code = PRIVACY_CONSENT_REQUIRED;
  constructor(context: string) {
    super("Privacy consent is required before sending data to an external AI provider");
    this.name = "PrivacyConsentError";
    this.context = context;
  }
  readonly context: string;
}

async function auditEvent(executor: SQL, action: string, data: object): Promise<void> {
  await executor`INSERT INTO audit_events(action,target_id,data) VALUES(${action},NULL,${data}::jsonb)`;
}

/** Reads the persisted workspace privacy settings; an absent row means deny-by-default. */
export async function getPrivacySettings(executor: SQL): Promise<PrivacyConsentSettings> {
  const rows = await executor<NonNullable<PrivacySettingsRow>[]>`
    SELECT ai_egress_consent_granted,consent_version,consented_at,consented_by,redact_pii,updated_at
    FROM privacy_settings WHERE id=1`;
  return rowToPrivacyConsentSettings(rows[0] ?? null);
}

export type PrivacyUpdateResult = {
  settings: PrivacyConsentSettings;
  /** Audit action that was written: privacy.consent_granted | privacy.consent_revoked | privacy.settings_updated. */
  action: string;
};

/**
 * Applies a validated consent update atomically with its audit event. Granting consent
 * stamps `consented_at`/`consented_by` and the current consent version; revoking clears
 * them. Audit data is non-secret metadata only.
 */
export async function updatePrivacySettings(
  executor: SQL,
  update: UpdatePrivacyConsentRequest,
  actor = "admin",
): Promise<PrivacyUpdateResult> {
  return await executor.begin(async (tx) => {
    const current = await getPrivacySettings(tx);
    const granted = update.aiEgressConsentGranted ?? current.aiEgressConsentGranted;
    const redactPii = update.redactPii ?? current.redactPii;
    const wasGranted = current.aiEgressConsentGranted;
    const consentedAt = granted ? (wasGranted && current.consentedAt ? new Date(current.consentedAt) : new Date()) : null;
    const consentedBy = granted ? (update.consentedBy ?? current.consentedBy ?? actor) : null;
    const [row] = await tx<NonNullable<PrivacySettingsRow>[]>`
      INSERT INTO privacy_settings(id,ai_egress_consent_granted,consent_version,consented_at,consented_by,redact_pii,updated_at)
      VALUES(1,${granted},${PRIVACY_CONSENT_VERSION},${consentedAt},${consentedBy},${redactPii},NOW())
      ON CONFLICT (id) DO UPDATE SET
        ai_egress_consent_granted=EXCLUDED.ai_egress_consent_granted,
        consent_version=EXCLUDED.consent_version,
        consented_at=EXCLUDED.consented_at,
        consented_by=EXCLUDED.consented_by,
        redact_pii=EXCLUDED.redact_pii,
        updated_at=NOW()
      RETURNING ai_egress_consent_granted,consent_version,consented_at,consented_by,redact_pii,updated_at`;
    const settings = rowToPrivacyConsentSettings(row);
    const action =
      update.aiEgressConsentGranted !== undefined && granted !== wasGranted
        ? granted ? "privacy.consent_granted" : "privacy.consent_revoked"
        : "privacy.settings_updated";
    await auditEvent(tx, action, {
      aiEgressConsentGranted: settings.aiEgressConsentGranted,
      consentVersion: settings.consentVersion,
      consentedBy: settings.consentedBy,
      redactPii: settings.redactPii,
    });
    return { settings, action };
  });
}

/**
 * Enforces the egress consent gate. Returns the settings when consent is granted;
 * otherwise writes a `privacy.egress_blocked` audit event and throws
 * {@link PrivacyConsentError} (never silently allows the send).
 */
export async function requireAiEgressConsent(executor: SQL, context: string): Promise<PrivacyConsentSettings> {
  const settings = await getPrivacySettings(executor);
  if (!hasAiEgressConsent(settings)) {
    await auditEvent(executor, "privacy.egress_blocked", {
      context,
      reason: "ai_egress_consent_not_granted",
      consentVersion: settings.consentVersion,
    });
    throw new PrivacyConsentError(context);
  }
  return settings;
}

/**
 * `GET /api/privacy/consent` and `PUT /api/privacy/consent`. Called behind the shared
 * admin authentication guard; PUT additionally requires the exact ALLOWED_ORIGIN.
 * Returns null when the path is not a privacy route.
 */
export async function privacyRoutes(
  req: Request,
  path: string,
  method: string,
  executor: SQL,
): Promise<Response | null> {
  if (path !== "/api/privacy/consent") return null;
  if (method === "GET") {
    return j({ consent: await getPrivacySettings(executor) });
  }
  if (method !== "PUT") return null;
  const forbidden = aiOrigin(req);
  if (forbidden) return forbidden;
  const update = parseUpdatePrivacyConsentRequest(await jsonBody(req));
  if (!update) {
    return apiError("Consent update must set aiEgressConsentGranted and/or redactPii (booleans) and an optional consentedBy (1-120 chars)", "invalid_request");
  }
  const actor = update.consentedBy ?? "admin";
  const result = await updatePrivacySettings(executor, update, actor);
  return j({ consent: result.settings });
}
