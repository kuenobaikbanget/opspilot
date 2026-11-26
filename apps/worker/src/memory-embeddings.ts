import type { SQL } from "bun";
import { generateEmbedding, redact, supportsEmbeddings, type GeneratedEmbedding, type ProviderConnection } from "@opspilot/ai";
import { decryptProviderKey } from "@opspilot/ai/credentials";
import { MAX_EMBEDDING_DIMENSIONS } from "@opspilot/ai/embeddings";
import type { ProviderProtocol } from "@opspilot/contracts";

/**
 * Opt-in worker-side embedding indexer for incident memory.
 *
 * Guardrails (see docs/AI-DESIGN.md, docs/SECURITY.md):
 * - Embeddings only run when `OPSPILOT_MEMORY_EMBEDDINGS_ENABLED=true` AND a
 *   server master key exists AND an enabled `openai-compatible`/`gemini`
 *   provider is configured. Anthropic-only deployments skip cleanly (FTS-only).
 * - Only canonical rows (`canonical_memory_id IS NULL`) with `embedding_consent =
 *   TRUE` (human-confirmed resolutions that the operator explicitly opted in) and
 *   `embedded_at IS NULL` are embedded; merged duplicates and raw logs/evidence never are.
 * - The embedded text is `summary + resolution`, redacted and length-bounded by
 *   `generateEmbedding` before any outbound request, sent only through the
 *   DNS-pinned public HTTPS egress client.
 * - The normalized vector plus provenance (`embedding_model`,
 *   `embedding_provider_id`, `embedded_at`) is persisted; failures never block
 *   investigations, they just leave the row pending for a later tick.
 */

/** Maximum memory rows embedded per tick. */
export const MEMORY_EMBEDDING_BATCH_SIZE = 5;

export type EmbedFn = (connection: ProviderConnection, text: string) => Promise<GeneratedEmbedding>;

type EmbeddingProviderRow = {
  id: string;
  protocol: ProviderProtocol;
  base_url: string;
  default_model: string;
  api_key_ciphertext: string;
};

type PendingMemoryRow = { id: string; summary: string; resolution: string };

/** Embeddings are opt-in via environment; never silently call paid external APIs. */
export function memoryEmbeddingsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPSPILOT_MEMORY_EMBEDDINGS_ENABLED === "true";
}

const vectorColumnCache = new WeakMap<SQL, Promise<boolean>>();

/** True when migration 014 found pgvector and added the native `embedding_vector` column. */
async function hasEmbeddingVectorColumn(db: SQL): Promise<boolean> {
  let cached = vectorColumnCache.get(db);
  if (!cached) {
    cached = db<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'incident_memory' AND column_name = 'embedding_vector'
      ) AS exists
    `.then((rows) => rows[0]?.exists === true).catch(() => false);
    vectorColumnCache.set(db, cached);
  }
  return cached;
}

/** Validated finite vectors only; the joined literal is never user text. */
function floatArrayLiteral(vector: readonly number[]): string {
  return `{${vector.join(",")}}`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export type IndexPendingMemoryEmbeddingsOptions = {
  /** Overrides the env flag; default `memoryEmbeddingsEnabled()`. */
  enabled?: boolean;
  /** Batch size, clamped to [1, MEMORY_EMBEDDING_BATCH_SIZE]. */
  batchSize?: number;
};

/**
 * Embeds up to `MEMORY_EMBEDDING_BATCH_SIZE` consented, not-yet-embedded memory rows.
 * Returns the number of rows successfully embedded. Skips cleanly (returning 0)
 * when disabled, when no master key is available, or when no embedding-capable
 * provider is configured.
 */
export async function indexPendingMemoryEmbeddings(
  db: SQL,
  masterKey: Uint8Array | null,
  embedFn: EmbedFn = generateEmbedding,
  options: IndexPendingMemoryEmbeddingsOptions = {},
): Promise<number> {
  const enabled = options.enabled ?? memoryEmbeddingsEnabled();
  if (!enabled || !masterKey) return 0;

  const providers = await db<EmbeddingProviderRow[]>`
    SELECT id, protocol, base_url, default_model, api_key_ciphertext
    FROM ai_providers
    WHERE enabled = TRUE AND protocol IN ('openai-compatible', 'gemini')
    ORDER BY created_at, id
    LIMIT 1
  `;
  const provider = providers.find((row) => supportsEmbeddings(row.protocol));
  if (!provider) return 0;

  const batchSize = Math.min(
    MEMORY_EMBEDDING_BATCH_SIZE,
    Math.max(1, Math.trunc(options.batchSize ?? MEMORY_EMBEDDING_BATCH_SIZE)),
  );

  const pending = await db.begin(async (tx) => {
    const rows = await tx<PendingMemoryRow[]>`
      SELECT id, summary, resolution
      FROM incident_memory
      WHERE canonical_memory_id IS NULL
        AND embedding_consent = TRUE
        AND embedded_at IS NULL
      ORDER BY created_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    return rows;
  });
  if (!pending.length) return 0;

  let connection: ProviderConnection;
  try {
    connection = {
      id: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.base_url,
      apiKey: decryptProviderKey(provider.id, provider.api_key_ciphertext, masterKey),
      model: provider.default_model,
    };
  } catch {
    return 0;
  }

  const useVectorColumn = await hasEmbeddingVectorColumn(db);
  let processed = 0;
  for (const row of pending) {
    try {
      // Redact before ANY embed function (generateEmbedding redacts again before
      // the outbound request); only curated summary+resolution is ever embedded.
      const text = redact(`${row.summary}\n${row.resolution}`).slice(0, 4000);
      const embedding = await embedFn(connection, text);
      if (
        !embedding ||
        !Array.isArray(embedding.vector) ||
        embedding.vector.length === 0 ||
        embedding.vector.length > MAX_EMBEDDING_DIMENSIONS ||
        !embedding.vector.every((component) => typeof component === "number" && Number.isFinite(component))
      ) {
        continue;
      }
      const values = floatArrayLiteral(embedding.vector);
      if (useVectorColumn) {
        await db`
          UPDATE incident_memory SET
            embedding_values = ${values}::float8[],
            embedding_dimensions = ${embedding.dimensions},
            embedding_model = ${embedding.model},
            embedding_provider_id = ${provider.id},
            embedded_at = NOW()
          WHERE id = ${row.id} AND embedded_at IS NULL
        `;
        await db`
          UPDATE incident_memory SET embedding_vector = ${vectorLiteral(embedding.vector)}::vector
          WHERE id = ${row.id} AND embedding_vector IS NULL
        `;
      } else {
        await db`
          UPDATE incident_memory SET
            embedding_values = ${values}::float8[],
            embedding_dimensions = ${embedding.dimensions},
            embedding_model = ${embedding.model},
            embedding_provider_id = ${provider.id},
            embedded_at = NOW()
          WHERE id = ${row.id} AND embedded_at IS NULL
        `;
      }
      processed++;
    } catch (error) {
      // A failed embedding never blocks investigations; the row stays pending.
      console.error("Memory embedding failed", row.id, error instanceof Error ? error.name : "unknown");
    }
  }
  return processed;
}
