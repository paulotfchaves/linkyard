---
name: linkyard
description: Operate-mode panel inheriting the Ember Gallery world from paulochaves.dev — a light working surface framed by dark ember panels, translated for data density.
colors:
  paper: "#fefefe"
  surface: "#f2f2f2"
  hairline: "#dfdfdf"
  hairline-strong: "#c9c9c9"
  ink: "#1e1e1e"
  muted: "#585959"
  faint: "#8a8a8a"
  panel: "#0f0c0a"
  panel-soft: "#1d1d1d"
  primary: "#f0460e"
  primary-deep: "#c53608"
  primary-wash: "rgb(240 70 14 / 8%)"
  lime: "#8fe39b"
  lime-ink: "#0f2313"
  amber: "#fbd786"
  amber-ink: "#3a2c07"
  danger: "#ff6a50"
  danger-ink: "#4a1508"
  on-panel: "#fefefe"
  on-panel-muted: "rgb(255 255 255 / 78%)"
typography:
  display:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2rem, 4.4vw, 3.25rem)"
    fontWeight: 600
    lineHeight: 1.06
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  title:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  prose:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.01em"
  label:
    fontFamily: "DM Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
  script:
    fontFamily: "Ephesis, Snell Roundhand, cursive"
    fontSize: "1.12em"
    fontWeight: 400
    lineHeight: 0.6
    letterSpacing: "0"
rounded:
  glyph: "2px"
  tag: "4px"
  field: "0.5rem"
  card: "0.875rem"
  panel: "clamp(1rem, 2vw, 1.75rem)"
  pill: "999px"
  circle: "50%"
spacing:
  frame: "clamp(0.625rem, 1.2vw, 1rem)"
  gutter: "clamp(1rem, 2.5vw, 2rem)"
  card-pad: "clamp(1.125rem, 2vw, 1.5rem)"
  row-pad-y: "0.6875rem"
  row-pad-x: "0.875rem"
  stack: "1.25rem"
  page-width: "90rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "0.5625rem 1.125rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.pill}"
    padding: "0.5625rem 1.125rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger-ink}"
    border: "1px solid {colors.danger}"
    rounded: "{rounded.pill}"
  field:
    backgroundColor: "{colors.paper}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.field}"
    padding: "0.5rem 0.75rem"
  field-focus:
    border: "1px solid {colors.primary}"
    outline: "3px solid {colors.primary-wash}"
  badge-active:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.lime-ink}"
    rounded: "{rounded.pill}"
    padding: "0.1875rem 0.5rem"
  badge-scheduled:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.pill}"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.tag}"
    padding: "0.125rem 0.375rem"
  row:
    borderBottom: "1px solid {colors.hairline}"
    padding: "{spacing.row-pad-y} {spacing.row-pad-x}"
  row-selected:
    backgroundColor: "{colors.primary-wash}"
    borderLeft: "2px solid {colors.primary}"
---

# Design System: Linkyard

## Overview

**Creative North Star: "The Ember Workbench"**

Linkyard inherits the Ember Gallery world of `paulochaves.dev` — a light, near-white editorial
surface framed against dark ember panels — and translates it from a gallery into a workbench.
The gallery exists to be admired; the workbench exists to be used eight hours a day, so the
proportions invert: on the portfolio the dark ember panel *is* the page, while here the light
surface is the page and ember appears only where the product speaks rather than works.

That inversion is the whole system. **Ember panels mark moments; hairlines carry the work.** The
top bar, the primary metric card, empty states, and the entire sign-in and first-run surfaces are
ember. Everything a member touches all day — tables, forms, filters, drawers — is Paper and
Surface separated by 1px hairlines, because a dark table read for eight hours is a headache and a
glowing gradient behind a data grid is decoration pretending to be design.

The voice stays one typeface — DM Sans at tight negative tracking — but the scale drops. The
portfolio opens at 5.25rem; a workbench opens at 3.25rem and does most of its talking at
0.875rem. The Ephesis script word survives in exactly one place: the surfaces a person meets
once. Sign-in, first-run, and the first empty state may carry a single script word. A table
never does.

