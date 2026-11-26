# AI Investigation Design

## Role of the LLM

LLM is **not a monitoring agent and not an executor**. It receives bounded evidence from already-implemented read-only tools and produces a hypothesis / next checks. Monitoring/alerting still functions without AI.

## Provider interface (BYOK)

Stored connections use a UUID identity and one of three protocols:

| Protocol | API suffix | Authentication |
|---|---|---|
| `openai-compatible` | `/chat/completions` | Bearer |
| `anthropic` | `/messages` | x-api-key, anthropic-version 2023-06-01 |
| `gemini` | `/models/<encoded-model>:generateContent` | x-goog-api-key |

Admin chooses connection and explicit model manually; there is no OAuth, discovery, retry, downgrade or fallback. OpenAI Responses-only endpoints are not Chat Completions-compatible. Presets in contracts are editable defaults, not promises of vendor/model availability.

Keys are encrypted in PostgreSQL using the server-only master environment key, never read from legacy provider environment variables at runtime. See [credential and egress controls](SECURITY.md#ai-connection-credentials-and-egress) and [cutover](DEPLOYMENT.md#ai-provider-cutover).

Gemini 2.5 text-thinking families (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, including `-preview[-<date>]` and three-digit version suffixes) receive an explicit 1024-token thinking budget and a 2224-token combined generation cap, leaving 1200 tokens of answer headroom when the thinking budget is consumed. This modest reasoning allowance is a cost/quality tradeoff, not a guarantee of diagnosis quality or complete JSON. [Google's thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking#thinking-budget) documents Flash's 0–24576, Flash-Lite's 512–24576 and Pro's 128–32768 thinking ranges, dynamic thinking defaults for Flash/Pro, and that thinking plus answer tokens share `maxOutputTokens` and are billed as output. A 1200-token combined cap alone can therefore starve the answer.

This is a conservative text-model family policy, not model discovery or substitution: the selected model is sent unchanged. Image/audio/live variants, legacy models, future generations and unrecognized custom names retain the 1200-token generation cap without `thinkingConfig`; the [API rejects thinking configuration on non-thinking models](https://ai.google.dev/api/generate-content#ThinkingConfig). Unsupported endpoints/models fail without retry or fallback. Other model families need an explicit reviewed budget policy before assuming they offer the same reasoning/answer allocation.

## Workflow

1. Admin reviews the enabled connection destination, revision and explicit model before submitting the incident.
2. Hub validates credentials/revision before dispatching existing fixed agent operations, then rechecks configuration and incident state under lock.
3. Hub queues an investigation with an immutable non-secret provider snapshot.
4. Worker reads a queued candidate without locking it, locks its provider row first, then conditionally claims that exact still-queued job with FOR UPDATE SKIP LOCKED before checking revision/decrypting credentials. Provider-first row locking matches connection deletion's foreign-key lock order and avoids a delete/claim deadlock; unavailable/changed connections fail without outbound calls.
5. Worker redacts common credential patterns, caps context, then uses public DNS-pinned HTTPS with a 30-second total deadline and finite generation budget (1200 tokens, or 2224 combined thinking/answer tokens for the Gemini 2.5 text families above). The untrusted evidence/memory payload is wrapped in explicit `BEGIN/END UNTRUSTED INPUT` delimiters so log strings cannot impersonate instructions.
6. Strict post-processor validates result fields, redacts echoed secrets, and removes every `evidence_id` absent from database input; forces low confidence when no valid evidence IDs remain. The Worker persists the provider-reported token usage and an optional catalog-based USD estimate on the investigation row plus a non-secret `ai.investigation.completed` audit event (observability only; no hard budget block yet).
7. UI displays hypothesis, confidence and next checks; human chooses what to do.
8. Human-supplied resolution is stored for future retrieval.

## Output schema

```json
{
  "probable_cause": "Nginx cannot reach application upstream",
  "confidence": "medium",
  "evidence_ids": ["uuid-for-stored-evidence"],
  "missing_evidence": ["application logs for last restart"],
  "recommended_checks": ["Verify the application process status"]
}
```

No answer is treated as guaranteed correct. Display **hypothesis**, not "root cause confirmed", until verified by human and additional checks.

## Prompt-injection protection (partial)

- Retrieved logs, config paths, error strings and incident memory are **untrusted data**.
- No provider receives tool-execution access in starter.
- Reject provider-supplied evidence IDs not minted by DB.
- Never construct shell command or escalation instructions from model output.
- Do not send broad system journals, key files or raw entire configuration content.
- Regex redaction for `token/password/api_key/secret` is only a first line. It **will miss** many secrets, PII, URLs and encodings. Add robust secret detectors, configurable allowlists, preview/consent and synthetic tests before production ingestion.

## Incident memory architecture

**Hybrid retrieval (FTS + optional embeddings) is implemented** (migration `014_memory_embeddings_hybrid.sql`). Every resolved incident stores `{incident_id, title summary, human resolution}`; retrieval runs a bounded PostgreSQL FTS leg (`to_tsvector('simple', summary || ' ' || resolution) @@ plainto_tsquery('simple', q)` ranked by `ts_rank_cd`) and, when a query embedding is available, a vector leg (native pgvector `<=>` cosine distance when the extension is installed, otherwise an exact bounded cosine-similarity fallback over the persisted `embedding_values DOUBLE PRECISION[]`). Both rankings are fused with Reciprocal Rank Fusion (`reciprocalRankFusion`, k=60), tie-broken by score, `created_at` desc, `id` asc. `GET /api/memory` and the Worker's `prior_resolutions` context both go through `searchIncidentMemories`; each result carries `retrieval_method`, `fts_score`, `vector_score`, `hybrid_score` and `embedding_model`.

Embeddings are **strictly opt-in**: they run only when `OPSPILOT_MEMORY_EMBEDDINGS_ENABLED=true`, a server master key exists, an enabled `openai-compatible`/`gemini` provider is configured, and the individual memory row has `embedding_consent = TRUE` (set explicitly when a human resolves an incident). Only curated human-confirmed `summary + resolution` is embedded — redacted via `redact()` and length-bounded before any outbound request, sent only through the DNS-pinned public HTTPS egress client (`postProviderJson`) — never raw logs or unredacted evidence. Provenance (`embedding_model`, `embedding_provider_id`, `embedded_at`, `embedding_dimensions`) is persisted with the normalized vector. `anthropic` connections are rejected with a typed `embedding_unsupported` error without any network request (Anthropic reasoning models do not imply an Anthropic embedding service), so Anthropic-only deployments run FTS-only retrieval. The Worker embeds at most 5 consented rows per tick and never blocks or fails investigations when embedding is unavailable.

## Evaluation plan

Maintain 10–20 synthetic reproducible incidents in `tests/incident-fixtures` and a repeat-incident retrieval corpus in `tests/memory-retrieval-fixtures` (18 memory records + 20 query cases: exact-keyword, paraphrase/synonym and distractor). `tests/memory-retrieval.eval.test.ts` measures Recall@1/@3/@5 and MRR for FTS-only, vector-only and hybrid RRF. Measured on the current corpus: **FTS-only Recall@5 = 0.375 / MRR = 0.375** (exact repeats only; paraphrases are invisible to `plainto_tsquery` AND-semantics), **vector-only Recall@5 = 1.0 / MRR = 1.0**, **hybrid RRF Recall@1/@3/@5 = 1.0 / MRR = 1.0** with false-top-1 rate 0 on distractors — hybrid strictly beats FTS-only on Recall@5 and MRR while preserving exact-term top-1 recall, satisfying the Phase 3 exit gate on a measured evaluation set. Real PostgreSQL FTS behavior is covered by `tests/memory-hybrid.integration.test.ts`.

Metrics:

- Root-cause accuracy @top1 against gold label.
- Helpful next-check rate (blind reviewer).
- Evidence citation precision: **100% expected by server validation**; relevance measured separately.
- False confidence rate where evidence insufficient.
- Mean tokens/cost per incident; time-to-first-hypothesis.
- Prompt injection success rate (target zero, must test).
- Recall@5 for incident memory baseline FTS and hybrid retrieval (measured in `tests/memory-retrieval.eval.test.ts`; hybrid must stay strictly above FTS-only on paraphrased repeats).

## Cost guardrails (release blockers)

Current: external generation only after explicit investigation/test actions; bounded context, time, response and output tokens. Investigations run under a per-job worker lease (default 90 s, `WORKER_LEASE_MS`/`WORKER_ID`/`WORKER_RETRY_BACKOFF_MS` on the Worker) with a retry budget of at most `max_attempts` (default 3) per job. Only transient failures retry — provider timeouts, network/DNS errors, expired leases, HTTP 429 and 5xx — with exponential backoff; permanent failures (configuration changes, disabled/unavailable providers, credential errors, invalid responses, other 4xx) fail immediately without replaying the paid call. Expired leases are recovered before new claims and either requeue or terminalize at the budget; stale workers cannot overwrite a recovered row. At most one active (queued/running) investigation exists per incident+provider+revision+model via a partial unique index. Each completed investigation records provider-reported token counts and an optional reference-catalog USD estimate on its row and in a non-secret audit event (no hard budget block yet). A connection test uses the same adapter/parser with synthetic title/category and empty evidence/memory; HTTP 200 alone cannot pass it. Tests have one 90-second queue-inclusive slot; timeout may mean Worker/queue delay, not endpoint failure. Future: daily/monthly budgets, rate limits, spend reporting.
