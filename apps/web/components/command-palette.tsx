"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { Host } from "@opspilot/contracts";
import { Button, Input } from "./ui";
import type { WorkspacePath } from "../lib/workspace-path";

const filters = [
  ["all", "All"],
  ["hosts", "Hosts"],
  ["services", "Services"],
  ["incidents", "Incidents"],
  ["actions", "Actions"],
] as const;

type Filter = typeof filters[number][0];
type ResourceCategory = "hosts" | "incidents";
export type PaletteIncident = { id: string; title: string; hostname: string; status: string };
type Target =
  | { category: ResourceCategory; id: string }
  | { category: "actions"; id: WorkspacePath };

const icons = {
  search: "m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  close: "m6 6 12 12M6 18 18 6",
  host: "M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01",
  incident: "m10.6 4.3-8 14A1.5 1.5 0 0 0 4 20.5h16a1.5 1.5 0 0 0 1.3-2.2l-8-14a1.5 1.5 0 0 0-2.6 0ZM12 9v4m0 3h.01",
  enroll: "M12 5v14M5 12h14",
  providers: "M3 7h4m4 0h10M3 17h10m4 0h4M7 4v6m10 4v6",
  memory: "M12 6v15M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3z",
  overview: "M3 3h7v10H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 17h7v4H3z",
  services: "m12 2 10 5-10 5L2 7z M2 12l10 5 10-5 M2 17l10 5 10-5",
  drift: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h5",
} as const;

type Icon = keyof typeof icons;
type Entry = Target & { key: string; title: string; description: string; label: string; icon: Icon; search: string };
type Group = { title: string; entries: Entry[] };

function page(id: WorkspacePath, title: string, description: string, icon: Icon, keywords = "", label = "Page"): Entry {
  return { category: "actions", id, key: id, title, description, label, icon, search: `${title.toLowerCase()} ${keywords}` };
}

const quickActions = [
  page("/connect", "Connect server", "Set up a Linux host with OpsPilot", "enroll", "enroll host add", "Action"),
  page("/providers", "Provider settings", "Manage AI connections and models", "providers", "ai connections models", "Settings"),
  page("/memory", "Incident memory", "Browse human-confirmed resolutions", "memory", "resolutions", "Action"),
];
const services = page("/services", "Services", "View selected-host systemd status and endpoint checks", "services", "workload systemd endpoint");
const pages = [
  page("/", "Overview", "View fleet readings against configured limits", "overview", "dashboard fleet"),
  services,
  page("/hosts", "Hosts", "Browse hosts and resource history", "host", "inventory"),
  page("/incidents", "Incidents", "Review the incident queue and evidence", "incident"),
  page("/new-monitor", "New monitor", "Open Add service setup", "enroll", "add service endpoint"),
  page("/drift", "Configuration drift", "Review recorded configuration hash changes", "drift"),
];
const actions = [...quickActions, ...pages];

function PaletteIcon({ icon }: { icon: Icon }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[icon]} /></svg>;
}

function resourceGroups(hosts: Host[], incidents: PaletteIncident[]) {
  return {
    hosts: hosts.map((host): Entry => ({
      category: "hosts", id: host.id, key: `host-${host.id}`, title: host.hostname,
      description: host.status === "online" ? "Agent online" : "Agent offline", label: "Host", icon: "host",
      search: `${host.hostname} ${host.id}`.toLowerCase(),
    })),
    incidents: incidents.map((incident): Entry => ({
      category: "incidents", id: incident.id, key: `incident-${incident.id}`, title: incident.title,
      description: `${incident.status === "resolved" ? "Resolved incident" : "Open incident"} · ${incident.hostname}`,
      label: "Incident", icon: "incident", search: incident.title.toLowerCase(),
    })),
    services: [services],
    actions,
  };
}

