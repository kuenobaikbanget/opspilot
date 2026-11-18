# OpsPilot — Brand & Logo Guidelines

> Compact identity guide for OpsPilot (**Horizon Gauge** mark).

## 1. The Logo

- **Idea:** A cockpit attitude bezel bridged by a 45° horizon chevron—reading baseline stability and system drift calmly and deterministically (*"Evidence before inference"*).
- **Master SVG Assets:**
  - **Symbol (light / dark):** [`opspilot-symbol-color.svg`](opspilot-symbol-color.svg) · [`opspilot-symbol-color-dark.svg`](opspilot-symbol-color-dark.svg)
  - **Horizontal lockup (light / dark):** [`opspilot-horizontal-color.svg`](opspilot-horizontal-color.svg) · [`opspilot-horizontal-dark.svg`](opspilot-horizontal-dark.svg)
- **Web App Integration:**
  - Inline UI symbol component: [`apps/web/components/brand-mark.tsx`](../../../apps/web/components/brand-mark.tsx)
  - Web & PWA icons (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest`): [`apps/web/public/`](../../../apps/web/public/)

## 2. Clear Space & Minimum Size

- Keep a minimum clear zone of **1 × bezel wall width** (¼ of symbol width) around the logo on all sides.
- Minimum sizes: **16 px** for symbol/favicon (`favicon.ico` / `favicon.svg`), **112 px wide** for horizontal lockup.

## 3. Colour Palette

Aligned with `DESIGN.md`:

| Role | Name | HEX | Usage |
| --- | --- | --- | --- |
| Dark background / light-mode ink | Deep Navy | `#090F18` | App canvas, dark icon tile, light-mode bezel & wordmark |
| Light text / dark-mode bezel | Ice Mist | `#E8EDF5` | Dark-mode bezel & wordmark |
| Dark-UI horizon accent | OpsPilot Mint | `#52D9B7` | Horizon chevron on `#090F18` / `#101824` |
| Light-UI & print horizon accent | Deep Mint | `#0E8A6D` | Accessible horizon chevron on `#FFFFFF` |

- **Never** place `#52D9B7` mint directly on white (`~1.75:1` contrast) — use `#0E8A6D` (`~4.28:1`) on light backgrounds.

## 4. Don'ts

- Don't stretch, squash, rotate, or alter the 45° horizon angle.
- Don't recolour outside the navy/mint/monochrome palette or add shadows, glows, or gradients.
- Don't rearrange or resize the symbol relative to the `OpsPilot` wordmark, or retype the wordmark in a stock font.
