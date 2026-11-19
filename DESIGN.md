---
name: Pegas
description: Pegas's Channel-as-Worker conversational workspace with a compact two-rail operating shell.
colors:
  pegas-blue: '#4d6bfe'
  pegas-blue-soft: '#eef1ff'
  ink: '#141414'
  user-ink: '#070707'
  muted: 'rgba(20, 20, 20, 0.62)'
  faint: '#666666'
  canvas: '#fcfcfc'
  paper: '#ffffff'
  panel: '#f7f7f7'
  bubble: '#eeeeee'
  line: 'rgba(20, 20, 20, 0.08)'
  line-strong: 'rgba(20, 20, 20, 0.15)'
  positive: '#177a52'
  caution: '#94610a'
  critical: '#b5293b'
  on-accent: '#ffffff'
typography:
  headline:
    fontFamily: 'Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '18px'
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: 'Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '15px'
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: '-0.01em'
  body:
    fontFamily: 'Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.71
  label:
    fontFamily: 'Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '13px'
    fontWeight: 500
    lineHeight: 1.38
  metadata:
    fontFamily: 'Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '11px'
    fontWeight: 400
    lineHeight: 1.27
rounded:
  xs: '6px'
  sm: '8px'
  control: '11px'
  md: '12px'
  card: '14px'
  panel: '16px'
  message: '18px'
  dialog: '20px'
  composer: '24px'
  pill: '999px'
  circle: '50%'
spacing:
  2xs: '4px'
  xs: '6px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '20px'
  2xl: '24px'
components:
  task-sidebar:
    backgroundColor: '{colors.panel}'
    textColor: '{colors.ink}'
    width: '280px'
    padding: '0 12px 6px'
  task-sidebar-collapsed:
    backgroundColor: '{colors.panel}'
    textColor: '{colors.ink}'
    width: '56px'
    padding: '0 10px 6px'
  task-row:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.md}'
    padding: '8px'
    height: '54px'
  task-row-selected:
    backgroundColor: 'rgba(119, 119, 119, 0.17)'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.md}'
    padding: '8px'
    height: '54px'
  collaboration-event:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.card}'
    padding: '12px'
  message-pegas:
    backgroundColor: '{colors.bubble}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.message}'
    padding: '7px 12px'
  message-user:
    backgroundColor: '{colors.user-ink}'
    textColor: '{colors.on-accent}'
    typography: '{typography.body}'
    rounded: '{rounded.message}'
    padding: '7px 12px'
  composer:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.composer}'
    padding: '8px 12px'
    height: '48px'
    width: '992px'
  workspace-tab:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.muted}'
    rounded: '{rounded.message}'
    padding: '10px 0'
    height: '112px'
    width: '36px'
  primary-action:
    backgroundColor: '{colors.pegas-blue}'
    textColor: '{colors.on-accent}'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '0 18px'
    height: '36px'
---

# Design System: Pegas

## Overview

**Creative North Star: "The Channel-Shaped Work Desk"**

The Pegas interface keeps the established compact conversation shell while making Pegas the only default identity. Its defining model is **WorkChannel = a durable working context represented by its Worker icon**. Selecting a Channel changes the conversation context without turning the product into a disconnected task dashboard or a roster of independent bots. The service-owned Task remains the authoritative lifecycle behind that projection.

The product should feel like a focused work desk with three stable zones: Pegas and Channels on the left, conversation in the center, and inspectable output on the right. The left rail also exposes a quiet Outbox entry for user attention. The right workspace remains collapsed by default so dialogue has priority; settings and plugins temporarily rise above the shell as modal layers. The visual language stays neutral, compact, and operational, with Pegas blue reserved for Worker geometry, active signals, progress, and decisive actions.

**Key Characteristics:**

- WorkChannel identity expressed through Pegas Worker icons whose color communicates state.
- 280px expanded Channel rail and 56px collapsed rail.
- Centered conversation flow capped at 960px, with a 48px capsule composer.
- Right workspace represented by a narrow collapsed tab until inspection is requested.
- Delegation, handoff and returned results appear as compact system events rather than fake chat messages.
- Settings, plugin catalog, and plugin detail presented as progressively deeper modal layers.
- Pegas interaction and visual identity applied consistently to Channels, messages, settings, plugins, Outbox and workspaces.

## Colors

The palette is a neutral operating canvas with a single cool Pegas blue used as the active visual signal.

### Primary

- **Pegas Blue:** Worker marks, active dots, progress, voice/send actions, selected icons, and primary controls.
- **Pegas Blue Soft:** Quiet backing for bot marks, selected configuration rows, plugin marks, and other low-intensity active states.

### Neutral

- **Core Ink / User Ink:** Primary content and the near-black user-message bubble.
- **Muted / Faint Ink:** Secondary descriptions, Channel goals, timestamps, hints, and inactive controls.
- **Canvas / Paper / Panel:** Main field, raised control surfaces, and the left Channel rail.
- **Conversation Gray:** Pegas message bubbles and quiet summarized content.
- **Quiet Line / Strong Line:** Structural separators and interactive boundaries.

