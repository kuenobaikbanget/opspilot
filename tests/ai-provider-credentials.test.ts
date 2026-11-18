import { expect, test } from "bun:test";
import { decryptProviderKey, encryptProviderKey, ProviderCredentialError, readProviderMasterKey } from "../packages/ai/src/credentials";

const id = "d0000000-0000-4000-8000-000000000001";
const otherId = "d0000000-0000-4000-8000-000000000002";
const master = new Uint8Array(32).fill(7);
const secret = "sk-dummy-credential-only";

function unavailable(run: () => unknown) {
  try {
    run();
    throw new Error("Expected credential rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCredentialError);
    expect((error as ProviderCredentialError).code).toBe("credential_unavailable");
    expect((error as Error).message).toBe("credential_unavailable");
    expect(String(error)).not.toContain(secret);
  }
}

test("canonical 32-byte base64 is required without startup exceptions", () => {
  const encoded = Buffer.from(master).toString("base64");
  expect(readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: encoded })).toEqual(Buffer.from(master));
  for (const input of [undefined, "", " ", encoded.trimEnd() + "\n", encoded.slice(0, -1), encoded.replace(/=$/, "A"), Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "!".repeat(43) + "="]) {
    expect(readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: input })).toBeNull();
  }
  // Nonzero unused pad bits must not pass as an alternative encoding.
  expect(readProviderMasterKey({ AI_PROVIDER_ENCRYPTION_KEY: "A".repeat(42) + "B=" })).toBeNull();
});

test("AES-GCM roundtrip uses fresh 12-byte nonces and 16-byte tags", () => {
  const first = encryptProviderKey(id, secret, master);
  const second = encryptProviderKey(id, secret, master);
  expect(first).not.toBe(second);
  expect(first).not.toContain(secret);
  const parts = first.split(".");
  expect(parts[0]).toBe("v1");
  expect(Buffer.from(parts[1]!, "base64url").length).toBe(12);
  expect(Buffer.from(parts[3]!, "base64url").length).toBe(16);
  expect(decryptProviderKey(id, first, master)).toBe(secret);
  expect(decryptProviderKey(id, second, master)).toBe(secret);
});

test("master key and provider identity authenticate the envelope", () => {
  const envelope = encryptProviderKey(id, secret, master);
  unavailable(() => decryptProviderKey(otherId, envelope, master));
  unavailable(() => decryptProviderKey(id, envelope, new Uint8Array(32).fill(8)));
  unavailable(() => decryptProviderKey(id, envelope, new Uint8Array(31)));
  unavailable(() => encryptProviderKey(id, secret, new Uint8Array(31)));
  unavailable(() => encryptProviderKey("invalid", secret, master));
});

test("tampered and malformed envelope components fail safely", () => {
  const envelope = encryptProviderKey(id, secret, master);
  for (const component of [1, 2, 3]) {
    const parts = envelope.split(".");
    const bytes = Buffer.from(parts[component]!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    parts[component] = bytes.toString("base64url");
    unavailable(() => decryptProviderKey(id, parts.join("."), master));
  }
  for (const input of ["", secret, envelope + ".extra", envelope.replace("v1.", "v2."), "v1.a.b.c", "v1...", envelope + "=", envelope.replace(/\./, ". ")]) {
    unavailable(() => decryptProviderKey(id, input, master));
  }
});
