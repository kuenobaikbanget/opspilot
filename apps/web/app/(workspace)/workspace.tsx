"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { EndpointMonitor, HostList, ServicesPayload } from "@opspilot/contracts";
import { WorkspaceShell } from "../../components/workspace-shell";
import { api, ApiError } from "../../lib/api";
import type { Resource } from "../../lib/host-pressure";
import type { WorkspacePath } from "../../lib/workspace-path";

export type Incident = { id: string; title: string; category: string; status: string; hostname: string; agent_id: string; created_at: string; resolved_at: string | null; resolution: string | null };
export type WorkspaceSelection = { href: "/hosts"; id: string; resource?: Resource } | { href: "/incidents"; id: string };

type WorkspaceReads = {
  fleet: HostList | null;
  fleetError: string;
  incidents: Incident[];
  incidentsError: string;
  refreshedAt: string | null;
  openIncidents: number | null;
  endpoints: EndpointMonitor[] | null;
  servicesError: string;
  hostRefresh: number;
  refresh: () => Promise<void>;
  refreshFleet: () => void;
  refreshIncidents: () => Promise<void>;
  updateEndpoint: (endpoint: EndpointMonitor) => void;
};

function useWorkspaceData(): WorkspaceReads {
  const [fleet, setFleet] = useState<HostList | null>(null);
  const [fleetError, setFleetError] = useState("");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsError, setIncidentsError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointMonitor[] | null>(null);
  const [servicesError, setServicesError] = useState("");
  const [hostRefresh, setHostRefresh] = useState(0);
  const reads = useRef<AbortController | null>(null);

  const refreshIncidents = useCallback(async () => {
    const signal = reads.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const records: Incident[] = await api("/incidents", "GET", undefined, signal);
      if (signal.aborted) return;
      setIncidents(records);
      setRefreshedAt(new Date().toISOString());
      setIncidentsError("");
    } catch (cause) {
      if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) {
        setIncidentsError(cause instanceof Error ? cause.message : "Incident records could not be loaded.");
      }
    }
  }, []);

  const refreshServices = useCallback(async () => {
    const signal = reads.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const data: ServicesPayload = await api("/services", "GET", undefined, signal);
      if (signal.aborted) return;
      setEndpoints(data.endpoints);
      setServicesError("");
    } catch (cause) {
      if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) {
        setServicesError(cause instanceof Error ? cause.message : "Endpoint records could not be loaded.");
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reads.current = controller;
    function poll() { void refreshIncidents(); void refreshServices(); }
    poll();
    const timer = setInterval(poll, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refreshIncidents, refreshServices]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const next: HostList = await api("/hosts", "GET", undefined, signal);
        if (signal.aborted) return;
        setFleet(next);
        setFleetError("");
      } catch (cause) {
        if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) setFleetError(cause instanceof Error ? cause.message : String(cause));
      } finally { pending = false; }
    }
    void load();
    const poll = setInterval(() => void load(), 10000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [hostRefresh]);

  const refreshFleet = useCallback(() => setHostRefresh(value => value + 1), []);
  async function refresh() {
    refreshFleet();
    await Promise.all([refreshIncidents(), refreshServices()]);
  }

  function updateEndpoint(endpoint: EndpointMonitor) {
    setEndpoints(current => current?.map(item => item.id === endpoint.id ? endpoint : item) ?? null);
  }

  const openIncidents = refreshedAt ? incidents.filter(i => i.status === "open").length : null;
  return { fleet, fleetError, incidents, incidentsError, refreshedAt, openIncidents, endpoints, servicesError, hostRefresh, refresh, refreshFleet, refreshIncidents, updateEndpoint };
}

type WorkspaceData = WorkspaceReads & {
  selection: WorkspaceSelection | null;
  consumeSelection: (selection: WorkspaceSelection) => void;
  inspectHost: (id: string, resource?: Resource) => void;
  openIncident: (id: string) => void;
  signOutError: string;
  dismissSignOutError: () => void;
};
const WorkspaceContext = createContext<WorkspaceData | null>(null);
const noHosts: HostList["hosts"] = [];

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Workspace layout is required");
  return workspace;
}

export function Workspace({ children, onSignOut }: { children: ReactNode; onSignOut?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const data = useWorkspaceData();
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null);
  const [signOutError, setSignOutError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setSelection(current => current?.href === pathname ? current : null);
    const frame = window.requestAnimationFrame(() => {
      const content = main.current;
      const active = document.activeElement;
      // Inspector handoffs and Connect server focus their own section headings.
      if (content?.contains(active) && active?.matches('h2[tabindex="-1"]')) return;
      content?.querySelector<HTMLElement>("h1[tabindex]")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  function navigate(href: WorkspacePath) {
    if (pathname !== href) router.push(href);
  }

  function inspectHost(id: string, resource?: Resource) {
    setSelection({ href: "/hosts", id, resource });
    navigate("/hosts");
  }

  function openIncident(id: string) {
    setSelection({ href: "/incidents", id });
    navigate("/incidents");
  }

  const consumeSelection = useCallback((handled: WorkspaceSelection) => {
    setSelection(current => current === handled ? null : current);
  }, []);

  async function signOut() {
    window.dispatchEvent(new Event("opspilot-clear-provider-draft"));
    setSigningOut(true);
    try {
      await api("/auth/logout", "POST");
      onSignOut?.();
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSigningOut(false); }
  }

  return (
    <WorkspaceContext.Provider value={{ ...data, selection, consumeSelection, inspectHost, openIncident, signOutError, dismissSignOutError: () => setSignOutError("") }}>
      <WorkspaceShell pathname={pathname} onNavigate={navigate} onInspectHost={inspectHost} onOpenIncident={openIncident} hosts={data.fleet?.hosts ?? noHosts} incidents={data.incidents} openIncidents={data.openIncidents} incidentsStale={!!data.incidentsError} busy={signingOut} onSignOut={onSignOut ? signOut : undefined}>
        <main className="content" id="main-content" tabIndex={-1} ref={main}>
          {children}
          <footer>OpsPilot starter · No automatic remediation · Read-only diagnostics only</footer>
        </main>
      </WorkspaceShell>
    </WorkspaceContext.Provider>
  );
}