### Secondary

- **Positive Green:** Connected, healthy, or completed state.
- **Caution Amber:** Attention states that are not failures.
- **Critical Red:** Errors, blocked state, and destructive feedback.

### Named Rules

**The Worker Signal Rule.** Pegas blue belongs to Worker geometry, current state, progress, focus, and primary action; it is not a decorative wash. State also needs a text label or shape and cannot rely on color alone.

**The Neutral Shell Rule.** Establish hierarchy with canvas, paper, panel, bubble, and line tones before adding color or elevation.

## Typography

**Headline Font:** Inter Variable (with Inter and system sans-serif fallbacks)

**Body Font:** Inter Variable (with Inter and system sans-serif fallbacks)

**Label Font:** Inter Variable (with Inter and system sans-serif fallbacks)

**Character:** The interface uses one compact sans-serif family throughout. Conversation keeps a generous line height, while rail labels, modal headings, and metadata stay dense enough to support an operating surface.

### Hierarchy

- **Headline:** Bold 18px text for settings and plugin dialog titles.
- **Title:** Medium 15px text for the Pegas rail identity and compact contextual headings.
- **Body:** 14px text on a 24px line for messages, Channel content, and primary descriptions.
- **Label:** 13px text on an 18px line for Channel goals, compact control labels, and subordinate titles.
- **Metadata:** 11px text on a 14px line for timestamps, states, captions, and plugin status.

### Named Rules

**The Message Rhythm Rule.** Dialogue owns the roomiest line height; rail and modal chrome must remain visually quieter than the message content.

## Layout

The desktop shell is a three-column grid. The left Channel rail is 280px when expanded, the conversation column consumes remaining space, and the right workspace is represented by a 48px rail containing a vertical 36×112px tab. Opening the workspace replaces that 48px rail with a responsive panel between 320px and 420px wide. An explicitly collapsed Channel rail is a quiet 56px strip containing only the expand button; expanding it restores Pegas, Channel, Outbox, settings and plugin access.

Conversation content is capped at 960px and aligned within the central column. User and Pegas bubbles generally cap at 80% of the available flow. The composer is capped at 992px, has a 48px minimum height, and sits at the bottom of the conversation without creating a second page frame.

At 1100px and below, the task rail automatically uses the 56px icon form. Between 821px and 1100px, an opened workspace takes a real third grid column up to 420px wide, so it cannot cover or clip the conversation. At 820px and below, the workspace becomes a right-side overlay and settings use their full-viewport/mobile-sheet behavior with horizontally scrollable categories. The workspace empty-state header is positioned relative to its own panel so its title, divider, and close action cannot drift across the left rail. At 680px and below, the shell remains a persistent 56px task rail plus conversation; the workspace tab floats at the right edge, and the plugin catalog becomes full viewport with a single-column grid. At 560px and below, settings content and forms use their narrowest stacking rules. Coarse-pointer controls expand to 44px targets even when their visual glyph container is smaller.

Settings use a centered dialog up to 1100×780px with a 198px category rail, scrollable content, and fixed 58px save footer. Plugins use an 860px catalog dialog, while a selected plugin opens a second 480px detail layer above it. Layering is intentional: shell → catalog/settings modal → plugin detail.

## Elevation & Depth

Most hierarchy is flat and tonal. The Channel rail, messages, collaboration events, and workspace rail use color fields and hairline borders rather than shadow. Elevation is concentrated on the floating context pill, composer, workspace overlay, settings/plugin dialogs, and plugin detail.

### Shadow Vocabulary

- **Floating Chrome:** Dual ambient shadow for the context pill and composer: `0 8px 28px -6px rgba(0,0,0,0.08)` plus `0 2px 6px -1px rgba(0,0,0,0.04)`.
- **Workspace Overlay:** Trailing panel shadow `-18px 0 48px rgba(20,20,20,0.12)` at 820px and below.
- **Modal Dialog:** Settings and plugin catalog shadow `0 24px 70px rgba(20,20,20,0.22)`.
- **Detail Dialog:** Plugin detail shadow `0 24px 70px rgba(20,20,20,0.24)`.

### Named Rules

**The Inspect-on-Demand Rule.** Keep conversation flat and dominant; elevation appears only when a control, workspace, or configuration layer temporarily moves above it.

## Shapes

The defining silhouette is Pegas's fixed main robot mark. WorkChannels use system-assigned Pegas Worker icons; the same icon identifies the Worker across its Channel, settings and usage views, while contextual color communicates current Channel state. Users do not choose internal icon IDs. Supporting controls use a single rounded icon family with consistent view box, stroke, caps and joins.

Controls use 6–12px radii, Channel and plugin cards use 12–16px, message bubbles and the workspace tab use 18px, dialogs use 18–20px, and the composer uses 24px. True circles are reserved for compact icon actions, unread indicators, and status dots. Full pills are reserved for the page context header and tiny status capsules.

