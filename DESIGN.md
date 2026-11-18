---
name: Pegas
description: A quiet operating shell that turns natural dialogue into durable, inspectable work.
colors:
  pegas-blue: "#4d6bfe"
  pegas-blue-soft: "#eef1ff"
  ink: "#141414"
  user-ink: "#070707"
  secondary-ink: "rgba(20, 20, 20, 0.62)"
  metadata: "#666666"
  canvas: "#fcfcfc"
  paper: "#ffffff"
  sidebar: "#f7f7f7"
  conversation: "#eeeeee"
  line: "rgba(20, 20, 20, 0.08)"
  line-strong: "rgba(20, 20, 20, 0.15)"
  positive: "#177a52"
  caution: "#94610a"
  critical: "#b5293b"
  on-accent: "#ffffff"
typography:
  display:
    fontFamily: "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2rem, 1.35rem + 2.1vw, 3.15rem)"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 620
    lineHeight: 1.41
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.68
  label:
    fontFamily: "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 620
    lineHeight: 1.38
  metadata:
    fontFamily: "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  composer: "22px"
  pill: "999px"
  circle: "50%"
spacing:
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "56px"
components:
  action-primary:
    backgroundColor: "{colors.pegas-blue}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "36px"
  navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: "48px"
  navigation-item-selected:
    backgroundColor: "rgba(20, 20, 20, 0.09)"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: "48px"
  message-pegas:
    backgroundColor: "{colors.conversation}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "13px 16px"
  message-user:
    backgroundColor: "{colors.user-ink}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "13px 18px"
  composer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "11px 12px 9px 15px"
    height: "56px"
  settings-group:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  page-pill:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "18px"
    padding: "4px 7px 4px 12px"
    height: "48px"
---

# Design System: Pegas

## Overview

**Creative North Star: "The Quiet Task Ledger"**

Pegas should feel like a reliable execution partner keeping a calm, legible record beside the user. Natural dialogue is the foreground; durable tasks, progress, and controls remain close enough to inspect without turning the product into a cockpit. The visual system therefore favors quiet neutral fields, compact controls, and obvious state changes over decoration.

The shell is restrained and workmanlike: near-white canvas, pale navigation, soft gray conversation surfaces, strong black ink, and one clear Pegas blue. Identity appears through the P or robot mark and through disciplined blue moments—not through ornamental branding. Density is comfortable rather than sparse, and every floating element must earn its elevation through function.

**Key Characteristics:**

- Neutral, actor-led workspace with dialogue at the center.
- Pegas blue reserved for identity, selection, progress, and primary action.
- Durable task state embedded in the conversation and available in deeper work views.
- Flat, inspectable surfaces with ambient elevation only for floating controls and overlays.
- Desktop structure that collapses cleanly into touch-safe mobile navigation and full-screen settings.

## Colors

The palette is a warm-neutral monochrome shell punctuated by a single crisp identity blue and restrained semantic status colors.

### Primary

- **Pegas Blue:** The identity, selected-control, progress, focus, and primary-action color. Its rarity makes each use read as intentional.
- **Pegas Blue Soft:** A low-intensity selection field for chosen providers, options, and other active rows.

### Neutral

- **Core Ink:** Primary text, icons, and decisive controls.
- **User Ink:** The near-black user-message surface, used only where authored dialogue needs strong separation.
- **Secondary Ink:** Supporting text and inactive controls.
- **Metadata Gray:** Time, counts, hints, and tertiary status copy.
- **Canvas White:** The continuous application background.
- **Paper White:** Inputs, grouped rows, cards, and floating control surfaces.
- **Sidebar Mist:** Navigation rails and low-contrast structural regions.
- **Conversation Gray:** Pegas messages, task pulses, and profile surfaces.
- **Quiet Line / Strong Line:** Dividers and control boundaries, never decorative framing.

### Secondary

- **Positive Green:** Healthy, connected, or completed status.
- **Caution Amber:** Warning states that require attention without implying failure.
- **Critical Red:** Errors, blocked states, and destructive feedback.

### Named Rules

**The One Blue Voice Rule.** Pegas blue is reserved for identity, selection, progress, focus, and the primary action; it must not become ambient decoration.

**The Neutral Field Rule.** Build hierarchy by moving between canvas, paper, sidebar, and conversation neutrals before adding color.

## Typography

**Display Font:** Inter Variable (with Inter, system sans-serif fallbacks)

**Body Font:** Inter Variable (with Inter, system sans-serif fallbacks)

**Label Font:** Inter Variable (with Inter, system sans-serif fallbacks)

**Character:** A single compact sans-serif family keeps conversation, task state, and settings controls visually continuous. Hierarchy comes from weight, size, line height, and modest negative tracking rather than multiple typefaces.

### Hierarchy

- **Display:** Semibold, tightly tracked, and balanced; reserved for meaningful empty-state or home introductions.
- **Title:** Compact section and dialog headings with a slightly tightened rhythm.
- **Body:** Highly readable dialogue and descriptive text; long-form conversation uses the roomiest line height in the system.
- **Label:** Dense navigation, row titles, and control labels; sentence case is the default.
- **Metadata:** Quiet times, counts, helper text, and compact operational state.

### Named Rules

**The Conversation First Rule.** Body text must remain more readable than surrounding metadata; operational chrome should never compete with the dialogue.

## Layout

The desktop shell uses a fixed 280px application navigation rail and a flexible main column. Conversation content is centered within a maximum 960px flow, while the composer widens slightly to 992px. A floating page pill sits at the top of the main column, and the capsule composer anchors the bottom without enclosing the whole conversation in a card.

