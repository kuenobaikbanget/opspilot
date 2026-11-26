"use client";

import { useCallback, useEffect, useState } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { Badge, Button, Field, Input, Notice, Panel, Select } from "../../../components/ui";
import { listMemories, mergeMemories, type IncidentMemoryRecord } from "../../../lib/api";
import { WorkspaceHeader } from "../workspace-header";

type MemoryRead = { records: IncidentMemoryRecord[]; error?: never } | { records?: never; error: string };

function shortId(id: string) {
  return id.replace(/-/g, "").slice(0, 6);
}

export default function MemoryPage() {
  const [search, setSearch] = useState("");
  const [memoryRead, setMemoryRead] = useState<MemoryRead | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState("");

  const load = useCallback((q: string, signal: AbortSignal) => {
    return listMemories(q, signal)
      .then((records) => { if (!signal.aborted) setMemoryRead({ records }); })
      .catch((cause: unknown) => {
        if (!signal.aborted) setMemoryRead({ error: cause instanceof Error ? cause.message : "Unable to load incident memory." });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void load(search, signal);
    return () => controller.abort();
  }, [search, reloadToken, load]);

  async function doMerge(sourceId: string, targetId: string) {
    setMerging(true);
    setMergeError("");
    try {
      await mergeMemories(sourceId, targetId);
      setConfirming(null);
      setMergeTarget((current) => ({ ...current, [sourceId]: "" }));
      setReloadToken((token) => token + 1);
    } catch (cause) {
      setMergeError(cause instanceof Error ? cause.message : "Unable to merge memories.");
    } finally {
      setMerging(false);
    }
  }

  const records = memoryRead?.records;

  return <>
    <WorkspaceHeader title="Incident memory" description="Human-confirmed resolutions from previous investigations." />
    <Panel role="region" aria-labelledby="memory-title">
      <div className="panel-head"><div><h2 id="memory-title">Resolved incident knowledge</h2><p>Full-text incident retrieval for future investigations</p></div></div>
      <Field id="memory-search" label="Search confirmed resolutions"><Input id="memory-search" type="search" value={search} onChange={e => {
        setSearch(e.target.value);
        setMemoryRead(null);
      }} placeholder="Search symptoms, service, resolution…" /></Field>
      {mergeError && <Notice tone="danger" role="alert">Memory merge failed: {mergeError}</Notice>}
      <Notice tone="warning">Prior resolutions are fallible context from past incidents — always verify against current measured signals.</Notice>
      {!memoryRead ? <AsciiLoading label="Loading incident memory…" lines={3} />
        : records ? records.length === 0 ? <p className="empty">No matching resolved incidents yet.</p>
          : records.map(m => {
            const sources = m.sources ?? [];
            const others = records.filter(r => r.id !== m.id);
            const targetId = mergeTarget[m.id] ?? "";
            return <div key={m.id} className="memory">
              <div className="memory-badges">
                <Badge tone="success">Human-confirmed prior</Badge>
                {m.occurrence_count > 1 && <Badge tone="info">Confirmed {m.occurrence_count} times</Badge>}
              </div>
              <h3>{m.summary}</h3>
              <p>{m.resolution}</p>
              <small>First recorded {new Date(m.created_at).toLocaleString()} · Last confirmed {new Date(m.last_confirmed_at).toLocaleString()}</small>
              {sources.length > 0 && <>
                <h4 className="memory-sources-title">Source incidents</h4>
                <ul className="memory-sources">
                  {sources.map(s => <li key={s.incident_id}>
                    <span>{s.incident_title ?? s.hostname ?? "Unknown incident"}{s.category ? ` · ${s.category}` : ""}{s.hostname ? ` · ${s.hostname}` : ""}</span>
                    <small>incident {shortId(s.incident_id)} · resolved {new Date(s.resolved_at).toLocaleString()}</small>
                  </li>)}
                </ul>
              </>}
              {others.length > 0 && <div className="memory-merge">
                {confirming === m.id ? <>
                  <span className="memory-merge-label">Merge this memory into the selected one? Sources are preserved.</span>
                  <Button size="sm" variant="danger" loading={merging} disabled={!targetId || merging} onClick={() => void doMerge(m.id, targetId)}>Confirm merge</Button>
                  <Button size="sm" variant="secondary" disabled={merging} onClick={() => setConfirming(null)}>Cancel</Button>
                </> : <>
                  <Select aria-label={`Merge duplicate of incident memory ${shortId(m.id)} into another memory`} value={targetId} onChange={e => {
                    setMergeTarget(current => ({ ...current, [m.id]: e.target.value }));
                    setConfirming(null);
                  }}>
                    <option value="">Merge duplicate into…</option>
                    {others.map(o => <option key={o.id} value={o.id}>{o.summary.slice(0, 60)} ({shortId(o.id)})</option>)}
                  </Select>
                  <Button size="sm" variant="secondary" disabled={!targetId} onClick={() => setConfirming(m.id)}>Merge duplicate</Button>
                </>}
              </div>}
            </div>;
          })
        : <Notice tone="warning" role="alert">Incident memory unavailable: {memoryRead.error}</Notice>}
    </Panel>
  </>;
}
