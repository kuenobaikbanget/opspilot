"use client";

import { useId, useRef, type ComponentRef, type MouseEvent, type ReactNode } from "react";
import type { Host } from "@opspilot/contracts";
import { BrandMark } from "./brand-mark";
import { CommandPalette, type PaletteIncident } from "./command-palette";
import { Button, ButtonLink } from "./ui";
import type { WorkspacePath } from "../lib/workspace-path";

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
  back: "M20 12H4m6-6-6 6 6 6",
  clock: "M12 6v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z",
  drift: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h5",
  memory: "M12 5v16 M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3z",
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof icons }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const dock = [
  { href: "/", icon: "overview", label: "Overview" }, { href: "/services", icon: "services", label: "Services" },
  { href: "/hosts", icon: "hosts", label: "Hosts" }, { href: "/incidents", icon: "incidents", label: "Incidents" },
] as const;

type Props = {
  pathname: string;
  onNavigate: (href: WorkspacePath) => void;
  onInspectHost: (id: string) => void;
  onOpenIncident: (id: string) => void;
  hosts: Host[];
  incidents: PaletteIncident[];
  openIncidents: number | null;
  incidentsStale: boolean;
  busy: boolean;
  onSignOut?: () => void;
  children: ReactNode;
};

export function WorkspaceShell({ pathname, onNavigate, onInspectHost, onOpenIncident, hosts, incidents, openIncidents, incidentsStale, busy, onSignOut, children }: Props) {
  const paletteId = useId();
  const palette = useRef<ComponentRef<typeof CommandPalette>>(null);
  const account = useRef<HTMLDetailsElement>(null);
  const searchTrigger = {
    "aria-haspopup": "dialog",
    "aria-controls": paletteId,
    "aria-keyshortcuts": "Control+K Meta+K",
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.currentTarget.focus({ preventScroll: true });
      palette.current?.open();
    },
  } as const;

  const isSetup = pathname === "/connect" || pathname === "/new-monitor";
  function closeAccount() {
    if (account.current) account.current.open = false;
  }

  return (
    <div className="shell" data-setup={isSetup}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <ButtonLink href="/" variant="ghost" className="workspace-brand" onNavigate={closeAccount}><BrandMark size={25} />opspilot</ButtonLink>
          <span className="workspace-scope"><span aria-hidden="true">/</span> Local workspace</span>
          <div className="workspace-tools">
            <Button variant="ghost" className="workspace-jump" aria-label="Jump to…" {...searchTrigger}>
              <WorkspaceIcon name="search" /><span>Jump to…</span><kbd aria-hidden="true">Ctrl K</kbd>
            </Button>
            <ButtonLink href="/providers" variant="ghost" className="workspace-settings" aria-label="Provider settings" title="Provider settings" aria-current={pathname === "/providers" ? "page" : undefined} onNavigate={closeAccount}><WorkspaceIcon name="settings" /></ButtonLink>
            <details className="workspace-account" ref={account}>
              <summary title="Admin menu" aria-label="Admin menu">AD</summary>
              <div className="workspace-account-menu">
                <ButtonLink href="/drift" variant="ghost" aria-current={pathname === "/drift" ? "page" : undefined} onNavigate={closeAccount}>Configuration drift</ButtonLink>
                <ButtonLink href="/memory" variant="ghost" aria-current={pathname === "/memory" ? "page" : undefined} onNavigate={closeAccount}>Incident memory</ButtonLink>
                {onSignOut && <Button variant="ghost" disabled={busy} onClick={() => { closeAccount(); onSignOut(); }}>Sign out</Button>}
              </div>
            </details>
          </div>
        </div>
      </header>
      {children}
      {!isSetup && <nav className="workspace-dock" aria-label="Main navigation">
        {dock.map(({ href, icon, label }) => <ButtonLink key={href} href={href} variant="ghost" className={`dock-item${href === "/incidents" && !!openIncidents && !incidentsStale ? " dock-risk" : ""}`} aria-current={pathname === href ? "page" : undefined} onNavigate={closeAccount}>
          <WorkspaceIcon name={icon} /><span>{label}{href === "/incidents" && !!openIncidents && <small className="dock-count" data-cached={incidentsStale}><span aria-hidden="true">{openIncidents}</span><span className="sr-only">{`, ${openIncidents} open${incidentsStale ? " (cached)" : ""}`}</span></small>}</span>
        </ButtonLink>)}
        <span className="dock-divider" aria-hidden="true" />
        <Button variant="ghost" className="dock-item dock-search" aria-label="Open command search" {...searchTrigger}><WorkspaceIcon name="search" /><kbd aria-hidden="true">Ctrl K</kbd></Button>
        <ButtonLink href="/new-monitor" variant="primary" className="dock-add" aria-label="New monitor" title="New monitor" onNavigate={closeAccount}><WorkspaceIcon name="add" /></ButtonLink>
      </nav>}
      <CommandPalette id={paletteId} ref={palette} hosts={hosts} incidents={incidents} onInspectHost={onInspectHost} onOpenIncident={onOpenIncident} onNavigate={href => { closeAccount(); onNavigate(href); }} />
    </div>
  );
}
