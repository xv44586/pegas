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
  page-title: '600 26px/1.25'
  section-title: '600 16px/1.4'
  body: '400 14px/1.65'
  label: '500 13px/1.4'
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
- Search remains a small, focused overlay. The header appearance control toggles the rendered light/dark scheme directly; complete system, light, warm and dark choices live in the dedicated Appearance settings page. First-run setup is a guided flow, not a settings dump.

## Component rules

- Prefer plain rows, type and dividers over nested cards.
- Use one primary action per region. Secondary actions are quiet buttons or links.
- Status always has text; color and icons are supplemental.
- Drawers and dialogs own a header, close action, scroll body and optional action footer.
- Loading preserves layout. Empty states explain what is absent and whether the capability exists yet.
- Errors appear beside the failed operation, preserve user input and offer a recovery action.
- Themes are implemented entirely with semantic custom properties. Component selectors never hardcode a theme-specific surface.

## Accessibility and responsive rules

- Use native interactive elements before ARIA.
- Use `:focus-visible` for visible keyboard focus.
- Minimum coarse-pointer target is 44px.
- Respect reduced motion.
- Use dynamic viewport units for mobile full-height surfaces.
- Validate the sealed desktop composition and a 390px mobile composition for every primary page and overlay family.
