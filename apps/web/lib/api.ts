import type { DriftDetailResponse, DriftTimelineResponse, EvidenceRelevance, ProviderProtocol } from "@opspilot/contracts";

export type { DriftDetailResponse, DriftTimelineEntry, DriftTimelineResponse, SemanticDiffChange, SemanticDiffResult } from "@opspilot/contracts";

/** Evidence item as returned by GET /api/incidents/:id. `relevance` is deterministic (no LLM), added server-side. */
export type IncidentEvidence = {
  id: string;
  source: string;
  content: string;
  created_at: string;
  relevance?: EvidenceRelevance;
};

/** Optional token/cost metadata an investigation may carry; all fields optional and nullable. */
export type InvestigationUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  thinking_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost_usd?: number | null;
};

export type InvestigationResultJson = {
  probable_cause?: string;
  confidence?: number | string;
  evidence_ids?: string[];
  missing_evidence?: string[];
  recommended_checks?: string[];
};

export type Investigation = InvestigationUsage & {
  id: string;
  provider: { id: string | null; name: string; protocol: ProviderProtocol; baseUrl: string | null; model: string | null };
  status: string;
  result_json: InvestigationResultJson | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type IncidentDetailResponse<TIncident> = {
  incident: TIncident;
  evidence: IncidentEvidence[];
  investigations: Investigation[];
};

/** Fetches one incident with its scored evidence and investigations. */
export async function getIncidentDetail<TIncident>(id: string, signal?: AbortSignal): Promise<IncidentDetailResponse<TIncident>> {
  return api(`/incidents/${encodeURIComponent(id)}`, "GET", undefined, signal) as Promise<IncidentDetailResponse<TIncident>>;
}

/** Fetches the drift timeline (`GET /api/drift`), optionally filtered by host and/or path. */
export async function getDriftTimeline(params: { agentId?: string; filePath?: string; limit?: number } = {}, signal?: AbortSignal): Promise<DriftTimelineResponse> {
  const query = new URLSearchParams();
  if (params.agentId) query.set("agentId", params.agentId);
  if (params.filePath) query.set("filePath", params.filePath);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.size ? `?${query.toString()}` : "";
  return api(`/drift${suffix}`, "GET", undefined, signal) as Promise<DriftTimelineResponse>;
}

/** Fetches one drift snapshot transition with its redacted semantic diff (`GET /api/drift/:id`). */
export async function getDriftDetail(id: string, signal?: AbortSignal): Promise<DriftDetailResponse> {
  return api(`/drift/${encodeURIComponent(id)}`, "GET", undefined, signal) as Promise<DriftDetailResponse>;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api(path: string, method = "GET", payload?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
    signal,
  });
  signal?.throwIfAborted();
  if (response.status === 401) {
    window.dispatchEvent(new Event("opspilot-unauthorized"));
    throw new ApiError("Unauthorized", null, 401);
  }
  const data = await response.json();
  if (!response.ok) {
    const code = typeof data?.code === "string" && /^[a-z_]{1,80}$/.test(data.code) ? data.code : null;
    throw new ApiError(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`, code, response.status);
  }
  return data;
}