At 1180px and below, the application rail contracts to 88px and becomes icon-led. At 820px and below, navigation becomes a 62px top bar; the main column consumes the remaining viewport, conversation gutters contract, and task columns stack. Coarse-pointer actions preserve at least a 44px touch target. At 560px and below, message widths expand carefully, profile geometry compacts, and settings content uses 18px side padding.

Settings are a modal operating surface on desktop: a centered dialog up to 1100px wide and 780px tall, with a 198px category rail, a flexible content region, and a fixed 58px save footer. At 820px and below, settings become a full-viewport sheet with horizontally scrollable category tabs and independently scrolling content.

Use the 4/8/12/16/24/32px rhythm for component gaps and padding, with larger 56px gutters only where the shell has enough width. Maintain one continuous spatial hierarchy; avoid subdividing every region into a card.

## Elevation & Depth

The system is flat by default. Canvas, paper, sidebar, conversation gray, dividers, and selection fills establish most depth. Ambient shadows are reserved for the floating page pill, bottom composer, desktop settings dialog, and a barely perceptible grouped-row lift. The settings scrim uses a soft dark veil and slight blur to separate the overlay from the shell.

### Shadow Vocabulary

- **Floating Pill:** A compact ambient shadow that separates the page control without making it look like a card.
- **Composer Rest / Focus:** A low shadow at rest that deepens slightly when the writing surface is active.
- **Settings Dialog:** The strongest shadow in the system, used only for the centered modal layer.
- **Grouped Row:** A near-flat shadow that prevents pale grouped controls from disappearing into the canvas.

### Named Rules

**The Flat-by-Default Rule.** Resting content surfaces use tone and dividers; elevation belongs only to functional floating layers.

## Shapes

Pegas uses gently rounded rectangles rather than pills for ordinary controls. Small fields and buttons use 10px corners, navigation and grouped rows use 12px, conversation surfaces use 16px, the settings dialog uses 20px, and the composer uses 22px. Circular geometry is reserved for compact icon actions, status dots, and radio-like indicators; count badges may use a full pill radius.

Borders are quiet and structural. Use the strong line for interactive boundaries and the lighter line for internal dividers. Do not add ornamental outlines, clipped novelty shapes, or gradient borders. The P and robot marks are the only recurring branded silhouettes.

## Components

### Buttons

- **Shape:** Compact rounded rectangles for text actions and true circles for icon-only actions.
- **Primary:** Pegas blue with white text; the settings save action uses a 36px minimum height and compact horizontal padding.
- **Hover / Focus:** Hover may deepen to core ink; keyboard focus uses a clearly offset blue outline. Pressed navigation and icon actions may compress subtly.
- **Secondary / Ghost:** Neutral paper or transparent surfaces with ink text and a quiet neutral hover fill.

### Chips

- **Style:** Small neutral metadata capsules use subdued ink on a faint gray fill; blue is reserved for an actual selected or progressed state.
- **State:** Counts, task stages, and status tags remain compact, tabular where numeric, and subordinate to the row title.

### Cards / Containers

- **Corner Style:** Conversation and task containers use gentle 14–16px corners; settings groups use 12px.
- **Background:** Prefer paper for interactive grouped content and conversation gray for Pegas-authored or summarized state.
- **Shadow Strategy:** Flat by default; grouped settings rows may use the near-flat grouped-row shadow.
- **Border:** Use one quiet structural border, with internal dividers between related rows.
- **Internal Padding:** Typically 12–16px; larger profile surfaces may use 22–24px.

### Inputs / Fields

- **Style:** Paper surface, strong neutral border, 10–11px corners, and a minimum 40px height. Textareas inherit the same visual language at a larger size.
- **Focus:** Shift the border toward Pegas blue and show the shared offset focus outline without adding glow.
- **Error / Disabled:** Use semantic color and copy together; disabled actions move to a low-contrast neutral surface rather than relying on opacity alone.

### Navigation

The desktop rail uses 48px rows, compact icons, sentence-case labels, and a neutral selected fill. At medium widths it becomes an 88px icon rail; on mobile it becomes a 62px top bar with 44px targets. Selected navigation remains neutral—the Pegas mark and small counts carry the blue identity.

### Conversation Composer

The composer is a bottom capsule with a quiet border, one ambient shadow, readable 1rem input text, and circular attachment, dictation, and send actions. It must feel like the primary place to act without becoming a large hero card. Focus deepens the shadow and shifts the boundary toward blue.

### Settings Dialog

The settings overlay keeps categories, scrollable detail, and save state visibly separate. Grouped rows use 12px corners and internal dividers; the fixed footer preserves the primary action while content scrolls. Mobile uses the same hierarchy as a full-height sheet with horizontal tabs.

## Do's and Don'ts

### Do:

- **Do** keep dialogue and durable task state in one continuous, inspectable flow.
- **Do** use Pegas blue sparingly for identity, selection, progress, focus, and primary actions.
- **Do** preserve the 280px → 88px → 62px navigation transformation across desktop, compact desktop, and mobile.
- **Do** use tonal layering and quiet dividers before reaching for shadow or color.
- **Do** preserve clear focus indication, readable contrast, reduced-motion behavior, and 44px coarse-pointer targets.

### Don't:

- **Don't** introduce decorative gradients, cobalt-tinted paper fields, or ornamental effects.
- **Don't** turn the interface into a collection of generic dashboard cards or oversized hero panels.
- **Don't** use Pegas blue as a broad background wash or decoration unrelated to state or action.
- **Don't** make transport, runtime, or implementation details louder than the user's conversation and tasks.
- **Don't** replace the Pegas P or robot identity with unrelated mascots or borrowed brand motifs.
