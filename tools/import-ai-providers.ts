import { SQL } from "bun";
import { AI_PROVIDER_PRESETS, parseCreateAiProviderRequest } from "../packages/contracts/src/index";
import { decryptProviderKey, encryptProviderKey, readProviderMasterKey } from "../packages/ai/src/credentials";
import { normalizeProviderBaseUrl } from "../packages/ai/src/provider-http";

// Fixed identities record importer provenance; runtime routing never depends on them.
const sources = [
  { preset: AI_PROVIDER_PRESETS.openai, id: "d0000000-0000-4000-8000-000000000001", key: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
  { preset: AI_PROVIDER_PRESETS.anthropic, id: "d0000000-0000-4000-8000-000000000002", key: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL" },
  { preset: AI_PROVIDER_PRESETS.gemini, id: "d0000000-0000-4000-8000-000000000003", key: "GEMINI_API_KEY", model: "GEMINI_MODEL" },
] as const;

async function importProviders(): Promise<void> {
  const present = sources.filter(source => process.env[source.key]?.trim());
  if (!present.length) {
    console.log("No legacy provider credentials found; no changes made.");
    return;
  }
  const masterKey = readProviderMasterKey(process.env);
  if (!masterKey) throw new Error("AI provider master key is missing or invalid.");
  const providers = present.map(source => {
    const input = parseCreateAiProviderRequest({
      ...source.preset,
      apiKey: process.env[source.key],
      defaultModel: process.env[source.model]?.trim() || source.preset.defaultModel,
      enabled: true,
    });
    if (!input) throw new Error("Legacy provider configuration is invalid.");
    return { id: source.id, ...input, baseUrl: normalizeProviderBaseUrl(input.baseUrl) };
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for provider import.");
  const db = new SQL(url);
  try {
    const imported = await db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(73460713)`;
      const counts = await tx`SELECT COUNT(*)::integer AS count FROM ai_providers`;
      let total = Number(counts[0].count);
      let inserted = 0;
      for (const provider of providers) {
        const rows = await tx`SELECT name,protocol,base_url,default_model,enabled,api_key_ciphertext
          FROM ai_providers WHERE id=${provider.id} FOR UPDATE`;
        const existing = rows[0];
        if (existing) {
          let sameKey = false;
          try {
            sameKey = decryptProviderKey(provider.id, existing.api_key_ciphertext, masterKey) === provider.apiKey;
          } catch {
            throw new Error("Stored provider credential is unavailable; import aborted.");
          }
          if (!sameKey || existing.name !== provider.name || existing.protocol !== provider.protocol ||
              existing.base_url !== provider.baseUrl || existing.default_model !== provider.defaultModel ||
              existing.enabled !== provider.enabled) {
            throw new Error("Imported provider identity conflicts with stored configuration; import aborted.");
          }
          continue;
        }
        if (total >= 100) throw new Error("Provider limit reached; import aborted.");
        const ciphertext = encryptProviderKey(provider.id, provider.apiKey, masterKey);
        await tx`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
          VALUES(${provider.id},${provider.name},${provider.protocol},${provider.baseUrl},${provider.defaultModel},${provider.enabled},${ciphertext})`;
        await tx`INSERT INTO audit_events(action,target_id,data)
          VALUES('ai.provider.created',${provider.id},${{ protocol: provider.protocol, revision: 1 }}::jsonb)`;
        total++;
        inserted++;
      }
      return inserted;
    });
    console.log(`Provider import completed: ${imported} connections created; existing identical connections unchanged.`);
  } finally {
    await db.close();
  }
}

try {
  await importProviders();
} catch {
  // Never print SQL, environment values, crypto exceptions, URLs or credentials.
  console.error("AI provider import failed. Check master key, legacy configuration, provider identity conflicts, provider limit and database availability.");
  process.exitCode = 1;
}
