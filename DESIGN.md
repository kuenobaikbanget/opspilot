---
name: OpsPilot
description: Threshold-first operational UI with monochrome surfaces and labeled risk.
colors:
  canvas: "#0b0b0b"
  surface: "#171717"
  surface-raised: "#222222"
  input: "#111111"
  border: "#373737"
  border-strong: "#737373"
  text: "#f3f3f3"
  text-muted: "#a6a6a6"
  accent: "#e5e5e5"
  accent-hover: "#ffffff"
  on-accent: "#121212"
  success: "#e5e5e5"
  warning: "#f0c461"
  danger: "#ff858c"
  info: "#d2d2d2"
  success-subtle: "#222222"
  warning-subtle: "#302817"
  danger-subtle: "#2d1b20"
  info-subtle: "#222222"
typography:
  headline: { fontFamily: "Geist Sans", fontSize: "34px", fontWeight: 500, lineHeight: 1.25, letterSpacing: "-0.025em" }
  title: { fontSize: "23px", fontWeight: 500, lineHeight: 1.25 }
  section: { fontSize: "18px", fontWeight: 500, lineHeight: 1.25 }
  body: { fontFamily: "Geist Sans", fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }
  label: { fontSize: "12px", fontWeight: 500 }
  small: { fontSize: "13px" }
  caption: { fontSize: "11px" }
  wordmark: { fontSize: "22px", fontWeight: 600 }
  step-heading: { fontSize: "15px", fontWeight: 500 }
  measurement: { fontFamily: "Geist Mono", fontSize: "28px", fontWeight: 400 }
  mono: { fontFamily: "Geist Mono" }
rounded:
  sm: "3px"
  md: "4px"
  lg: "4px"
  dock-item: "9px"
  dock: "14px"
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
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
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
    rounded: "{rounded.dock}"
    padding: "0.75rem"
  notice-info:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1rem"
---

# Design System: OpsPilot

## Direction

**Evidence before inference.** The supplied Pencil design defines the Monochrome workspace: graphite canvas and surfaces, Geist typography, a bottom command dock, and signal cards that put readings against configured limits. The illustrative values, workspace names, endpoint statuses and cadences are not production data.

`apps/web/app/tokens.css` is the runtime token source; shared native controls live in `apps/web/components/ui.tsx`. `/design-system` is the public synthetic catalog, and `.impeccable/design.json` adds metadata and previews. See [UI/UX](docs/UI-UX.md#fleet-services-dashboard-contract-target) for data boundaries and [API](docs/API.md#host-monitoring-read-model) for the host read model.

## Colors

The light action token is for primary controls, the active dock item and focus, not health. Amber means near limit; rose means reached or exceeded limit, an open incident or a failure. Within-limit, information and success states can be neutral. Use a written label for every state, including cached, stale and unavailable. Missing values are not zeros.

**The Evidence Rule.** Keep measured observations, AI hypotheses and human-confirmed resolutions explicitly labeled. Color alone is not provenance.

**The Independent Signals Rule.** An online agent or running process does not establish endpoint reachability; a failed endpoint does not establish host failure or root cause.

## Typography

Use self-hosted Geist Sans for operational text and Geist Mono for readings, identifiers, timestamps, shortcuts and commands. Main headings use 34px, summary and inspector headings 23px, section headings 18px. Body, labels and captions use 14px, 12px and 11px. The watchlist and its inspector use 28px tabular numbers for the measured resource reading, with the configured limit next to it in smaller type.

## Layout

- **Shell:** a 76px workspace header, 40px desktop content inset, and a centered fixed dock with Overview, Services, Hosts, Incidents, quick search and New monitor. Current destination uses `aria-current="page"`. Header search, desktop dock search and Ctrl/Cmd+K open the same keyboard-operable command dialog for destinations and loaded hosts and incidents. Provider settings and the admin menu retain existing settings, drift, memory and sign-out.
- **Overview:** one summary separates fleet-wide agent connectivity from threshold counts for assessed devices. On wide screens, the at-risk watchlist and independent endpoint reachability share the left column. The right inspector switches between device pressure and endpoint probe details. The entire card pins at the top until it reaches the end of the workspace. It grows to fit its content without a separate scrollbar; keep scrolling the page to reach the bottom of a tall card. Narrow screens stack those three sections without pinning. The full-width device inventory follows. Rank by smallest headroom across comparable resources; compare only fresh, online, non-cached readings. The offline shortcut filters loaded devices, not the entire fleet.
- **Hosts:** status and query filters, full-width semantic inventory table, time-stamped CPU/memory/disk history after it, and an installation entry point. A labeled horizontal scroll region keeps columns available at narrow widths. History shows sampled points, not filled gaps.
- **Incidents:** open and resolved records on the left, investigation details on the right. Host measurements are labeled separately from incident-time evidence and actions. AI use remains explicit; viewing an incident does not invoke a model.
- **Onboarding:** centered 1160px column, ordered progress and one active step. Connect server uses the real pinned release configuration, in-memory install command and host checks. Add service explains why config and verification cannot start. The workspace header remains; the fixed dock is omitted on setup views.
- **Responsive:** split workspaces stack when space runs out. Retain the four labeled dock destinations on mobile, with search in the header and bottom clearance for scrollable content. Shared touch controls use 44px minimum targets; account uses a 44px mobile target and dock destinations remain labeled.

## Components and states

- **Controls:** 3px radius, 38px standard/36px compact buttons for fine pointers, 42px desktop field height, 2px visible focus. Use busy/disabled states and associated labels and error text. Panels use 4px corners and one-pixel borders.
- **Elevation:** neutral surface steps and borders define grouping. Only the floating dock uses a soft offset shadow; the command dialog has a dark backdrop. Use short existing transitions and respect reduced motion. Host history retains its scoped View Transition on capable desktop browsers.
- **Pressure display:** pair the measured resource usage with its labeled configured limit. The Redline ruler uses a fixed 0–100% usage scale: graphite fill to the sample, a white limit marker, and rose hatching only on the part past the limit. The written risk status and both numbers remain available without the ruler. Historical samples do not get live risk color. The advisory card only draws from incidents matching the selected host and resource, and names the source incident and its opening time.
- **Partial failures:** a failed session check offers retry; 401 returns to login. Unavailable reads do not block other independently scoped reads. Cached data carries the original observation timestamp; a failed refresh is not an empty inventory or recovered incident.
- **Providers:** the existing table/editor keeps stored credentials server-side, tests explicit, and configuration changes revision-checked. Evidence, recommendations and resolution remain separately labeled.
- **Services:** show the selected host's configured systemd unit, measured state and original observation time. Separate unavailable collection and stale observations from process state. Do not infer fleet counts, endpoint health or a cause from the unit state.