export function CommandPalette({ id, ref, hosts, incidents, onInspectHost, onOpenIncident, onNavigate }: {
  id: string;
  ref: Ref<{ open: () => void }>;
  hosts: Host[];
  incidents: PaletteIncident[];
  onInspectHost: (id: string) => void;
  onOpenIncident: (id: string) => void;
  onNavigate: (href: WorkspacePath) => void;
}) {
  const resultsId = `${id}-results`;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  const open = useCallback(() => {
    if (dialog.current?.open) return;
    setQuery("");
    setFilter("all");
    setActiveKey(null);
    dialog.current?.showModal();
    if (results.current) results.current.scrollTop = 0;
    input.current?.focus();
  }, []);
  useImperativeHandle(ref, () => ({ open }), [open]);

  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey ||
          !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (dialog.current?.open) dialog.current.close();
      else open();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [open]);

  const term = query.trim();
  const words = term.toLowerCase().split(/\s+/);
  const resources = useMemo(() => resourceGroups(hosts, incidents), [hosts, incidents]);
  const groups: Group[] = [];
  if (filter === "all" && !term) {
    const opened = recent.flatMap(key => {
      const match = resources.hosts.find(entry => entry.key === key) ?? resources.incidents.find(entry => entry.key === key);
      return match ? [match] : [];
    });
    if (opened.length) groups.push({ title: "Recently opened", entries: opened });
    else {
      const suggested = [...resources.hosts.slice(0, 2), ...resources.incidents.slice(0, 1)];
      if (suggested.length) groups.push({ title: "Suggested", entries: suggested });
    }
    groups.push({ title: "Quick actions", entries: quickActions }, { title: "Pages", entries: pages });
  } else {
    for (const [category, label] of filters) {
      if (category === "all" || (filter === "all" ? category === "services" : category !== filter)) continue;
      const entries = term ? resources[category].filter(entry => words.every(word => entry.search.includes(word))) : resources[category];
      if (entries.length) {
        const count = `${entries.length} ${entries.length === 1 ? "result" : "results"}`;
        groups.push({ title: term ? `${label} · ${count} for “${term}”` : label, entries });
      }
    }
  }
  const entries = groups.flatMap(group => group.entries);
  const active = entries.find(entry => entry.key === activeKey) ?? entries[0];
  const optionId = (entry: Entry) => `${resultsId}-${entry.key}`;

  function resetSelection() {
    setActiveKey(null);
    if (results.current) results.current.scrollTop = 0;
  }

  function choose(entry: Entry) {
    if (entry.category !== "actions") setRecent(previous => [entry.key, ...previous.filter(key => key !== entry.key)].slice(0, 3));
    dialog.current?.close();
    if (entry.category === "actions") onNavigate(entry.id);
    else if (entry.category === "hosts") onInspectHost(entry.id);
    else onOpenIncident(entry.id);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !active) return;
    if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = (entries.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      const next = entries[index];
      setActiveKey(next.key);
      document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <dialog ref={dialog} id={id} className="command-palette" aria-label="Command palette" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="command-search">
        <PaletteIcon icon="search" />
        <Input ref={input} type="text" className="command-input" placeholder="Search or run a command…" autoComplete="off" enterKeyHint="go"
          role="combobox" aria-label="Search commands" aria-autocomplete="list" aria-expanded="true" aria-controls={resultsId} aria-activedescendant={active && optionId(active)}
          value={query} onChange={event => { setQuery(event.target.value); resetSelection(); }} onKeyDown={onSearchKeyDown} />
        {query && <Button size="sm" variant="ghost" className="command-icon-button" aria-label="Clear search" onClick={() => { setQuery(""); resetSelection(); input.current?.focus(); }}><PaletteIcon icon="close" /></Button>}
        <Button size="sm" variant="ghost" className="command-icon-button" aria-label="Close command palette" onClick={() => dialog.current?.close()}><kbd>Esc</kbd></Button>
      </div>
      <div className="command-filters" role="group" aria-label="Filter commands">
        {filters.map(([value, label]) => (
          <Button key={value} size="sm" variant="ghost" aria-pressed={filter === value} onClick={() => { setFilter(value); resetSelection(); input.current?.focus(); }}>{label}</Button>
        ))}
      </div>
      <div className="command-scroll" ref={results}>
        <div className="command-results" id={resultsId} role="listbox" aria-label="Commands">
          {groups.map((group, index) => (
            <div className="command-group" key={index} role="group" aria-labelledby={`${resultsId}-group-${index}`}>
              <div className="command-group-title" id={`${resultsId}-group-${index}`}>{group.title}</div>
              {group.entries.map(entry => (
                <div id={optionId(entry)} key={entry.key} role="option" aria-selected={entry.key === active?.key} className="command-option"
                  aria-label={`${entry.title}, ${entry.label}`} aria-describedby={`${optionId(entry)}-description`}
                  onPointerMove={event => { if (event.pointerType === "mouse") setActiveKey(entry.key); }}
                  onMouseDown={event => event.preventDefault()} onClick={() => choose(entry)}>
                  <PaletteIcon icon={entry.icon} />
                  <span className="command-option-copy"><span>{entry.title}</span><small id={`${optionId(entry)}-description`}>{entry.description}</small></span>
                  <span className="command-option-meta" aria-hidden="true">{entry.key === active?.key ? <>Open <kbd>Enter</kbd></> : entry.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {!entries.length ? (
          <div className="command-message" role="status">
            <strong>No results</strong>
            <p>{term ? <>Nothing matches “{term}”. Try a different search or filter.</> : "Nothing to show in this category yet."}</p>
          </div>
        ) : term && filter === "all" && <p className="command-tip">Search by host name, incident title, or page name</p>}
        {filter === "services" && <p className="command-tip">Open Services to view the configured systemd unit for a selected host and endpoint checks. Individual units and endpoints are not searched here.</p>}
      </div>
      <div className="command-help" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> Select</span>
        <span><kbd>Enter</kbd> Open</span>
        <span><kbd>Esc</kbd> Close</span>
        <kbd className="command-help-shortcut">Ctrl K</kbd>
      </div>
    </dialog>
  );
}
