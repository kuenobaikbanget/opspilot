import type { SQL } from "bun";

/**
 * Grants workspace AI egress consent in a test database (the default after migration 017
 * is deny). Tests that exercise external-egress paths (investigations, provider tests)
 * must call this explicitly; consent-negative tests must not.
 */
export async function grantAiEgressConsent(db: SQL, redactPii = false): Promise<void> {
  await db`INSERT INTO privacy_settings(id,ai_egress_consent_granted,consent_version,consented_at,consented_by,redact_pii)
    VALUES(1,true,'opspilot-privacy-consent-v1',NOW(),'integration-test',${redactPii})
    ON CONFLICT (id) DO UPDATE SET ai_egress_consent_granted=true,consented_at=NOW(),redact_pii=${redactPii}`;
}

/** Revokes workspace AI egress consent in a test database. */
export async function revokeAiEgressConsent(db: SQL): Promise<void> {
  await db`UPDATE privacy_settings SET ai_egress_consent_granted=false,consented_at=NULL,consented_by=NULL WHERE id=1`;
}
