"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Badge, Button, Field, Input, MetricMeter, Notice, Panel, Select, Textarea } from "@/components/ui";
import styles from "./design-system.module.css";

const palette = [
  ["Canvas", "--color-canvas"],
  ["Surface", "--color-surface"],
  ["Raised surface", "--color-surface-raised"],
  ["Border", "--color-border"],
  ["Text", "--color-text"],
  ["Muted text", "--color-text-muted"],
  ["Accent / action", "--color-accent"],
  ["On accent", "--color-on-accent"],
  ["Success", "--color-success"],
  ["Warning", "--color-warning"],
  ["Danger", "--color-danger"],
  ["Information", "--color-info"],
] as const;

const sections = [
  ["foundations", "Foundations"],
  ["components", "Components"],
  ["states", "States"],
  ["evidence-first", "Evidence-first pattern"],
] as const;

export default function DesignCatalog() {
  const [loading, setLoading] = useState(false);
  const [buttonFeedback, setButtonFeedback] = useState("Choose a button to preview its feedback.");
  const [cpu, setCpu] = useState(68);
  const [server, setServer] = useState("");
  const [service, setService] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ server?: string; service?: string }>({});
  const [formFeedback, setFormFeedback] = useState("");
  const [resetFeedback, setResetFeedback] = useState("");
  const serverRef = useRef<HTMLInputElement>(null);
  const serviceRef = useRef<HTMLSelectElement>(null);

  function validatePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(server.trim())) {
      nextErrors.server = "Enter 1–63 letters, numbers, or hyphens. Start and end with a letter or number.";
    }
    if (!service) nextErrors.service = "Choose a service for this example.";
    setErrors(nextErrors);
    setFormFeedback("");
    if (nextErrors.server) serverRef.current?.focus();
    else if (nextErrors.service) serviceRef.current?.focus();
    else setFormFeedback(`Preview valid for ${server.trim()} / ${service}. No settings were saved and no host was contacted.`);
  }

  function resetPreview() {
    setLoading(false);
    setCpu(68);
    setServer("");
    setService("");
    setNotes("");
    setErrors({});
    setFormFeedback("");
    setButtonFeedback("Choose a button to preview its feedback.");
    setResetFeedback("Preview reset. No host was enrolled and no settings were saved.");
  }

  return (
    <div className={styles.catalog}>
      <a className={styles.skipLink} href="#catalog-content">Skip to catalog</a>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <Link href="/" className={styles.brand}><BrandMark size={22} /><span>OpsPilot</span></Link>
          <Link href="/" className={styles.dashboardLink}>Back to live dashboard</Link>
        </div>
        <div className={styles.titleRow}>
          <h1>Design system</h1>
          <Badge>v0.1 / UI foundation</Badge>
        </div>
        <p className={styles.intro}>A practical reference for clear operations: reusable controls, readable signals, and evidence that keeps its provenance.</p>
        <Notice tone="info">Synthetic examples. No live telemetry or saved settings.</Notice>
      </header>

      <div className={styles.layout}>
        <aside className={styles.index}>
          <nav aria-label="Design system sections">
            <p className={styles.indexTitle}>On this page</p>
            <ul>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
          </nav>
          <p className={styles.indexNote}>Built for the operator.<br />Evidence before inference.</p>
        </aside>

        <main id="catalog-content" className={styles.content}>
          <section id="foundations" className={styles.section} aria-labelledby="foundations-title">
            <div className={styles.sectionHeading}>
              <h2 id="foundations-title">Foundations</h2>
              <p>Flat navy surfaces. Mint for intent. Semantic color supports a written status; it never replaces one.</p>
            </div>
            <div className={styles.palette}>
              {palette.map(([label, token]) => (
                <div key={token} className={styles.swatch}>
                  <div aria-hidden="true" className={styles.swatchColor} style={{ background: `var(${token})` }} />
                  <strong>{label}</strong>
                  <code>{token}</code>
                </div>
              ))}
            </div>
            <div className={styles.foundationDetails}>
              <div>
                <h3>Type hierarchy</h3>
                <div className={styles.typeSample}><p className={styles.typeHeading}>Host investigation</p><code>--text-xl · section heading</code></div>
                <div className={styles.typeSample}><p className={styles.typeBody}>Measured signals lead the story.</p><code>--text-base · body / controls</code></div>
                <div className={styles.typeSample}><p className={styles.typeMeta}>Last sample: 14:32:10 UTC</p><code>--text-sm · supporting detail</code></div>
                <p className={styles.guidance}>System sans for the interface. Monospace for code and measurements, not for every technical label.</p>
              </div>
              <div>
                <h3>Spacing rhythm</h3>
                <div className={styles.spacingScale}>
                  {[1, 2, 3, 4, 6, 8, 12].map((step) => (
                    <div key={step} className={styles.spacingRow}>
                      <code>--space-{step}</code>
                      <span aria-hidden="true" style={{ width: `var(--space-${step})` }} />
                    </div>
                  ))}
                </div>
                <p className={styles.guidance}>Keep related controls close. Use larger steps between tasks. Choose semantic tokens instead of local color values.</p>
              </div>
            </div>
            <details className={styles.disclosure}>
              <summary>Token usage</summary>
              <pre className={styles.codeBlock}><code>{`.surface {\n  background: var(--color-surface);\n  color: var(--color-text);\n  border: 1px solid var(--color-border);\n  padding: var(--space-6);\n  border-radius: var(--radius-md);\n}`}</code></pre>
            </details>
          </section>

          <section id="components" className={styles.section} aria-labelledby="components-title">
            <div className={styles.sectionHeading}>
              <h2 id="components-title">Components</h2>
              <p>Native semantics, shared tokens, visible keyboard focus. These controls only change this preview.</p>
            </div>
            <div className={styles.componentGroup}>
              <h3>Buttons</h3>
              <div className={styles.buttonRow}>
                <Button variant="primary" onClick={() => setButtonFeedback("Primary button selected. This preview performed no operation.")}>Primary</Button>
                <Button variant="secondary" onClick={() => setButtonFeedback("Secondary button selected. This preview performed no operation.")}>Secondary</Button>
                <Button variant="ghost" onClick={() => setButtonFeedback("Ghost button selected. This preview performed no operation.")}>Ghost</Button>
                <Button variant="danger" onClick={() => setButtonFeedback("Danger button selected. Nothing was deleted.")}>Danger</Button>
                <Button disabled>Disabled</Button>
              </div>
              <p className={styles.feedback} role="status">{buttonFeedback}</p>
              <pre className={styles.codeBlock}><code>{`<Button variant="primary" onClick={handleAction}>\n  Investigate\n</Button>`}</code></pre>
            </div>

            <div className={styles.statusGrid}>
              <div>
                <h3>Status badges</h3>
                <div className={styles.badgeRow}>
                  <Badge tone="neutral" dot>Offline</Badge>
                  <Badge tone="success" dot>Online</Badge>
                  <Badge tone="warning" dot>Needs review</Badge>
                  <Badge tone="danger" dot>Critical</Badge>
                  <Badge tone="info" dot>Advisory</Badge>
                </div>
                <p className={styles.guidance}>Name the status explicitly. A green badge alone is not confirmation of a resolution.</p>
              </div>
              <div>
                <div className={styles.metricHeader}><h3>Synthetic CPU</h3><output htmlFor="demo-cpu" className={styles.measurement}>{cpu}%</output></div>
                <MetricMeter label="Synthetic CPU utilization" value={cpu} />
                <label className={styles.rangeLabel} htmlFor="demo-cpu">Adjust preview utilization</label>
                <input className={styles.range} id="demo-cpu" type="range" min="0" max="100" value={cpu} onChange={(event) => setCpu(Number(event.target.value))} />
                <div className={styles.metricHeader}><span className={styles.guidance}>Unknown measurement</span><span className={styles.guidance}>Not available</span></div>
                <MetricMeter label="Synthetic memory utilization, unavailable" value={null} />
              </div>
            </div>

            <section id="states" className={styles.statesSection} aria-labelledby="states-title">
              <div className={styles.sectionHeading}>
                <h3 id="states-title" className={styles.subsectionTitle}>States</h3>
                <p>Try validation, control a loading preview, and reset the local examples. Nothing leaves this page.</p>
              </div>
              <div className={styles.statesGrid}>
                <Panel className={styles.formPanel}>
                  <h4>Form controls and validation</h4>
                  <p className={styles.guidance}>Submit empty to see linked errors, then complete the required fields. This is not an enrollment form.</p>
                  <form className={styles.form} noValidate onSubmit={validatePreview}>
                    <Field id="demo-server" label="Server name" required hint="1–63 letters, numbers, or hyphens; for example, staging-api-02." error={errors.server}>
                      <Input ref={serverRef} id="demo-server" name="server" value={server} autoComplete="off" required aria-invalid={Boolean(errors.server)} aria-describedby={`demo-server-hint${errors.server ? " demo-server-error" : ""}`} onChange={(event) => { setServer(event.target.value); setErrors((previous) => ({ ...previous, server: undefined })); setFormFeedback(""); }} />
                    </Field>
                    <Field id="demo-service" label="Service" required error={errors.service}>
                      <Select ref={serviceRef} id="demo-service" name="service" value={service} required aria-invalid={Boolean(errors.service)} aria-describedby={errors.service ? "demo-service-error" : undefined} onChange={(event) => { setService(event.target.value); setErrors((previous) => ({ ...previous, service: undefined })); setFormFeedback(""); }}>
                        <option value="">Choose a service</option>
                        <option value="nginx">nginx</option>
                        <option value="postgresql">PostgreSQL</option>
                        <option value="worker">Background worker</option>
                      </Select>
                    </Field>
                    <Field id="demo-notes" label="Operator note (optional)" hint="Synthetic notes only. Do not enter credentials or production data.">
                      <Textarea id="demo-notes" name="notes" rows={3} value={notes} aria-describedby="demo-notes-hint" onChange={(event) => { setNotes(event.target.value); setFormFeedback(""); }} />
                    </Field>
                    {(errors.server || errors.service) && (
                      <Notice tone="danger" role="alert">
                        <strong>Check the required fields.</strong>
                        <ul className={styles.errorLinks}>
                          {errors.server && <li><a href="#demo-server" onClick={() => serverRef.current?.focus()}>Review server name</a></li>}
                          {errors.service && <li><a href="#demo-service" onClick={() => serviceRef.current?.focus()}>Choose a service</a></li>}
                        </ul>
                      </Notice>
                    )}
                    <Button variant="primary" type="submit">Validate preview</Button>
                    <div role="status">{formFeedback && <Notice tone="success">{formFeedback}</Notice>}</div>
                  </form>
                </Panel>

                <div className={styles.stateExamples}>
                  <div className={styles.loadingExample} aria-busy={loading}>
                    <h4>Loading</h4>
                    <p className={styles.guidance}>A controlled UI state, not a network request. Finish it with the separate control.</p>
                    <div className={styles.buttonRow}>
                      <Button loading={loading} onClick={() => setLoading(true)}>{loading ? "Loading preview…" : "Preview loading"}</Button>
                      <Button variant="ghost" disabled={!loading} onClick={() => setLoading(false)}>Finish preview</Button>
                    </div>
                  </div>
                  <p className={styles.feedback} role="status">{loading ? "Loading preview active. No request is running." : "Loading preview idle."}</p>
                  <div className={styles.emptyExample}>
                    <h4>No hosts in this example</h4>
                    <p className={styles.guidance}>An empty state should explain what is missing and offer an honest next step. Resetting this preview will not enroll a host.</p>
                    <Button size="sm" onClick={resetPreview}>Reset preview</Button>
                    <p className={styles.feedback} role="status">{resetFeedback}</p>
                  </div>
                </div>
              </div>
              <details className={styles.disclosure}>
                <summary>Field and loading usage</summary>
                <pre className={styles.codeBlock}><code>{`<Field id="server" label="Server name" error={error}>\n  <Input id="server" aria-invalid={Boolean(error)}\n    aria-describedby={error ? "server-error" : undefined} />\n</Field>\n\n<Button loading={pending} onClick={handleAction}>\n  Investigate\n</Button>`}</code></pre>
                <p className={styles.guidance}>Connect hints and errors explicitly with aria-describedby. Loading buttons disable themselves; keep cancellation or completion outside the disabled control.</p>
              </details>
            </section>
          </section>

          <section id="evidence-first" className={styles.section} aria-labelledby="evidence-title">
            <div className={styles.sectionHeading}>
              <h2 id="evidence-title">Evidence-first pattern</h2>
              <p>A signal is an observation. A hypothesis is an interpretation. A resolution requires a person to confirm what worked.</p>
            </div>
            <Panel className={styles.incidentPanel}>
              <div className={styles.incidentHeader}>
                <div><h3>Synthetic incident: elevated API latency</h3><p className={styles.guidance}>staging-api-02 · nginx · 16 Nov 2026, UTC</p></div>
                <Badge tone="neutral">Synthetic record</Badge>
              </div>
              <ol className={styles.evidenceFlow}>
                <li>
                  <div className={styles.provenanceHeading}><h4>Measured signal</h4><Badge tone="warning">Recorded sample</Badge></div>
                  <p>At 14:32:10 UTC, CPU utilization was <span className={styles.measurement}>92%</span> and API p95 latency was <span className={styles.measurement}>840 ms</span>.</p>
                  <p className={styles.guidance}>Source: synthetic agent telemetry · Evidence E-101 and E-102. A point-in-time sample, not live monitoring.</p>
                  <details className={styles.disclosure}>
                    <summary>Inspect synthetic evidence</summary>
                    <dl className={styles.evidenceRecords}>
                      <div><dt>E-101 · host metrics</dt><dd><code>14:32:10Z · cpu_percent=92</code></dd></div>
                      <div><dt>E-102 · nginx access summary</dt><dd><code>14:32:10Z · api_p95_ms=840</code></dd></div>
                      <div><dt>E-103 · follow-up sample</dt><dd><code>14:42:10Z · cpu_percent=41 · api_p95_ms=180</code></dd></div>
                    </dl>
                  </details>
                </li>
                <li>
                  <div className={styles.provenanceHeading}><h4>AI hypothesis</h4><Badge tone="info">Unverified interpretation</Badge></div>
                  <p>A concurrent background job may have competed with API workers for CPU. High CPU and latency coincide; these samples alone do not establish the cause.</p>
                  <p className={styles.guidance}>Source: synthetic AI-authored example · Cites E-101 and E-102. Advisory only, not a confirmed finding or remediation instruction.</p>
                </li>
                <li>
                  <div className={styles.provenanceHeading}><h4>Human-confirmed resolution</h4><Badge tone="success">Operator confirmation</Badge></div>
                  <p>At 14:45 UTC, the example operator recorded that rescheduling the batch job restored normal response times, then checked the follow-up sample: CPU <span className={styles.measurement}>41%</span>, p95 <span className={styles.measurement}>180 ms</span>.</p>
                  <p className={styles.guidance}>Source: synthetic operator note · Follow-up E-103. This confirmation belongs to the example record; OpsPilot has taken no action.</p>
                </li>
              </ol>
            </Panel>
          </section>
          <footer className={styles.footer}>OpsPilot UI foundation · No automatic remediation. Keep evidence visible and human decisions explicit.</footer>
        </main>
      </div>
    </div>
  );
}
