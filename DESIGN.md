---
name: OpsPilot
description: Evidence-first operational UI with shared native controls and semantic states.
colors:
  canvas: "#090f18"
  surface: "#101824"
  surface-raised: "#111e2d"
  input: "#091421"
  border: "#233449"
  border-strong: "#526b82"
  text: "#e8edf5"
  text-muted: "#a3b4c7"
  accent: "#52d9b7"
  accent-hover: "#79efd3"
  on-accent: "#092521"
  success: "#75dec1"
  warning: "#e9ba78"
  danger: "#ffb4a7"
  info: "#a5c9f5"
  success-subtle: "#142e2a"
  warning-subtle: "#302719"
  danger-subtle: "#371c22"
  info-subtle: "#182a40"
typography:
  headline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif'
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  small:
    fontSize: "0.8125rem"
  caption:
    fontSize: "0.75rem"
  mono:
    fontFamily: 'ui-monospace, "Cascadia Code", "Segoe UI Mono", Consolas, monospace'
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "7": "1.75rem"
  "8": "2rem"
  "10": "2.5rem"
  "12": "3rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.75rem"
    width: "100%"
  badge-warning:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "1.5rem"
  navigation:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0.75rem"
  notice-info:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1rem"
---

# Design System: OpsPilot

## Overview

**Creative North Star: "Evidence before inference"**

OpsPilot is a compact operational interface for monitoring hosts and investigating incidents. Preserve its dark navy surfaces, mint actions, explicit status labels and restrained native controls. Measured observations, AI hypotheses and human-confirmed resolutions must remain visibly distinct. Host connectivity, workload process state and endpoint reachability are separate measured signals, never a single inferred health state.

This contract covers the implemented design system and the approved **Fleet & services** dashboard direction. `apps/web/app/tokens.css` is the executable token source; the frontmatter is its portable visual reference. Shared primitives live in `apps/web/components/ui.tsx`, their styles in `apps/web/app/globals.css`, and the public interactive reference at `/design-system`. The sidecar `.impeccable/design.json` extends this reference with states and preview snippets; it is not another runtime theme. `docs/BACKEND-DESIGN.md` remains the backend architecture document.

