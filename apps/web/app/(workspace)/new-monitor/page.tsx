"use client";

import { ButtonLink } from "../../../components/ui";
import { WorkspaceIcon } from "../../../components/workspace-shell";
import { WorkspaceNotices } from "../workspace-header";

export default function NewMonitorPage() {
  return <>
    <WorkspaceNotices />
    <section className="onboarding" aria-labelledby="add-service-title">
      <ButtonLink href="/services" className="onboarding-back"><WorkspaceIcon name="back" />Back to Services</ButtonLink>
      <header className="onboarding-header"><h1 id="add-service-title" tabIndex={-1}>Add service</h1><p>Endpoint setup requires monitoring support on this instance.</p></header>
      <ol className="onboarding-progress" aria-label="Service setup progress">
        {["Choose a server", "Configure service", "Verify service"].map((step, i) => <li className="onboarding-progress-item" data-state={i === 0 ? "active" : "upcoming"} aria-current={i === 0 ? "step" : undefined} key={step}>
          <span className="onboarding-progress-marker" aria-hidden="true">{i + 1}</span><div><span>{step}</span><span className="onboarding-step-status">{i === 0 ? "Unavailable" : "Not started"}</span></div>
        </li>)}
      </ol>
      <ol className="onboarding-steps">
        <li className="onboarding-step" data-state="active">
          <div className="onboarding-step-header"><h2>1. Choose a server</h2></div>
          <div className="onboarding-step-body"><p>Endpoint monitor configuration is not available on this instance. Connecting an agent enables host telemetry, not service probes.</p><div className="onboarding-actions"><ButtonLink href="/hosts">View hosts</ButtonLink><ButtonLink href="/connect"><WorkspaceIcon name="terminal" />Connect server</ButtonLink></div></div>
        </li>
        <li className="onboarding-step" data-state="upcoming"><div className="onboarding-step-header"><h2>2. Configure service</h2></div></li>
        <li className="onboarding-step" data-state="upcoming"><div className="onboarding-step-header"><h2>3. Verify service</h2></div></li>
      </ol>
    </section>
  </>;
}
