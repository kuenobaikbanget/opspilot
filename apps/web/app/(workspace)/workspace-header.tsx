"use client";

import type { ReactNode } from "react";
import { AsciiLoading } from "../../components/ascii-card-reveal";
import { Button, Notice } from "../../components/ui";
import { WorkspaceIcon } from "../../components/workspace-shell";
import { useWorkspace } from "./workspace";

type ActionError = { error: string; dismiss: () => void };

export function WorkspaceNotices({ action }: { action?: ActionError }) {
  const { signOutError, dismissSignOutError, incidentsError, refreshedAt, refreshIncidents } = useWorkspace();
  return <>
    {signOutError && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{signOutError}</span><Button variant="ghost" size="sm" onClick={dismissSignOutError}>Dismiss</Button></Notice>}
    {action?.error && <Notice tone="danger" role="alert" className="dashboard-alert"><span>{action.error}</span><Button variant="ghost" size="sm" onClick={action.dismiss}>Dismiss</Button></Notice>}
    {incidentsError && <Notice tone="warning" role="alert" className="dashboard-alert"><span>Incident refresh failed: {incidentsError}. {refreshedAt ? `Showing cached incident records from ${new Date(refreshedAt).toLocaleString()}.` : "Incident data is unavailable, not zero open incidents."}</span><Button size="sm" onClick={() => void refreshIncidents()}>Retry incidents</Button></Notice>}
  </>;
}

export function WorkspaceHeader({ title, description, actions, summary, onRefresh, actionError }: {
  title: string;
  description: string;
  actions?: ReactNode;
  summary?: "fleet" | { open: number | null };
  onRefresh?: () => void;
  actionError?: ActionError;
}) {
  const { fleet, fleetError, incidentsError, refresh } = useWorkspace();
  return <>
    <header className="topbar">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      <div className="header-actions">{actions}</div>
    </header>
    <div className="workspace-toolbar">
      <span className="workspace-context">{summary === "fleet" ? <>
        Local workspace {fleet && <span className="workspace-meta">· {fleet.total} {fleet.total === 1 ? "host" : "hosts"}{fleetError ? " · cached" : ""}</span>}
      </> : summary ? <>
        {summary.open === null ? incidentsError ? "Incident data unavailable" : <AsciiLoading as="span" className="workspace-context-loading" label="Loading incidents…" lines={1} widths={["100%"]} /> : `${summary.open} open${incidentsError ? " · cached" : ""}`}
      </> : "Local workspace"}</span>
      {summary && <div className="workspace-toolbar-actions">
        <span className="workspace-meta">{summary === "fleet" ? "Fleet" : "Incident"} refresh · 10s</span>
        <Button size="sm" onClick={onRefresh ?? (() => void refresh())}><WorkspaceIcon name="refresh" />Refresh</Button>
      </div>}
    </div>
    <WorkspaceNotices action={actionError} />
  </>;
}
