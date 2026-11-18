"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Host } from "@opspilot/contracts";
import { BrandMark } from "./brand-mark";
import { Button, Input } from "./ui";

const icons = {
  overview: "M3 3h7v10H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 17h7v4H3z",
  services: "m12 2 10 5-10 5L2 7z M2 12l10 5 10-5 M2 17l10 5 10-5",
  hosts: "M5 3h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M7 7h.01 M7 17.5h.01",
  incidents: "M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  search: "M15.5 15.5 21 21 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  add: "M12 5v14 M5 12h14",
  settings: "M3 6h3m4 0h11M3 17h11m4 0h3M8 4v4m8 7v4",
  terminal: "m4 6 6 6-6 6 M13 18h7",
  refresh: "M20 7a8 8 0 1 0 .2 9 M20 3v5h-5",
  arrow: "M6 18 18 6 M8 6h10v10",
  back: "M20 12H4m6-6-6 6 6 6",
  clock: "M12 6v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z",
  drift: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h5",
  memory: "M12 5v16 M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3z",
  close: "m6 6 12 12 M18 6 6 18",
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof icons }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const dock = [
  { id: "overview", label: "Overview" }, { id: "services", label: "Services" },
  { id: "hosts", label: "Hosts" }, { id: "incidents", label: "Incidents" },
] as const;

const commands = [
  ...dock,
  { id: "connect", label: "Connect server" }, { id: "new-monitor", label: "New monitor" },
  { id: "drift", label: "Configuration drift" }, { id: "memory", label: "Incident memory" },
  { id: "providers", label: "Provider settings" },
] as const;

export type WorkspacePage = (typeof commands)[number]["id"];

type Props = {
  page: WorkspacePage;
  onNavigate: (page: WorkspacePage) => void;
  onInspectHost: (id: string) => void;
  hosts: Host[];
  incidents: number | null;
  incidentsStale: boolean;
  busy: boolean;
  onSignOut?: () => void;
  children: ReactNode;
};

export function WorkspaceShell({ page, onNavigate, onInspectHost, hosts, incidents, incidentsStale, busy, onSignOut, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const account = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const matches = commands.filter(item => item.label.toLowerCase().includes(term));
  const matchingHosts = term ? hosts.filter(host => host.hostname.toLowerCase().includes(term)) : [];

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (!dialog.current?.open) dialog.current?.showModal();
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  function navigate(next: WorkspacePage) {
    dialog.current?.close();
    if (account.current) account.current.open = false;
    onNavigate(next);
  }

  function inspect(id: string) {
    dialog.current?.close();
    onInspectHost(id);
  }

  return (
    <div className="shell" data-setup={page === "connect" || page === "new-monitor"}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <Button variant="ghost" className="workspace-brand" onClick={() => navigate("overview")}><BrandMark size={25} />opspilot</Button>
          <span className="workspace-scope"><span aria-hidden="true">/</span> Local workspace</span>
          <div className="workspace-tools">
            <Button variant="ghost" className="workspace-jump" onClick={() => dialog.current?.showModal()} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" aria-label="Jump to…">
              <WorkspaceIcon name="search" /><span>Jump to…</span><kbd>Ctrl K</kbd>
            </Button>
            <Button variant="ghost" className="workspace-settings" aria-label="Provider settings" title="Provider settings" onClick={() => navigate("providers")}><WorkspaceIcon name="settings" /></Button>
            <details className="workspace-account" ref={account}>
              <summary title="Admin menu" aria-label="Admin menu">AD</summary>
              <div className="workspace-account-menu">
                <Button variant="ghost" onClick={() => navigate("drift")}>Configuration drift</Button>
                <Button variant="ghost" onClick={() => navigate("memory")}>Incident memory</Button>
                {onSignOut && <Button variant="ghost" disabled={busy} onClick={() => { if (account.current) account.current.open = false; onSignOut(); }}>Sign out</Button>}
              </div>
            </details>
          </div>
        </div>
      </header>
      {children}
      {page !== "connect" && page !== "new-monitor" && <nav className="workspace-dock" aria-label="Main navigation">
        {dock.map(item => <Button key={item.id} variant="ghost" className={`dock-item${item.id === "incidents" && !!incidents && !incidentsStale ? " dock-risk" : ""}`} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>
          <WorkspaceIcon name={item.id} /><span>{item.label}{item.id === "incidents" && !!incidents && <small className="dock-count" data-cached={incidentsStale}><span aria-hidden="true">{incidents}</span><span className="sr-only">{`, ${incidents} open${incidentsStale ? " (cached)" : ""}`}</span></small>}</span>
        </Button>)}
        <span className="dock-divider" aria-hidden="true" />
        <Button variant="ghost" className="dock-item dock-search" aria-label="Open command search" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}><WorkspaceIcon name="search" /><kbd>Ctrl K</kbd></Button>
        <Button variant="primary" className="dock-add" aria-label="New monitor" title="New monitor" onClick={() => navigate("new-monitor")}><WorkspaceIcon name="add" /></Button>
      </nav>}
      <dialog className="command-dialog" ref={dialog} onClose={() => setQuery("")} aria-labelledby="command-title">
        <div className="command-heading"><h2 id="command-title">Jump to</h2><Button variant="ghost" aria-label="Close command search" onClick={() => dialog.current?.close()}><WorkspaceIcon name="close" /></Button></div>
        <Input type="search" autoFocus aria-label="Find a page or host" placeholder="Find a page or host…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
          if (e.key !== "Enter") return;
          if (matches[0]) navigate(matches[0].id);
          else if (matchingHosts[0]) inspect(matchingHosts[0].id);
        }} />
        <div className="command-results">
          {matches.map(item => <Button key={item.id} variant="ghost" onClick={() => navigate(item.id)}>{item.label}<WorkspaceIcon name="arrow" /></Button>)}
          {matchingHosts.map(host => <Button key={host.id} variant="ghost" onClick={() => inspect(host.id)}>{host.hostname}<span className="muted">Host</span></Button>)}
          {!matches.length && !matchingHosts.length && <p className="muted" role="status">No pages or hosts match “{query}”.</p>}
        </div>
      </dialog>
    </div>
  );
}
