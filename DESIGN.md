---
name: Pegas
description: Beautiful UI-based personal agent workspace for conversation, work and inspectable execution.
colors:
  accent: '#0071EA (oklch 0.565 0.205 254.947 — BUI hue, AA fill)'
  accent-ink: '#006AD7 (oklch 0.539 0.187 255.617)'
  accent-tint: '#E9F3FF (oklch 0.96 0.019 252.878)'
  page: '#FAFAFB (oklch 0.985 0.001 286.376)'
  canvas: '#F1F2F3 (oklch 0.961 0.002 247.84)'
  surface: '#FFFFFF'
  ink: '#1F2124 (oklch 0.247 0.006 258.361)'
  ink-2: '#62656B (oklch 0.506 0.01 264.477)'
  ink-3: '#9A9DA3 (oklch 0.695 0.009 264.505)'
  line: '#ECEDEF (oklch 0.946 0.003 264.542)'
  green: '#007E33 text / oklch 0.603 0.155 150.883 display'
  orange: '#BE4500 text / oklch 0.689 0.179 49.902 display'
  red: '#CB2E39 text / oklch 0.621 0.192 23.042 display'
themes: ['light-default', 'dark', 'system']
typography:
  family: "'Inter Variable', Inter, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
  scale: '10/11/12/13/14/16/20/26px (--text-micro…--text-display)'
  page-title: '500 26px/1.25'
  section-title: '500 20px/1.4'
  drawer-title: '500 16px/1.4'
  subsection-title: '500 14px/1.4'
  card-title: '500 13px/1.4'
  body: '400 14px/1.65'
  chat-body: '400 16px/1.78'
  card-body: '400 13px/1.55'
  label: '500 12px/1.4'
  button: '500 13px/1.4'
  weights: '400 body, 500 headings/labels/buttons; no 600/700'
  heading-wrap: 'balance'
  display-line-height: '1.2'
  title-line-height: '1.25'
  tracking: '-0.03em at 26px, -0.02em at 20px, 0 below'
radius:
  chip: '6px'
  control: '8px'
  card: '10px'
  window: '14px'
  pill: '999px'
motion:
  fast: '140ms'
  normal: '200ms'
  easing: 'out-strong cubic-bezier(0.23,1,0.32,1) · in-out-strong cubic-bezier(0.77,0,0.175,1) · link cubic-bezier(0.16,1,0.3,1)'
---

# Pegas Design System

## Creative direction

Pegas is a quiet personal agent workspace built on the Beautiful UI (BUI) component system (DESIGN-009). Conversation remains the primary surface; work tracking, approvals, settings and runtime inspection are close at hand without turning the product into an enterprise dashboard. The visual authority is BUI: cool near-white page, white cards, hairline borders, layered single-digit-opacity shadows, a neutral ink ramp, pill controls, and semantic color used sparingly as a condiment. Blue is a signal for Pegas, selection and decisive action—not a decorative background. The canvas is clean; no stripe pattern.

The component library lives in `web/src/bui/` (adapted from flornkm/beautifului, MIT — see THIRD_PARTY_NOTICES.md). BUI-owned components are used as-is; components BUI does not ship (Dialog/Popover/Tooltip/Toast/Tabs/CommandPalette/form controls) are Radix/cmdk behaviors skinned with the same BUI tokens in `web/src/bui/overlays/`. Never hand-roll a control BUI already provides. The remaining `sealed-ui.css` layout is being migrated page-by-page; each migrated batch deletes its old CSS and rewrites its style-contract tests to BUI token assertions.

Token authority: BUI tokens (`--page/--canvas/--surface/--ink*/--line*/--accent*/--green*/--orange*/--red*` and shadow/radius/easing scales) are primary. The legacy `--canvas/--surface/--ink/--muted/--positive…` names in `sealed-ui.css` carry the same BUI values in hex during the migration and are removed batch by batch. Text on semantic tints uses the AA-safe `*-text` tones; bright display tones are reserved for dots, fills and charts. White labels sit on the darkened accent fill; dark-theme filled buttons switch their label to the page tone.

## Structure