Borders are quiet and structural. The shell uses hairlines to separate rails; interactive cards use a single neutral boundary. Do not add ornamental frames or gradient borders. The only gradient currently permitted is the functional edge fade behind the floating mobile workspace tab.

## Components

### Channel Rail

- **Expanded:** 280px panel with fixed Pegas entry, Channels heading/actions, scrollable Channel rows, Outbox, settings and plugin controls.
- **Collapsed:** 56px rail containing only the expand button, matching the established explicit-collapse contract.
- **Channel Row:** 54px minimum height, 36px Worker mark, 8px gap/padding, 12px corners, neutral active fill, title, latest visible activity, time and optional origin marker.
- **Outbox Entry:** A quiet navigation row with an attention count; delivery status and read status remain distinct.

### Buttons

- **Round Utility:** 36px circle with a quiet border; pressed state scales to 0.94.
- **Composer Actions:** 28px visual circles for attachment, dictation, voice, and send; coarse pointers expand the target to 44px.
- **Primary:** Pegas blue with white content; hover may reduce opacity or deepen toward ink depending on context.
- **Focus:** Shared offset blue focus outline remains visible against every neutral surface.

### Conversation

- **User Message:** Right-aligned near-black 18px bubble with white 14/24 text and metadata below.
- **Pegas Message:** Left-aligned conversation-gray 18px bubble with no avatar; metadata and contextual actions sit beneath it.
- **Channel Pulse:** Full-flow paper card up to 960px with a quiet border, progress, and workspace affordance.
- **Message Actions:** 24px controls hidden at rest and revealed on hover or keyboard focus.

### Collaboration Events

- **Delegation:** Source and target Worker marks, a one-line reason, target Channel title, status text and a detail action. The source remains responsible and the card later shows the returned result summary.
- **Handoff:** Uses ownership-transfer copy and does not imply that the source waits for a result.
- **Context Note:** A compact activity row inside the relevant Channel; it does not appear in the Pegas main conversation by default.
- **State Update:** The visible card updates in place while immutable server events preserve the full audit trail. Frequent progress changes are not announced as separate live-region messages.
- **Navigation:** Selecting a card opens its detail in the right workspace; a separately named action enters the target Channel.

### Conversation Composer

The 48px-high composer is a 24px capsule with 8×12px padding, 14/24 text, and compact circular actions. Attachment stays on the left; dictation and voice/send occupy the right. The disabled send action disappears, and entering text swaps the voice action for send.

### Workspace

The default state is a 48px right rail with a vertical 36×112px tab. Expanded desktop workspace occupies 320–420px. Between 821px and 1100px it remains a non-overlapping grid column; at 820px and below it overlays the conversation from the right. At 680px and below its collapsed tab floats over a functional edge fade.

### Settings

Settings are a centered 1100×780px maximum dialog with a 198px category rail, grouped 12px row cards, independently scrolling details, and a fixed 58px save footer. Below 820px the dialog becomes a full-viewport sheet with horizontal category tabs.

Settings, the plugin catalog, and plugin detail are true keyboard modals: opening moves focus to the close control, Tab remains inside the active layer, Escape closes it, the obscured layer is inert, and focus returns to the control that opened it.

### Plugins

The plugin catalog uses an 860px modal with a two-column card grid. Plugin cards use a 42px blue-soft mark, 14px corners, and concise status metadata. Selecting a plugin opens a second 480px detail dialog with a 12px neutral boundary block; on narrow screens the catalog fills the viewport and becomes one column.

## Do's and Don'ts

### Do:

- **Do** treat each durable WorkChannel as a Worker-shaped conversation context, not merely a dashboard row.
- **Do** preserve the 280px expanded and 56px explicitly collapsed rail states.
- **Do** keep the conversation flow at or below 960px and the composer at a 48px minimum height.
- **Do** keep the right workspace collapsed by default and reveal inspection depth on demand.
- **Do** keep delegation, handoff and context transfer visually distinct from user and Pegas chat bubbles.
- **Do** use the Pegas icon family consistently and combine state color with accessible text or shape.
- **Do** keep settings, plugin catalog, and plugin detail as clearly ordered modal layers.
- **Do** preserve modal focus trapping, Escape dismissal, inert backgrounds, and trigger-focus restoration at every layer.

### Don't:

- **Don't** revert mobile navigation to a top bar; the current shell preserves the 56px Channel rail.
- **Don't** expose the workspace as a permanent wide panel when the user has not requested inspection.
- **Don't** replace WorkChannel with a generic card board or disconnected task dashboard.
- **Don't** render Worker-to-Worker collaboration as private chat bubbles or expose raw internal messages as Pegas replies.
- **Don't** make Worker, model or Channel configuration a prerequisite for speaking to Pegas.
- **Don't** use Pegas blue as ambient decoration or a broad background field.
- **Don't** mix unrelated icon families, stroke weights, or sharp-cornered glyph geometry into the Pegas shell.
- **Don't** let modal detail layers obscure their close action, scroll boundary, or service-owned configuration boundary.
