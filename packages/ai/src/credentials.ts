import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Safe boundary error: never includes crypto internals or credential input. */
export class ProviderCredentialError extends Error {
  readonly code = "credential_unavailable";
  constructor() {
    super("credential_unavailable");
    this.name = "ProviderCredentialError";
  }
}

export function readProviderMasterKey(env: Record<string, string | undefined>): Uint8Array | null {
  const encoded = env.AI_PROVIDER_ENCRYPTION_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 && key.toString("base64") === encoded ? key : null;
}

function aad(providerId: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(providerId)) {
    throw new ProviderCredentialError();
  }
  return Buffer.from(`opspilot:ai-provider:v1:${providerId}`);
}

function decodePart(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new ProviderCredentialError();
  const decoded = Buffer.from(input, "base64url");
  if (decoded.toString("base64url") !== input) throw new ProviderCredentialError();
  return decoded;
}

export function encryptProviderKey(providerId: string, apiKey: string, masterKey: Uint8Array): string {
  try {
    if (masterKey.length !== 32 || !apiKey.length) throw new ProviderCredentialError();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(providerId));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return `v1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  } catch {
    throw new ProviderCredentialError();
  }
}

export function decryptProviderKey(providerId: string, envelope: string, masterKey: Uint8Array): string {
  try {
    if (masterKey.length !== 32) throw new ProviderCredentialError();
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new ProviderCredentialError();
    const nonce = decodePart(parts[1]!);
    const ciphertext = decodePart(parts[2]!);
    const tag = decodePart(parts[3]!);
    if (nonce.length !== 12 || tag.length !== 16) throw new ProviderCredentialError();
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(providerId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new ProviderCredentialError();
  }
}
