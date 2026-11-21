"use client";

import { useEffect, useState } from "react";
import { AsciiLoading } from "../../../components/ascii-card-reveal";
import { Badge, Field, Input, Notice, Panel } from "../../../components/ui";
import { api } from "../../../lib/api";
import { WorkspaceHeader } from "../workspace-header";

type Memory = { id: string; summary: string; resolution: string; created_at: string };
type MemoryRead = { records: Memory[]; error?: never } | { records?: never; error: string };

export default function MemoryPage() {
  const [search, setSearch] = useState("");
  const [memoryRead, setMemoryRead] = useState<MemoryRead | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api(`/memory?q=${encodeURIComponent(search)}`, "GET", undefined, signal)
      .then((records: Memory[]) => { if (!signal.aborted) setMemoryRead({ records }); })
      .catch((cause: unknown) => {
        if (!signal.aborted) setMemoryRead({ error: cause instanceof Error ? cause.message : "Unable to load incident memory." });
      });
    return () => controller.abort();
  }, [search]);

  return <>
    <WorkspaceHeader title="Incident memory" description="Human-confirmed resolutions from previous investigations." />
    <Panel role="region" aria-labelledby="memory-title">
      <div className="panel-head"><div><h2 id="memory-title">Resolved incident knowledge</h2><p>Full-text incident retrieval for future investigations</p></div></div>
      <Field id="memory-search" label="Search confirmed resolutions"><Input id="memory-search" type="search" value={search} onChange={e => {
        setSearch(e.target.value);
        setMemoryRead(null);
      }} placeholder="Search symptoms, service, resolution…" /></Field>
      {!memoryRead ? <AsciiLoading label="Loading incident memory…" lines={3} />
        : memoryRead.records ? memoryRead.records.length === 0 ? <p className="empty">No matching resolved incidents yet.</p>
          : memoryRead.records.map(m => <div key={m.id} className="memory"><Badge tone="success">Human-confirmed</Badge><h3>{m.summary}</h3><p>{m.resolution}</p><small>{new Date(m.created_at).toLocaleString()}</small></div>)
        : <Notice tone="warning" role="alert">Incident memory unavailable: {memoryRead.error}</Notice>}
    </Panel>
  </>;
}
