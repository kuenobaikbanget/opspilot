"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Host } from "@opspilot/contracts";
import { Button, Input } from "./ui";

const filters = [
  ["all", "All"],
  ["hosts", "Hosts"],
  ["services", "Services"],
  ["incidents", "Incidents"],
  ["actions", "Actions"],
] as const;

type Filter = typeof filters[number][0];
type ResourceCategory = "hosts" | "incidents";
type Action = "enroll" | "providers" | "memory";
type Incident = { id: string; title: string; hostname: string; status: string };
type Target =
  | { category: ResourceCategory; id: string }
  | { category: "actions"; id: Action };

const icons = {
  search: "m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  close: "m6 6 12 12M6 18 18 6",
  host: "M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01",
  incident: "m10.6 4.3-8 14A1.5 1.5 0 0 0 4 20.5h16a1.5 1.5 0 0 0 1.3-2.2l-8-14a1.5 1.5 0 0 0-2.6 0ZM12 9v4m0 3h.01",
  enroll: "M12 5v14M5 12h14",
  providers: "M3 7h4m4 0h10M3 17h10m4 0h4M7 4v6m10 4v6",
  memory: "M12 6v15M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3z",
} as const;

type Icon = keyof typeof icons;
type Entry = Target & { key: string; title: string; description: string; label: string; icon: Icon; search: string };
type Group = { title: string; entries: Entry[] };

const actions: Entry[] = [
  { category: "actions", id: "enroll", key: "enroll", title: "Enroll host", description: "Connect a Linux host with OpsPilot", label: "Action", icon: "enroll", search: "enroll host add connect server" },
  { category: "actions", id: "providers", key: "providers", title: "Provider settings", description: "Manage AI connections and models", label: "Settings", icon: "providers", search: "provider settings ai connections models" },
  { category: "actions", id: "memory", key: "memory", title: "Incident memory", description: "Browse human-confirmed resolutions", label: "Action", icon: "memory", search: "incident memory resolutions" },
];

function PaletteIcon({ icon }: { icon: Icon }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[icon]} /></svg>;
}

function resourceGroups(hosts: Host[], incidents: Incident[]) {
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
    actions,
  };
}

export function CommandPalette({ hosts, incidents, onSelect }: {
  hosts: Host[];
  incidents: Incident[];
  onSelect: (target: Target) => void;
}) {
  const id = useId();
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
    groups.push({ title: "Quick actions", entries: actions });
  } else {
    for (const [category, label] of filters) {
      if (category === "all" || category === "services" || (filter !== "all" && category !== filter)) continue;
      const entries = term ? resources[category].filter(entry => words.every(word => entry.search.includes(word))) : resources[category];
      if (entries.length) {
        const count = `${entries.length} ${entries.length === 1 ? "result" : "results"}`;
        groups.push({ title: term ? `${label} · ${count} for “${term}”` : label, entries });
      }
    }
  }
  const entries = groups.flatMap(group => group.entries);
  const active = entries.find(entry => entry.key === activeKey) ?? entries[0];
  const optionId = (entry: Entry) => `${id}-${entry.key}`;

  function resetSelection() {
    setActiveKey(null);
    if (results.current) results.current.scrollTop = 0;
  }

  function choose(entry: Entry) {
    if (entry.category !== "actions") setRecent(previous => [entry.key, ...previous.filter(key => key !== entry.key)].slice(0, 3));
    dialog.current?.close();
    onSelect(entry);
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
    <>
      <Button size="sm" className="command-trigger" aria-label="Open command palette" aria-haspopup="dialog" aria-controls={id} aria-keyshortcuts="Control+K Meta+K" onClick={open}>
        <PaletteIcon icon="search" /><span>Jump to…</span><kbd aria-hidden="true">Ctrl K</kbd>
      </Button>
      <dialog ref={dialog} id={id} className="command-palette" aria-label="Command palette" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="command-search">
          <PaletteIcon icon="search" />
          <Input ref={input} type="text" className="command-input" placeholder="Search or run a command…" autoComplete="off" enterKeyHint="go"
            role="combobox" aria-label="Search commands" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={active && optionId(active)}
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
          <div className="command-results" id={`${id}-results`} role="listbox" aria-label="Commands">
            {groups.map((group, index) => (
              <div className="command-group" key={index} role="group" aria-labelledby={`${id}-group-${index}`}>
                <div className="command-group-title" id={`${id}-group-${index}`}>{group.title}</div>
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
              <strong>{filter === "services" ? "Service search unavailable" : "No results"}</strong>
              <p>{filter === "services" ? "Service inventory and endpoint checks are not collected yet." : term ? <>Nothing matches “{term}”. Try a different search or filter.</> : "Nothing to show in this category yet."}</p>
            </div>
          ) : term && <p className="command-tip">Search by host name, incident title, or action</p>}
        </div>
        <div className="command-help" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Select</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
          <kbd className="command-help-shortcut">Ctrl K</kbd>
        </div>
      </dialog>
    </>
  );
}
