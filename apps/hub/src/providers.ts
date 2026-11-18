import type { AiProvider, ProviderConnectionTest, ProviderProtocol } from "@opspilot/contracts";
import { parseCreateAiProviderRequest, parseUpdateAiProviderRequest } from "@opspilot/contracts";
import { decryptProviderKey, encryptProviderKey, ProviderCredentialError, readProviderMasterKey } from "@opspilot/ai/credentials";
import { normalizeProviderBaseUrl, ProviderError } from "@opspilot/ai/provider-http";
import { audit, db } from "./db";
import { aiOrigin, apiError, j, jsonBody, urlUUID } from "./http";

type ProviderRow = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  base_url: string;
  default_model: string;
  enabled: boolean;
  revision: number;
  api_key_ciphertext: string;
  created_at: Date;
  updated_at: Date;
  last_test_id: string | null;
  last_test_status: ProviderConnectionTest["status"] | null;
  last_test_revision: number | null;
  last_test_model: string | null;
  last_test_error_code: string | null;
  last_test_http_status: number | null;
  last_test_requested_at: Date | null;
  last_test_started_at: Date | null;
  last_test_completed_at: Date | null;
  last_test_expires_at: Date | null;
};

function providerDto(row: ProviderRow): AiProvider {
  const expired = (row.last_test_status === "queued" || row.last_test_status === "running") &&
    row.last_test_expires_at !== null && row.last_test_expires_at.getTime() <= Date.now();
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    enabled: row.enabled,
    revision: row.revision,
    hasApiKey: Boolean(row.api_key_ciphertext),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastTest: row.last_test_id === null ? null : {
      id: row.last_test_id,
      revision: row.last_test_revision!,
      model: row.last_test_model!,
      status: expired ? "failed" : row.last_test_status!,
      errorCode: expired ? "provider_timeout" : row.last_test_error_code,
      httpStatus: expired ? null : row.last_test_http_status,
      requestedAt: row.last_test_requested_at!.toISOString(),
      startedAt: row.last_test_started_at?.toISOString() ?? null,
      completedAt: expired ? row.last_test_expires_at!.toISOString() : row.last_test_completed_at?.toISOString() ?? null,
      expiresAt: row.last_test_expires_at!.toISOString(),
    },
  };
}

