---
name: Pegas
description: Sealed white-first personal agent workspace for conversation, work and inspectable execution.
colors:
  accent: '#5267F8'
  accent-soft: '#EEF0FF'
  canvas: '#FFFFFF'
  surface: '#F7F7F5'
  surface-raised: '#FFFFFF'
  ink: '#181818'
  muted: '#70706B'
  line: '#E8E8E4'
  positive: '#2F7A58'
  caution: '#A66B16'
  critical: '#C94855'
themes: ['light-default', 'warm', 'dark', 'system']
typography:
  family: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
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
  control: '10px'
  card: '14px'
  overlay: '18px'
motion:
  fast: '140ms'
  normal: '200ms'
---

# Pegas Design System

## Creative direction

Pegas is a quiet, white-first personal agent workspace. Conversation remains the primary surface; work tracking, approvals, settings and runtime inspection are close at hand without turning the product into an enterprise dashboard. The visual rhythm comes from whitespace, type hierarchy and precise dividers. Blue is a signal for Pegas, selection and decisive action—not a decorative background.

The approved implementation contract is [docs/sealed-ui-rebuild.md](docs/sealed-ui-rebuild.md). It supersedes the former DS Bot shell. The old `App.tsx` layout, `styles.css`, `workspace-theme.css`, legacy rail geometry and modal system are not design authority and must not be imported by the rebuilt entry point.

## Structure

- Desktop: persistent primary navigation, fluid page canvas, optional right detail drawer.
- Mobile: compact primary navigation and full-height detail overlay, with the same information order and actions.
- Settings: dedicated page with a stable category rail; model services, classification Router and Pegas runtime are separate destinations.
- Conversation: editorial message flow and bottom composer; execution events are inspectable facts, not fake assistant bubbles.
- Composer: use a quiet Codex-like two-level surface: the growing message field occupies the upper area and a single bottom toolbar holds attachment, real model identity, voice and send actions. The model control opens an anchored, searchable picker containing every model returned by the current execution endpoint; selection is saved in place and never navigates away from the conversation. Keyboard focus belongs to the outer surface rather than drawing a second rectangle around the text field; the field grows vertically without changing its horizontal footprint.
- Search remains a small, focused overlay. The header appearance control toggles the rendered light/dark scheme directly; complete system, light, warm and dark choices live in the dedicated Appearance settings page. First-run setup is a guided flow, not a settings dump.

## Component rules

- Prefer plain rows, type and dividers over nested cards.
- Use one primary action per region. Secondary actions are quiet buttons or links.
- Typography follows the DESIGN-004 scale: every `font-size` references a `--text-*` token; headings and emphasis use weight 500, body 400. Section titles (14px) outrank card titles (13px); card body and button text sit one step (−1px) below adjacent outside body copy. Text inputs stay at 16px to avoid iOS focus zoom.
- Headings use `text-wrap: balance`; display titles (26px) use line-height 1.2 and −0.03em tracking, section titles (20px) use 1.25 and −0.02em. No eyebrow labels above headings, no decorative count/position pills; status is plain text.
- Status always has text; color and icons are supplemental.
- Drawers and dialogs own a header, close action, scroll body and optional action footer.
- Loading preserves layout. Empty states explain what is absent and whether the capability exists yet.
- Errors appear beside the failed operation, preserve user input and offer a recovery action.
- Themes are implemented entirely with semantic custom properties. Component selectors never hardcode a theme-specific surface.

## Accessibility and responsive rules

- Use native interactive elements before ARIA.
- Use `:focus-visible` for visible keyboard focus.
- Preserve Chinese IME composition: `Enter` sends, `Shift+Enter` adds a line, and an active composition must never submit early.
- Minimum coarse-pointer target is 44px.
- Respect reduced motion.
- Use dynamic viewport units for mobile full-height surfaces.
- Validate the sealed desktop composition and a 390px mobile composition for every primary page and overlay family.
