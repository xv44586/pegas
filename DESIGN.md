---
name: Pegas
description: A restrained cobalt-and-cool-paper system for conversation-led durable work.
colors:
  ink: "#172033"
  muted: "#667085"
  faint: "#59667e"
  line: "#d7deea"
  line-strong: "#c7d0df"
  canvas: "#f8f9fc"
  paper: "#ffffff"
  panel: "#eef2f7"
  blue: "#2457d6"
  blue-dark: "#1a2b58"
  blue-soft: "#e7edff"
  green: "#19865c"
  green-soft: "#e2f4eb"
  amber: "#a76208"
  amber-soft: "#fff0d5"
  red: "#c33c4a"
  red-soft: "#fae7e9"
typography:
  display:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(1.55rem, 2.5vw, 2rem)"
    fontWeight: 720
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.18rem"
    fontWeight: 710
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 670
    letterSpacing: "-0.012em"
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.65
  compact-body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 650
rounded:
  status: "8px"
  field: "9px"
  sm: "10px"
  control: "11px"
  surface: "12px"
  md: "14px"
  bubble: "15px"
  composer: "16px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "28px"
  feed: "40px"
components:
  navigation-rail-button:
    textColor: "#aebce2"
    rounded: "{rounded.control}"
    size: "42px"
  navigation-rail-button-active:
    backgroundColor: "rgba(255, 255, 255, 0.1)"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    size: "42px"
  button-task:
    backgroundColor: "{colors.blue-dark}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 13px"
    height: "42px"
  button-send:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "50%"
    size: "36px"
  button-send-disabled:
    backgroundColor: "#e4e8ef"
    textColor: "#9aa6bd"
    rounded: "50%"
    size: "36px"
  button-dictation:
    backgroundColor: "#edf0f5"
    textColor: "#273248"
    rounded: "50%"
    size: "36px"
  button-dictation-recording:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "50%"
    size: "36px"
  composer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
    padding: "12px 12px 10px 16px"
  task-pulse:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "17px 18px 15px"
  task-filter-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.compact-body}"
    rounded: "{rounded.status}"
    height: "36px"
  user-message:
    backgroundColor: "#25375d"
    textColor: "{colors.paper}"
    rounded: "15px 15px 4px 15px"
    padding: "13px 16px"
---

# Design System: Pegas

## Overview

**Creative North Star: "The Quiet Relay"**

Pegas is a calm handoff from intent to durable action. Cool paper surfaces and ink-dark text keep the conversation primary; cobalt appears only where the interface is carrying work forward, while compact status signals make long-running activity legible without turning the product into a dashboard.

The system pairs a task-pulse conversation entry with an on-demand personal control center. Work grows naturally out of a message, stays visible in the conversation, and reveals its runs, timing, output, and errors only when the user asks for depth. Precision comes from thin rules, measured density, consistent curved geometry, and restrained motion—not decoration.

**Key Characteristics:**

- Conversation-first hierarchy with task state embedded in the flow.
- Cool, quiet paper layers anchored by deep ink and restrained cobalt.
- Progressive disclosure from task pulse to a focused task workbench.
- Compact, plain-language status cues with semantic color support.
- Responsive continuity: the same information model becomes a full-screen task detail on mobile.

## Colors

The palette is a cool-paper field with dark blue-black ink, one cobalt execution voice, and muted semantic signals.

### Primary

- **Relay Cobalt** (`blue`): Use for execution progress, active steps, send actions, and the smallest high-value navigation cues.
- **Deep Cobalt** (`blue-dark`): Anchor the desktop identity rail and primary mobile task action; it supplies gravity without widening the accent palette.
- **Cobalt Wash** (`blue-soft`): Use behind blue status text and restrained informational emphasis.

### Secondary

- **Completion Green** (`green`) and **Completion Wash** (`green-soft`): Reserve for completed steps, online presence, and successful runs.
- **Attention Amber** (`amber`) and **Attention Wash** (`amber-soft`): Reserve for paused or user-waiting states.
- **Recovery Red** (`red`) and **Recovery Wash** (`red-soft`): Reserve for failures, connection problems, and error recovery.