/** Called only behind the shared admin authentication guard. */
export async function providerRoutes(req: Request, path: string, method: string): Promise<Response | null> {
  const collection = path === "/api/ai/providers";
  const match = path.match(/^\/api\/ai\/providers\/([^/]+)(\/test)?$/);
  if (!collection && !match) return null;
  if (collection && method === "GET") {
    const rows = await db<ProviderRow[]>`SELECT * FROM ai_providers ORDER BY created_at,id LIMIT 100`;
    return j({ providers: rows.map(providerDto), encryptionConfigured: readProviderMasterKey(process.env) !== null });
  }
  if (!((collection && method === "POST") || (match && !match[2] && (method === "PATCH" || method === "DELETE")) ||
      (match && match[2] && method === "POST"))) return null;
  const forbidden = aiOrigin(req);
  if (forbidden) return forbidden;
  if (match && !urlUUID(match[1])) return apiError("Invalid provider id", "invalid_request");
  const masterKey = readProviderMasterKey(process.env);
  if (!masterKey) return apiError("Provider credentials unavailable", "credential_unavailable", 503);

  try {
    if (collection) {
      const data = parseCreateAiProviderRequest(await jsonBody(req));
      if (!data) return apiError("Invalid provider request", "invalid_request");
      const baseUrl = normalizeProviderBaseUrl(data.baseUrl);
      const id = crypto.randomUUID();
      const ciphertext = encryptProviderKey(id, data.apiKey, masterKey);
      return await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(73460713)`;
        const [count] = await tx<{ count: number }[]>`SELECT COUNT(*)::integer AS count FROM ai_providers`;
        if (count.count >= 100) return apiError("Provider limit reached", "provider_limit", 409);
        const [row] = await tx<ProviderRow[]>`INSERT INTO ai_providers(id,name,protocol,base_url,default_model,enabled,api_key_ciphertext)
          VALUES(${id},${data.name},${data.protocol},${baseUrl},${data.defaultModel},${data.enabled},${ciphertext}) RETURNING *`;
        await audit("ai.provider.created", id, { protocol: row.protocol, revision: row.revision }, tx);
        return j({ provider: providerDto(row) }, 201);
      });
    }

    const id = match![1].toLowerCase();
    if (method === "DELETE") {
      if (req.body !== null) {
        const data = await jsonBody(req);
        if (Object.keys(data).length) return apiError("Invalid provider delete request", "invalid_request");
      }
      return await db.begin(async (tx) => {
        const [row] = await tx<ProviderRow[]>`SELECT * FROM ai_providers WHERE id=${id} FOR UPDATE`;
        if (!row) return apiError("Provider unavailable", "provider_unavailable", 404);
        await tx`DELETE FROM ai_providers WHERE id=${id}`;
        await audit("ai.provider.deleted", id, { protocol: row.protocol, revision: row.revision }, tx);
        return j({ ok: true });
      });
    }

    if (method === "PATCH") {
      const data = parseUpdateAiProviderRequest(await jsonBody(req));
      if (!data) return apiError("Invalid provider request", "invalid_request");
      const normalizedBaseUrl = data.baseUrl === undefined ? undefined : normalizeProviderBaseUrl(data.baseUrl);
      return await db.begin(async (tx) => {
        const [row] = await tx<ProviderRow[]>`SELECT * FROM ai_providers WHERE id=${id} FOR UPDATE`;
        if (!row) return apiError("Provider unavailable", "provider_unavailable", 404);
        const name = data.name ?? row.name;
        const protocol = data.protocol ?? row.protocol;
        const baseUrl = normalizedBaseUrl ?? row.base_url;
        const defaultModel = data.defaultModel ?? row.default_model;
        const enabled = data.enabled ?? row.enabled;
        if ((baseUrl !== row.base_url || protocol !== row.protocol) && data.apiKey === undefined) {
          return apiError("A new API key is required when changing the endpoint or protocol", "invalid_request");
        }
        const changedFields = [
          ...(name !== row.name ? ["name"] : []),
          ...(protocol !== row.protocol ? ["protocol"] : []),
          ...(baseUrl !== row.base_url ? ["baseUrl"] : []),
          ...(defaultModel !== row.default_model ? ["defaultModel"] : []),
          ...(enabled !== row.enabled ? ["enabled"] : []),
          ...(data.apiKey !== undefined ? ["apiKey"] : []),
        ];
        if (!changedFields.length) return j({ provider: providerDto(row) });
        const ciphertext = data.apiKey === undefined ? row.api_key_ciphertext : encryptProviderKey(row.id, data.apiKey, masterKey);
        const activeTest = row.last_test_status === "queued" || row.last_test_status === "running";
        if (activeTest) {
          await tx`UPDATE ai_providers SET last_test_status='failed',last_test_error_code='provider_changed',
            last_test_http_status=NULL,last_test_completed_at=NOW() WHERE id=${id}`;
          await audit("ai.provider.test_failed", id, {
            revision: row.last_test_revision, testId: row.last_test_id, errorCode: "provider_changed",
          }, tx);
        }
        const [updated] = await tx<ProviderRow[]>`UPDATE ai_providers SET name=${name},protocol=${protocol},base_url=${baseUrl},
          default_model=${defaultModel},enabled=${enabled},api_key_ciphertext=${ciphertext},revision=revision+1,updated_at=NOW()
          WHERE id=${id} RETURNING *`;
        await audit("ai.provider.updated", id, { protocol, revision: updated.revision, changedFields }, tx);
        return j({ provider: providerDto(updated) });
      });
    }

    const data = await jsonBody(req);
    if (Object.keys(data).length) return apiError("Invalid connection test request", "invalid_request");
    return await db.begin(async (tx) => {
      const [row] = await tx<ProviderRow[]>`SELECT * FROM ai_providers WHERE id=${id} FOR UPDATE`;
      if (!row) return apiError("Provider unavailable", "provider_unavailable", 404);
      if (!row.enabled) return apiError("Provider is disabled", "provider_disabled", 409);
      decryptProviderKey(row.id, row.api_key_ciphertext, masterKey);
      if (row.last_test_status === "queued" || row.last_test_status === "running") {
        const [state] = await tx<{ expired: boolean }[]>`SELECT last_test_expires_at <= NOW() AS expired FROM ai_providers WHERE id=${id}`;
        if (!state.expired) return apiError("A connection test is already in progress", "test_in_progress", 409);
        await tx`UPDATE ai_providers SET last_test_status='failed',last_test_error_code='provider_timeout',
          last_test_http_status=NULL,last_test_completed_at=NOW() WHERE id=${id}`;
        await audit("ai.provider.test_failed", id, {
          revision: row.last_test_revision, testId: row.last_test_id, errorCode: "provider_timeout",
        }, tx);
      }
      const testId = crypto.randomUUID();
      await tx`UPDATE ai_providers SET last_test_id=${testId},last_test_status='queued',last_test_revision=revision,
        last_test_model=default_model,last_test_error_code=NULL,last_test_http_status=NULL,last_test_requested_at=NOW(),
        last_test_started_at=NULL,last_test_completed_at=NULL,last_test_expires_at=NOW()+INTERVAL '90 seconds' WHERE id=${id}`;
      await audit("ai.provider.test_queued", id, { protocol: row.protocol, revision: row.revision, testId }, tx);
      return j({ id: testId, providerId: id, status: "queued" }, 202);
    });
  } catch (error) {
    if (error instanceof ProviderError) return apiError(error.message, error.code, 400);
    if (error instanceof ProviderCredentialError) return apiError("Provider credentials unavailable", "credential_unavailable", 503);
    throw error;
  }
}
