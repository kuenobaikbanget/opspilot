# AI Investigation Design

## Role of the LLM

LLM is **not a monitoring agent and not an executor**. It receives bounded evidence from already-implemented read-only tools and produces a hypothesis / next checks. Monitoring/alerting still functions without AI.

## Provider interface (BYOK)

Available adapters in `packages/ai`:

| Provider | Key env | Model env | API path |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | Chat Completions, JSON mode |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | Messages API, prompt for JSON |
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` | generateContent, JSON MIME type |

Model strings are configuration, **not promises of perpetual model availability**. Verify current provider APIs, billing limits and model availability before deployment. Each provider key is supplied to Hub/Worker via environment (BYOK). No user key upload or browser-side LLM call.

## Workflow

1. Admin chooses a provider and incident.
2. Hub dispatches fixed agent operations (bounded, optional when offline) and stores results as `evidence`.
3. Hub inserts a `queued` investigation.
4. Worker leases one job, queries evidence + prior human-verified resolutions via Postgres FTS.
5. Worker redacts common credential patterns, caps context, calls provider over HTTPS with 30s timeout.
6. Strict post-processor validates result fields and removes every `evidence_id` absent from database input; forces low confidence when no valid evidence IDs remain.
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

Starter: **resolved-case FTS retrieval**. Store `{incident_id, title summary, human resolution}`; retrieve a small bounded set as context. This is genuinely usable for known error terms, but not vector RAG. No fabricated claim of pgvector implementation.

Roadmap: add hybrid search (FTS + embeddings), index only curated human-confirmed summaries, store embedding provenance + model ID and privacy consent, evaluate recall@k before enabling. OpenAI/Gemini support embedding paths; Anthropic-only deployments need a separate optional embedding source or FTS-only operation.

## Evaluation plan

Maintain 10–20 synthetic reproducible incidents in `tests/incident-fixtures` (planned): Nginx wrong upstream, application down, high disk pressure, OOM, Docker restart loop, service stopped, config drift unrelated to outage, ambiguous multi-cause alert, empty evidence, prompt-injection in logs.

Metrics:

- Root-cause accuracy @top1 against gold label.
- Helpful next-check rate (blind reviewer).
- Evidence citation precision: **100% expected by server validation**; relevance measured separately.
- False confidence rate where evidence insufficient.
- Mean tokens/cost per incident; time-to-first-hypothesis.
- Prompt injection success rate (target zero, must test).
- Recall@5 for incident memory baseline FTS and later hybrid retrieval.

## Cost guardrails (release blockers)

Current: provider call only after explicit admin click; one query per investigation; time and context length caps. Future: daily/monthly budgets, per-provider rate limits, idempotency and retry policy, spend reporting, provider failover policy (opt-in), and encrypted secret storage if BYOK UI is introduced.