The [supplied dashboard reference](docs/assets/fleet-services-reference.png) establishes the target composition, not shipped functionality. [UI/UX](docs/UI-UX.md#fleet-services-dashboard-contract-target) owns its detailed behavior and acceptance criteria. Existing tokens and component APIs below remain implemented facts; sections marked **target** are implementation requirements, not claims that service inventory or endpoint monitoring already exists.

The host-only slice implements the Fleet & services composition: searchable/selectable host table with last agent contact, full-fleet host totals, contextual inspector, timestamped resource bars and one-time enrollment flow. CPU, memory and disk values switch the history; disk is selected initially. A recorded configuration change appears below the table, while unavailable service inventory is disclosed on demand. Related open incidents link to and focus the existing incident detail without starting AI. Hosts, Incidents, Configuration drift, Incident memory and read-only Provider settings are working in-page destinations; Hosts consolidates the former duplicate Overview view. Drift and related incidents come from the latest 100 records, not a complete inventory. Offline samples are historical; fetch failures retain explicit stale observations. Workload/endpoint collection and the complete target remain unimplemented.

**Key Characteristics:**
- Dark navy tonal surfaces with mint actions.
- Native controls, visible keyboard focus and explicit status text.
- Separate measured evidence, AI hypotheses and human-confirmed resolution.
- Compact responsive layouts without decorative elevation.
- Table-led host scanning with a contextual inspector; workload/endpoint inspection remains planned.

## Colors

### Primary
Mint `accent` identifies primary actions, links, selection and focus. `accent-hover` changes actionable surfaces on hover; `on-accent` supplies their dark foreground. Do not substitute white text on mint.

### Semantic states
`success`, `warning`, `danger` and `info` pair with their corresponding `*-subtle` backgrounds in badges and notices. Success is mint-adjacent, warning amber, danger coral and information blue. State labels carry meaning independently of color; an AI report is not a confirmed resolution merely because it has a positive tone.

### Neutral
`canvas` surrounds `surface` panels and `surface-raised` controls. `input` makes editable regions distinct. `border` divides structures; `border-strong` defines interactive boundaries. `text` and `text-muted` establish reading hierarchy. Values are recorded once in the frontmatter and implemented through matching `--color-*` properties.

**The Evidence Rule.** Keep observations, AI hypotheses and human-confirmed resolution explicitly labeled; color alone is not provenance.

**The Independent Signals Rule.** An online agent or running process does not establish endpoint reachability; a failed endpoint does not establish host failure or root cause.

## Typography

Use the system sans stack for operational text, with the monospace stack for code, identifiers and measurements. The root is 16px; body text uses the base role. Body line-height is 1.5; paragraphs use 1.6. Headings use 1.25.

The page heading uses `headline`. Catalog section headings use `title`; dashboard section headings instead use `--text-lg` (1.125rem, tracking -0.01em). Catalog component headings use `--text-md` (1rem); dashboard h3 uses base. Small controls and hints use `small`; badges, metadata and catalog code use `caption`. These are observed roles, not an imposed display scale. Measurement numerals use tabular figures. Catalog explanatory text is limited to 72ch.

## Layout

### Implemented layouts

The host dashboard uses a sticky Precision Rail above **700px**: 232px expanded or 72px icon-only. It occupies the viewport height and scrolls independently when needed. At **1280px and above**, content has a 2rem inset, with a 1.7:1 table/inspector grid, 320px minimum inspector and 1.5rem gap. Below **1280px**, the inspector follows the host and unavailable-service sections. At **1100px and below**, content uses 1.75rem by 1.5rem padding; at **700px and below**, 1.5rem by 1rem. Mobile navigation moves above content with main destinations visible in two columns and utilities collapsed behind a labeled disclosure, independently of the desktop preference. The inline summary wraps and becomes two compact columns on mobile. Semantic tables scroll within named focusable regions rather than widening the page; unavailable inventory explanations wrap outside the table. Incident and memory panels retain shared primitives.

The catalog is capped at 1280px with 2rem horizontal padding, a sticky 180px section index and a 2.5rem gap. At **1000px and below**, the index is 150px, palette changes from four to three columns and state examples reflow. At **720px and below**, the index becomes an inline wrapping link list, palette becomes two columns, foundation/status grids stack and horizontal padding becomes 1.25rem. Catalog form/incident panels use 1rem padding there.

Use the existing quarter-rem spacing steps rather than independent local scales. Prefer wrapping labels and minmax(0, 1fr) tracks to truncating evidence.

### Fleet & services layout (target)

Use a quiet left rail, a compact page header, one inline summary strip and a table-led workspace—not a grid of metric cards. The wide layout places the host table and selected host's services on the left, with one shared host/service inspector on the right. Use tonal row selection, horizontal separators and aligned measurement columns; reserve a contained surface for the inspector. No nested card around every table or number.

The host slice implements a 232px rail (72px collapsed), 2rem content inset, 1.5rem workspace gap and roughly 1.7:1 list-to-inspector proportions, with a 320px minimum inspector. Below 1280px, its inspector follows the host and unavailable-service sections; at 700px and below, navigation moves above content. The complete target fills the selected-host service section with real inventory before that inspector. Preserve semantic tables in labeled horizontal scroll regions when columns cannot fit; never hide status, freshness or evidence to fit the viewport. Details must remain reachable without scrolling back to the top.

The summary presents hosts online, host incidents, endpoints up and endpoints failing as independently labeled counts. AI provider configuration belongs in settings/investigation, not a fleet-health statistic. Keep the existing catalog layout independent of this dashboard composition.

## Elevation & Depth

The implemented system uses no box shadows. Dark tonal surfaces, borders and spacing establish grouping; focus is an outline, not ambient elevation. Buttons and inputs transition over `--duration-fast` (150ms), meter width over `--duration-normal` (220ms), using `--ease-out` (cubic-bezier(0.16, 1, 0.3, 1)). The sidebar's 3px mint marker belongs to the active item; it does not animate between destinations or depend on their count. The reduced-motion media query removes transitions and animations and restores automatic scrolling.

## Shapes

Controls, badges, notices and meters use the small radius; panels use the large radius. The middle radius is used for nested dashboard surfaces. Borders are generally 1px. A badge's decorative status dot is circular, not a separate chip shape. Unknown measurements use a dashed boundary and text instead of an empty or zero-valued bar.

## Components

Import from `apps/web/components/ui.tsx`: the dashboard uses `../components/ui`, while the catalog uses `@/components/ui`. Global CSS imports `./tokens.css`; no utility CSS framework or icon package is required.

- **Button:** `variant="primary" | "secondary" | "ghost" | "danger"` (default secondary), `size="sm" | "md"` (default md), `loading` plus native button props. Default type is button. Normal minimum height is 42px; small is 36px with 0.25rem by 0.75rem padding. Hover changes background; active changes border to accent. Loading disables the button, sets `aria-busy`, adds visually hidden progress text and a dashed border. Disabled opacity is 0.55.
- **Input / Select / Textarea:** native props, shared full-width dark field treatment and 42px minimum height. Textarea resizes vertically. Hover strengthens the border; focus uses accent; `aria-invalid="true"` uses danger. Disabled controls use opacity 0.55 and a not-allowed cursor.
- **Field:** `id`, `label`, optional `hint`, `error`, `required`, and children. It renders a native label and `${id}-hint` / `${id}-error` text IDs. Callers must supply the matching child ID, native `required`, `aria-describedby` and `aria-invalid` as appropriate; the wrapper does not inject them.
- **Badge:** `tone="neutral" | "success" | "warning" | "danger" | "info"` and optional `dot`, plus span props. Neutral is default. Compact, wrapping, non-interactive status text; the dot is hidden from assistive technology.
- **Panel:** native div props; bordered surface with large corners and responsive padding. It is not automatically a landmark or focus target.
- **Notice:** `tone="success" | "warning" | "danger" | "info"` (default info), plus div props. Uses a current-color border and subtle background. Callers choose `role="alert"` or `role="status"` when the message requires announcement.
- **MetricMeter:** `{ value: number | null, label: string }`. Finite values clamp to 0–100 and expose a meter with percentage value text. Values above 75 are warning, above 90 danger, otherwise success. Null/non-finite data renders “No measurement,” with an accessible image label and no numeric value. It is not zero utilization.
- **Navigation (implemented):** Precision Rail keeps the OpsPilot wordmark above Hosts / Incidents / Configuration drift / Incident memory. Hosts is the default Fleet & services view, consolidating the former Overview/Hosts duplication. Configuration drift filters `config_drift` from the latest 100 incident records. A 44px toggle beside the content heading switches the desktop rail between 232px labeled and 72px icon-only modes with `aria-expanded` and `aria-controls`. The collapsed rail uses the brand mark, accessible destination names and native hover titles; current items retain `aria-current="page"`, accent text, a raised surface and a static 3px mint marker. Collapse changes layout immediately, without animating width. The browser stores only the boolean preference under `opspilot-sidebar-collapsed`; unavailable storage does not prevent toggling. Read-only Provider settings (Hub-reported availability, not key inputs) and Sign out occupy the lower utility area. Enrollment remains in the content header; the developer catalog remains available at `/design-system` and from the login screen, not in operational navigation. Deployment/account captions are omitted. At 700px and below, the desktop toggle disappears and the four main destinations retain visible labels in two columns regardless of the saved preference; a native More button exposes utilities through `aria-expanded` and `aria-controls`, with collapsed controls removed from keyboard navigation. Labels may wrap rather than truncate. This is page composition, not an exported Nav component. Catalog navigation is an anchor index and includes a skip link.

All focusable elements receive a 2px mint `:focus-visible` outline with 3px offset globally; the catalog uses 4px on links, summaries and inputs. Native disclosure and range controls retain keyboard interaction. The catalog uses synthetic data, local validation and a loading demonstration; it does not save settings or contact the API.

### Dashboard patterns (host slice implemented; service/endpoint target planned)

- **Fleet and service tables:** flat rows with column headers, text status and explicit host/service selection controls. Selection uses `surface-raised` plus an accessible selected/current indication, not color alone. Preserve keyboard access and do not turn a table row into an unlabeled click target.
- **Context inspector:** the first loaded host is selected initially; subsequent refreshes preserve valid selections and explain removals. Resource values are native pressed-state buttons switching CPU/memory/disk history, initially disk. Each bar represents one actual sample on the time axis, without aggregation or filling missing intervals. Identity/last-contact metadata remains expandable. A related open host incident has an explicit `Open investigation` action; opening it does not call a model. Real workload/runtime and endpoint check details remain planned.
- **Signal labels:** show agent `Online`/`Offline`, process `Running`/`Stopped`/`Unknown`, and endpoint `Up`/`Down`/`Unknown`/`Not configured` independently. Missing or stale samples carry timestamps and unavailable text, not healthy zeroes.
- **Chart:** actual time axis, units, observation window and aggregation; gaps remain gaps. The screenshot's 30-minute window and ≥80% for 10 minutes annotation are illustrative, not the starter's alert rule. Only display thresholds and network rates backed by real configuration and observations.
- **Action hierarchy:** quiet `Enroll host` and host search controls; mint for `Open investigation` on the selected host's related incident. Header enrollment opens and focuses the existing single-use token/instructions section; closing returns focus to the header trigger. Unavailable service/endpoint information is in a native disclosure below the recorded-drift notice; `Add endpoint` stays disabled with a reason. The planned service inspection action requires real inventory and observations. Inspection remains read-only and does not automatically trigger AI or remediation.

## Do's and Don'ts

### Do:
- **Do** use shared native primitives and live CSS custom properties.
- **Do** label measured evidence, AI hypotheses and human-confirmed resolution separately.
- **Do** preserve visible focus, descriptive field errors and reduced-motion behavior.
- **Do** show missing measurements as unavailable rather than zero.
- **Do** keep host connectivity, process state and endpoint reachability independently labeled.

### Don't:
- **Don't** use color alone to communicate status or provenance.
- **Don't** add decorative shadows, gradients or a competing token palette.
- **Don't** present catalog examples as live telemetry or persisted configuration.
- **Don't** assume Field or Notice supplies accessibility attributes that callers must set.
- **Don't** infer reachability or root cause from a running process, high CPU or overlapping timestamps.
- **Don't** pass screenshot data, example thresholds or planned controls off as live behavior.