- Desktop: persistent primary navigation, fluid page canvas, optional right detail drawer.
- Rail: 232px on wide desktop (200px below 1120px); the brand lockup uses a 30px mark with a 16px/500 name and an 11px status line, so navigation rows stay compact and the conversation keeps the width.
- Mobile: compact primary navigation and full-height detail overlay, with the same information order and actions.
- Settings: dedicated page with a stable category rail; model services, classification Router and Pegas runtime are separate destinations.
- Conversation: editorial message flow and bottom composer; execution events are inspectable facts, not fake assistant bubbles.
- Conversation header: a compact single line — 16px/500 title over a hairline divider, no tagline; the rail brand already carries identity.
- User messages: a neutral warm-grey bubble (`--message-bubble`, derived from `--surface`) with 18px radii and a 6px tail corner; no accent-tinted fill and no interactive elements inside the bubble.
- Message lifecycle slot: each user message owns one icon-only slot in its always-visible meta row (`status · time · copy`). Pending shows a check, processing a spinner, failure an alert plus an always-visible retry; status wording lives in the hover title and accessible label. On success the slot becomes the derived-work entry: one task renders a link icon that opens the task drawer; multiple tasks render a link icon with a count and open a small menu listing each task's title and live status, each item opening that task's drawer. Zero derived tasks show no link. Touch keeps icons tappable with labels; hover text is supplemental, never the only failure signal.
- Work-entry vocabulary (DESIGN-008): every link icon in the conversation meta rows means "go to the task" and opens the task drawer (review-ready facts open the review drawer); Pegas say messages and work fact cards carry the same 14px link icon in their meta row instead of inline text links or card buttons. The only in-page jump is the fact-card origin anchor, rendered as an up-to-line arrow ("back to the originating message"), never a link icon. A run.completed fact with the server `automationActive` flag reads "已安排" with a calendar-clock icon (card heading and drawer hero) instead of "已完成".
- Composer: use a quiet Codex-like two-level surface: the growing message field occupies the upper area and a single bottom toolbar holds attachment, real model identity, voice and send actions. The model control opens an anchored, searchable picker containing every model returned by the current execution endpoint; selection is saved in place and never navigates away from the conversation. Keyboard focus belongs to the outer surface rather than drawing a second rectangle around the text field; the field grows vertically without changing its horizontal footprint.
- Search remains a small, focused overlay. The header appearance control toggles the rendered light/dark scheme directly; the three choices — system, light and dark — live in the dedicated Appearance settings page. A stored legacy `warm` value migrates to `light`. First-run setup is a guided flow, not a settings dump.

## Component rules

- Prefer plain rows, type and dividers over nested cards.
- Use one primary action per region. Secondary actions are quiet buttons or links.
- Typography follows the DESIGN-004 scale: every `font-size` references a `--text-*` token; headings and emphasis use weight 500, body 400. Section titles (14px) outrank card titles (13px); card body and button text sit one step (−1px) below adjacent outside body copy. Text inputs stay at 16px to avoid iOS focus zoom.
- Headings use `text-wrap: balance`; display titles (26px) use line-height 1.2 and −0.03em tracking, section titles (20px) use 1.25 and −0.02em. No eyebrow labels above headings, no decorative count/position pills; status is plain text.
- Status always has text; color and icons are supplemental.
- Drawers and dialogs own a header, close action, scroll body and optional action footer.
- Loading preserves layout. Empty states explain what is absent and whether the capability exists yet.
- Errors appear beside the failed operation, preserve user input and offer a recovery action.
- Themes are implemented entirely with semantic custom properties. Component selectors never hardcode a theme-specific surface. Dark mode toggles both `data-theme` and the `.dark` class on `<html>`; BUI islands scope their reset to `.bui` and live in declared cascade layers (`theme, base, components, utilities`) with no Tailwind preflight.
- Pointer-follow visuals write DOM styles directly (ref + style), never through React state, so drags track the cursor without lag.
- Streaming Chinese text tokenizes with `Array.from` (code points), never by UTF-16 units or word spaces.

## Accessibility and responsive rules

- Use native interactive elements before ARIA.
- Use `:focus-visible` for visible keyboard focus.
- Preserve Chinese IME composition: `Enter` sends, `Shift+Enter` adds a line, and an active composition must never submit early.
- Minimum coarse-pointer target is 44px.
- Respect reduced motion.
- Use dynamic viewport units for mobile full-height surfaces.
- Validate the sealed desktop composition and a 390px mobile composition for every primary page and overlay family.
