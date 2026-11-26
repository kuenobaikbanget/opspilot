import type {
  ChangeEvent,
  CreateChangeEventRequest,
  DriftDetailResponse,
  DriftTimelineResponse,
  EvidenceRelevance,
  IncidentMemoryRecord,
  IncidentTimelineResponse,
  InvestigationMemoryAttribution,
  LinkIncidentChangeRequest,
  ProviderProtocol,
} from "@opspilot/contracts";

export type { DriftDetailResponse, DriftTimelineEntry, DriftTimelineResponse, SemanticDiffChange, SemanticDiffResult } from "@opspilot/contracts";
export type { IncidentMemoryRecord, InvestigationMemoryAttribution, MemorySourceProvenance } from "@opspilot/contracts";

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
  /** Bounded snapshot of prior memories this investigation retrieved; null for legacy/active rows. */
  retrieved_memories?: InvestigationMemoryAttribution[] | null;
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

/** Unified non-causal incident timeline (lifecycle, evidence, investigations, same-host changes). */
export async function getIncidentTimeline(
  id: string,
  params?: { beforeMinutes?: number; afterMinutes?: number },
  signal?: AbortSignal,
): Promise<IncidentTimelineResponse> {
  const query = params
    ? `?${new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])))}`
    : "";
  return api(`/incidents/${encodeURIComponent(id)}/timeline${query}`, "GET", undefined, signal) as Promise<IncidentTimelineResponse>;
}

/** Lists recent change events, optionally filtered by host and kind (server caps limit at 100). */
export async function listChangeEvents(
  params?: { agentId?: string; kind?: string; limit?: number },
  signal?: AbortSignal,
): Promise<{ changes: ChangeEvent[]; limit: number }> {
  const query = params
    ? `?${new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])))}`
    : "";
  return api(`/changes${query}`, "GET", undefined, signal) as Promise<{ changes: ChangeEvent[]; limit: number }>;
}

/** Records a deployment/config change/service restart/maintenance on a host. */
export async function createChangeEvent(payload: CreateChangeEventRequest): Promise<{ change: ChangeEvent }> {
  return api("/changes", "POST", payload) as Promise<{ change: ChangeEvent }>;
}

/** Links or dismisses a change target (change event or config snapshot) on an incident. */
export async function linkIncidentChange(incidentId: string, payload: LinkIncidentChangeRequest): Promise<{ link: unknown }> {
  return api(`/incidents/${encodeURIComponent(incidentId)}/changes`, "POST", payload) as Promise<{ link: unknown }>;
}

/** Removes a manual link/dismissal so a nearby change is shown again. */
export async function deleteIncidentChangeLink(incidentId: string, linkId: string): Promise<{ ok: boolean }> {
  return api(`/incidents/${encodeURIComponent(incidentId)}/changes/${encodeURIComponent(linkId)}`, "DELETE") as Promise<{ ok: boolean }>;
}

/** Lists canonical incident memories with provenance + retrieval metadata, optionally filtered by `q`. */
export async function listMemories(q: string, signal?: AbortSignal): Promise<IncidentMemoryRecord[]> {
  return api(`/memory?q=${encodeURIComponent(q)}`, "GET", undefined, signal) as Promise<IncidentMemoryRecord[]>;
}

/** Merges the source canonical memory into the target canonical memory; returns the updated target. */
export async function mergeMemories(sourceMemoryId: string, targetMemoryId: string): Promise<IncidentMemoryRecord> {
  const result = await api("/memory/merge", "POST", { sourceMemoryId, targetMemoryId }) as { ok: boolean; memory: IncidentMemoryRecord };
  return result.memory;
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