**Key characteristics:**
- Light working surface, ember panels as punctuation — the inverse of the portfolio's ratio
- One typeface, one action color; hairlines instead of shadows on every resting surface
- Pills for actions, 4px tags for metadata, 2px rotated squares as glyphs — unchanged from the portfolio
- Density is a feature: 0.6875rem/0.875rem row rhythm, tabular numerals on every count
- Motion is opt-in and confined to state changes; nothing drifts, pulses, or floats near a data grid

## Inheritance and departures

Three rules are carried over verbatim from `paulochaves.dev`:

**The One Voice Rule.** Ember Orange is the only color that asks for a click. Lime states, amber
warns, orange acts.

**The Hairline First Rule.** A resting surface never casts a shadow. Separation is a 1px hairline
or a background shift. Shadows appear only under things that genuinely float: the sticky header,
an open drawer or menu, a modal.

**The Tabular Metric Rule.** Every number that carries proof is 600 weight, tight-tracked, and
`font-variant-numeric: tabular-nums`, sitting above a Muted caption.

Two rules depart, and both departures are deliberate:

**Coral becomes Danger.** The portfolio forbids Coral outside its signature gradient because a
portfolio has nothing to destroy. A panel deletes domains and revokes access, and those actions
need a color that is unmistakably not the action color. Coral `#ff6a50` becomes `--danger`,
used only on destructive confirmation and error states — never as a fill on a resting surface,
and never adjacent to Ember Orange in the same control group.

**The script word retreats to the threshold.** The portfolio puts one Ephesis word in every major
headline. Here it appears only on surfaces a person meets once — sign-in, first-run, the first
empty state. Inside the working panel it would be a flourish interrupting a scan.

## Named rules of this system

**The Ember Punctuation Rule.** An ember panel means "the product is speaking": the app's top
bar, the single hero metric, an empty state, an error the user cannot fix alone, and the sign-in
and setup surfaces. It never sits behind a table, a form, or a list. If a screen has more than
one ember panel, one of them is decoration — remove it.

**The Frame Rule.** Every dark surface floats: `--frame` margin, `--radius-panel` corners. No dark
surface ever runs edge to edge. Inherited from the portfolio and non-negotiable, because it is the
single spatial gesture that makes the two products visibly the same family.

**The Row Rhythm Rule.** Table rows are `0.6875rem` vertical by `0.875rem` horizontal, separated
by a hairline, never striped. The selected row takes the `--primary-wash` fill and a 2px Ember
Orange left border — the only place a border is heavier than 1px in the working surface.

**The Quiet Table Rule.** Inside a data grid nothing animates on its own. Hover may shift a
background; a row entering or leaving may fade over 150ms. No pulses, no drifting glows, no
staggered reveals. Those belong to the threshold surfaces, where there is nothing to read yet.

**The Honest Number Rule.** A count that excludes bot traffic says so next to itself. A cost
projection shows the plan ceiling beside it. A metric that cannot be trusted yet reads
"collecting", never zero.

## Typography

**Interface font:** DM Sans, self-hosted woff2, `font-display: swap`, unicode-range subset.
Never fetched from a third-party origin — the setup panel handles credentials and its CSP
forbids any external origin, so the whole product self-hosts for consistency.

**Script accent:** Ephesis, threshold surfaces only.

**Numerals:** `font-variant-numeric: tabular-nums` on every metric, count, date, and time so
columns align and a changing number does not reflow its neighbours.

## Layout

A fixed-width shell: top bar (ember, framed) over a content column capped at `--page-width`
(90rem) with `--gutter` fluid padding. Navigation is horizontal in the top bar, not a sidebar —
the product has six destinations, and a sidebar would spend 240px of a data table's width on
six words.

Breakpoints: 64rem (table sheds secondary columns), 48rem (filters collapse into a sheet, nav
into a menu), 30rem (rows become stacked cards).

## Motion

Opt-in, mirroring the portfolio: the app renders fully static, and `html[data-motion="enhanced"]`
unlocks transitions. Everything collapses under `prefers-reduced-motion`.

- **Threshold surfaces** (sign-in, setup, empty states): staggered reveal, 0.08s steps, as on the portfolio.
- **Working surfaces:** state transitions only — 150ms background and border changes, 200ms drawer slide.
- **The arrow signature** survives: action buttons carry an arrow glyph that translates 0.1875rem
  up-right on hover over 0.25s. It is the one flourish allowed everywhere, because it is the
  family resemblance.
