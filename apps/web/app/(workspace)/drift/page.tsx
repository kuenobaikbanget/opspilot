"use client";

import { useState } from "react";
import { DriftTimeline } from "../../../components/drift-timeline";
import { Button } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { useWorkspace } from "../workspace";
import { WorkspaceHeader } from "../workspace-header";
import { IncidentWorkspace } from "../incidents/incident-workspace";

export default function DriftPage() {
  const { fleet, incidents, openIncident, refresh } = useWorkspace();
  const [view, setView] = useState<"timeline" | "incidents">("timeline");
  const driftOpen = incidents.filter((i) => i.category === "config_drift" && i.status === "open").length;

  if (view === "incidents") {
    return <>
      <div className="drift-view-switch">
        <Button size="sm" variant="ghost" onClick={() => setView("timeline")}><WorkspaceIcon name="back" />Drift timeline &amp; diffs</Button>
      </div>
      <IncidentWorkspace drift />
    </>;
  }

  return <>
    <WorkspaceHeader
      title="Configuration drift"
      description="Observable drift timeline with redacted semantic diffs for allowlisted config files. Correlation is not causation."
      summary={{ open: driftOpen }}
      onRefresh={() => void refresh()}
    />
    <DriftTimeline
      hosts={fleet?.hosts ?? []}
      onOpenIncident={openIncident}
      onViewIncidents={() => setView("incidents")}
      onRefresh={() => void refresh()}
    />
  </>;
}