### Neutral

- **Working Ink** (`ink`): Primary copy and high-emphasis titles.
- **Quiet Text** (`muted`) and **Faint Text** (`faint`): Secondary explanations, timestamps, metadata, and low-priority controls.
- **Cool Canvas** (`canvas`): Main conversation surface.
- **Clean Paper** (`paper`): Composer, pulse, selected filters, and result containers.
- **Workbench Panel** (`panel`): Task list and detail surface.
- **Fine Rule** (`line`) and **Strong Rule** (`line-strong`): Structural separators and interactive boundaries.

### Named Rules

**The One Execution Voice Rule.** Cobalt marks actions and active execution; do not introduce another brand accent for equivalent emphasis.

**The Semantic Restraint Rule.** Green, amber, and red communicate state only; they never become decorative surface colors.

## Typography

**Display Font:** Inter Variable (with Inter, system UI, and sans-serif fallbacks)

**Body Font:** Inter Variable (with Inter, system UI, and sans-serif fallbacks)

**Label Font:** Inter Variable (with Inter, system UI, and sans-serif fallbacks)

**Character:** One highly legible sans-serif family keeps conversation, status, and execution detail in the same voice. Weight and density—not font changes—create hierarchy, with slightly tightened headings and tabular numerals for time and run metadata.

### Hierarchy

- **Display** (720, responsive `display`, tightened): Empty-state headings only; keep it brief and centered.
- **Headline** (710, `headline`, tightened): Panel and task-detail titles.
- **Title** (670, `title`, tightened): Task-pulse titles and other high-signal row titles.
- **Body** (400, `body`): Conversation copy, constrained to roughly 72 characters where practical.
- **Compact Body** (400, `compact-body`): Task explanations, form notes, and workbench detail.
- **Label** (650, `label`): Status, metadata headers, task actions, and compact controls.

### Named Rules

**The One Voice Rule.** Keep all interface language in the Inter family; hierarchy comes from weight, scale, spacing, and placement.

**The Human First Rule.** User-facing task and status language stays plain; runtime vocabulary belongs inside the expanded task workbench.

## Layout

Desktop uses a three-part working frame: a 72px identity rail, a fluid conversation column with a 460px minimum, and a 320–380px task workbench. The central feed and composer share a 760px maximum width so messages, pulse cards, and input remain visually continuous. The composer is docked to the bottom of the conversation column, while the feed alone scrolls.

At 1080px, the rail tightens to 64px, the conversation minimum becomes 420px, and the workbench settles at 330px. At 820px and below, the rail disappears, the conversation becomes the full viewport, and the task workbench becomes a full-screen modal surface entered from the header or a task pulse. At 520px and below, message width expands to 88%, task pulses use the full content width, and low-priority composer guidance is removed.

The spacing rhythm is compact and repeatable: 8–16px inside controls, 24–28px between structural groups, and 40px for feed-level breathing room. Preserve the conversation as the default scene; task inspection adds depth instead of replacing the entry model.

**The Conversation Continuity Rule.** A task begins in the conversation and opens into more detail without asking the user to choose a project or management mode first.

## Elevation & Depth

Pegas is flat by default. Cool tonal layers and fine rules establish structure; shadows appear only where a surface floats, responds, or enters from outside the current plane. The composer uses a soft downward ambient shadow, a hovered task pulse lifts by one pixel, and the mobile task workbench carries a left-cast panel shadow. Avoid glow, glass, and decorative gradients.

### Shadow Vocabulary

- **Composer Ambient** (`0 10px 28px rgba(31, 47, 82, 0.1)`): Keeps the docked input distinct from the scrolling feed.
- **Composer Focus** (`0 10px 30px rgba(31, 47, 82, 0.13)`): Slightly increases definition when the input contains focus.
- **Pulse Hover** (`0 10px 24px rgba(35, 54, 95, 0.1)`): Accompanies the task pulse's one-pixel lift.
- **Mobile Workbench** (`-14px 0 40px rgba(27, 43, 81, 0.12)`): Clarifies the full-screen panel's entrance direction.

