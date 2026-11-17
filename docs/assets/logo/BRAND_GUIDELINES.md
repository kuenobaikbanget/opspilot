# OpsPilot — Brand & Logo Guidelines

> Compact identity guide for OpsPilot (**Horizon Gauge** mark). Covers digital UI, documentation, and print use.

## 1. The Logo

- **Idea:** A cockpit attitude bezel bridged by a 45° horizon chevron—reading baseline stability and system drift calmly and deterministically (*"Evidence before inference"*).
- **Master Artwork:**
  - **Symbol only:** [`opspilot-symbol-color.svg`](opspilot-symbol-color.svg) (light) · [`opspilot-symbol-color-dark.svg`](opspilot-symbol-color-dark.svg) (dark)
  - **Horizontal lockup (primary):** [`opspilot-horizontal-color.svg`](opspilot-horizontal-color.svg) (light) · [`opspilot-horizontal-dark.svg`](opspilot-horizontal-dark.svg) (dark)
  - **Stacked lockup:** [`opspilot-stacked-color.svg`](opspilot-stacked-color.svg) (light) · [`opspilot-stacked-dark.svg`](opspilot-stacked-dark.svg) (dark)
  - **Wordmark only:** [`opspilot-wordmark-color.svg`](opspilot-wordmark-color.svg) (light) · [`opspilot-wordmark-dark.svg`](opspilot-wordmark-dark.svg) (dark)
  - **Small-size cut (16–24 px):** [`opspilot-symbol-small.svg`](opspilot-symbol-small.svg)
  - **Reversed white (optically thinned for irradiation):** [`opspilot-symbol-white-thinned.svg`](opspilot-symbol-white-thinned.svg)
  - **App icon tile:** [`opspilot-symbol-on-tile.svg`](opspilot-symbol-on-tile.svg)
- **Generated Variants:**
  - Symbol variants & PNGs (32 / 128 / 512 px): [`variants/symbol/`](variants/symbol/)
  - Lockup variants & PNGs (800 / 1000 / 1200 px): [`variants/lockups/`](variants/lockups/)
  - Web & PWA icon bundle (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest`): [`variants/web-icons/`](variants/web-icons/)
- **Presentation Board:** [`presentation.html`](presentation.html)

## 2. Clear Space

Maintain a minimum clear zone of **1 × bezel wall width** (equivalent to **¼ of the symbol width**, or the cap height of `O` in lockups) on all four sides. Keep the zone free of text, borders, and UI chrome; it scales proportionally with the logo.

## 3. Minimum Size

| Version | Screen | Print | Notes |
| --- | --- | --- | --- |
| Horizontal lockup | 112 px wide | 28 mm wide | Below this, switch to symbol-only |
| Stacked lockup | 88 px wide | 22 mm wide | Below this, switch to symbol-only |
| Symbol only | 16 px | 6 mm | Use `opspilot-symbol-small.svg` / `favicon.ico` below 24 px |

## 4. Colour Palette

Derived from OpsPilot's operational UI contract (`DESIGN.md`), with an accessible light-surface companion for the mint horizon so contrast stays strong on white and paper:

| Role | Name | HEX | RGB | CMYK (approx.) | Pantone (nearest) |
| --- | --- | --- | --- | --- | --- |
| Dark ground / light-mode ink | Deep Navy | `#090F18` | `9, 15, 24` | `90 / 75 / 55 / 80` | Black 6 C |
| Light text / dark-mode bezel | Ice Mist | `#E8EDF5` | `232, 237, 245` | `8 / 4 / 2 / 0` | Cool Gray 1 C |
| Dark-UI horizon accent | OpsPilot Mint | `#52D9B7` | `82, 217, 183` | `62 / 0 / 38 / 0` | 338 C |
| Light-UI & print horizon accent | Deep Mint | `#0E8A6D` | `14, 138, 109` | `84 / 15 / 62 / 5` | 3282 C |

### Approved Background Pairs
- **Dark UI (`#090F18` / `#101824`):** Use `*-dark.svg` (`#E8EDF5` bezel/wordmark + `#52D9B7` mint horizon), or one-colour `#52D9B7` / `#FFFFFF`.
- **Light UI & White Paper (`#FFFFFF`):** Use `*-color.svg` (`#090F18` navy bezel/wordmark + `#0E8A6D` deep mint horizon), or one-colour `#090F18` / `#000000`.
- **Never** place `#52D9B7` mint text/lines directly on white (`~1.75:1` contrast) — use `#0E8A6D` (`~4.28:1`) on light surfaces.
- **Photos / busy surfaces:** Use the solid `#090F18` container (`opspilot-symbol-on-tile.svg`) or one-colour white/black over a calm area.

## 5. Typography

- **Logo wordmark (`OpsPilot`):** Custom geometric sans letterforms constructed purely as SVG `<path>` outlines (`fill-rule="evenodd"`, no `<text>` dependency), with optical overshoot on rounded bowls (`O`, `p`, `s`, `o`), slightly thinned horizontals, and optical kerning.
- **UI & documentation type:** System sans stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif`) and monospace (`ui-monospace, "Cascadia Code", "Segoe UI Mono", Consolas, monospace`) per `DESIGN.md`.

## 6. Don'ts

- Don't stretch, squash, or rotate the mark or change the 45° horizon angle.
- Don't recolour outside the approved navy/mint/monochrome palette.
- Don't add drop shadows, outer glows, bevels, or gradients to the master mark.
- Don't rearrange, resize, or re-space the symbol and wordmark inside a lockup.
- Don't recreate the `OpsPilot` wordmark by typing it in a stock font for official headers or deliverables.

## 7. Handover & Verification Notes

- **Audit:** All 13 master SVGs pass `svg_audit.py` with **100/100** (zero `<text>`, zero embedded rasters, zero filters, integer/2-decimal clean coordinates).
- **Optical refinements applied:**
  - Horizontal bezel walls (`26` units) thinned ~7% relative to vertical walls (`28` units) for balanced visual weight.
  - Small-size cut (`opspilot-symbol-small.svg`) increases stroke weight (`30`/`28` bezel, `26` horizon) and outer footprint (`margin=20`) so 16×16 px rendering remains crisp.
  - Reversed white cut (`opspilot-symbol-white-thinned.svg`) thins strokes by 2 units (`26`/`24` bezel, `22` horizon) to compensate for white-on-dark irradiation bloom.
- **Legal / Print Caveats:** Automated tooling cannot guarantee trademark clearance; run a trademark database and reverse-image search before public launch. When sending files to commercial offset/spot printers or vinyl plotters, convert CMYK/Pantone swatches on physical proof stock.