### Named Rules

**The Flat Until Active Rule.** Resting surfaces rely on tone and border; elevation appears only for focus, hover, or panel transition.

## Shapes

The form language is gently curved and compact. Small status and filter elements use 8–10px corners, controls and cards use 11–14px corners, and the composer uses the broadest 16px curve. Borders are thin and cool. Circular dots and step nodes carry status; they are functional markers, not ornament.

The user message bubble is the only intentionally asymmetric silhouette: three 15px corners and a 4px lower-right tail. Keep signature shapes quiet, aligned to the grid, and free of ornamental clipping.

## Components

Components feel precise, calm, and ready to inspect. Every interactive component has a visible focus ring; hover changes remain small and immediate.

### Buttons

- **Shape:** Compact curves (`rounded.status` through `rounded.control`) with 36–42px square or minimum-height targets.
- **Primary:** Cobalt send actions use white iconography; the mobile Task action uses deep cobalt with a label.
- **Hover / Focus:** Darken cobalt slightly on hover and use the shared 3px translucent cobalt focus outline with a 2px offset.
- **Disabled:** Replace the accent with a quiet cool gray and preserve an unmistakable disabled cursor and contrast change.
- **Icon controls:** Use transparent backgrounds at rest; reveal a quiet neutral fill on hover or active state.
- **Dictation:** The circular microphone sits beside Send. Its cool neutral rest state keeps sending primary; active recording alone turns cobalt and swaps the microphone for a stop icon. Permission and transcription work use the same control with a spinner, while status copy remains in the composer footer.

### Chips

- **Style:** Status labels pair a small semantic dot with compact text on a pale neutral or semantic wash.
- **State:** The task filter is a two-option segmented control; only the selected option becomes clean paper with a subtle shadow.

### Cards / Containers

- **Task Pulse:** Clean paper, a strong cool border, a 14px curve, and a one-pixel semantic state rail on the left. It contains status, title, a four-stage progress strip, execution count, and one detail affordance.
- **Run Record:** A lightly bordered, 11px-radius record on a translucent paper surface; status sits opposite the run label and metadata stays aligned in definition rows.
- **Task List Item:** Borderless at rest and full-width; a faint paper fill appears on hover instead of adding elevation.

### Inputs / Fields

- **Composer:** A paper surface with a 16px curve, cool border, ambient shadow, and a border/shadow increase on `:focus-within`. The text area itself remains borderless.
- **Token Field:** A 44px minimum-height white field with a 9px curve and a clear focus outline.
- **Error / Disabled:** Errors appear in the dedicated red recovery system; disabled composition is visibly unavailable, never merely lower-opacity text.

### Navigation

The desktop identity rail is deep cobalt and intentionally narrow. Navigation buttons are 42px squares with 11px corners; active and hover states use a translucent white fill. On mobile, navigation collapses to identity, refresh, and a labeled Task action in the header.

### Task Workbench

The workbench is the personal control center reached on demand. Its list, filters, task stages, run records, output, and timing sit on one cool panel plane. Desktop keeps it beside the conversation; mobile turns it into a full-screen dialog with focus containment, explicit close/back actions, and a 220ms right-to-left entrance. All meaningful motion collapses under reduced-motion preferences.

## Do's and Don'ts

### Do:

- **Do** keep the conversation and composer visually dominant on first view.
- **Do** express task progress as a compact pulse in the conversation before revealing runs and metadata.
- **Do** use cobalt selectively for active execution, actions, focus, and progress.
- **Do** preserve the same task information hierarchy across desktop and mobile.
- **Do** pair every semantic color with plain-language status copy.

### Don't:

- **Don't** make users enter a project, task manager, or runtime view before they can speak naturally.
- **Don't** turn the default view into a dense dashboard of counts, logs, or system controls.
- **Don't** use glow, glass, decorative gradients, or saturated color fields.
- **Don't** expose sessions, workers, or model selection in the conversation-first layer.
- **Don't** add shadows to resting surfaces when a cool tonal layer or fine rule can define structure.
