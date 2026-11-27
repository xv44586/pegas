---
name: visual-diff
description: Explain a code change as a source-backed animated SVG comparing before and after flows. Use for Git change reports with meaningful behavior or design changes.
---

# Git change flow reports

Read the authoring contract before composing data. In a Pegas checkout its authority is `src/visual-diff/contract.ts`; the portable export includes the same contract at `references/authoring.md`.

Inspect the actual diff and relevant code on both sides. Choose the real task baseline and result commits, identify the changed behavior and necessary neighboring steps, then author the bounded JSON schema from the contract. Source citations must refer to the corresponding fixed commit. Keep unchanged steps aligned; label additions, removals and modifications. Fold only verified nonbehavioral changes and record why. A flow diagram is an explanation, not execution or test evidence.

In Pegas, append the contracted data block to the final report only when enabled by the Executor instructions. Pegas validates, renders and stores the SVG. The Router does not author it.

For standalone use, write the JSON to a file and run the portable bundle:

```sh
node scripts/cli.js change.json change.svg /absolute/path/to/repository
```

Node 24+ and Git are required; no npm install, browser or external plugin is needed. In the source checkout, build/export with `pnpm package:visual-diff`, then use `output/visual-diff/scripts/cli.js`. The command refuses to overwrite an existing SVG. It validates commit hashes, source lines, changed hunks and schema before emitting escaped SVG with finite native animation.

Keep the original prose and validation evidence in the report. If there is no material behavior change, no committed comparison, or insufficient access, explain why no diagram was attached. Do not create commits just to satisfy the renderer, silently omit uncommitted work, broaden permissions, publish artifacts or install this skill globally without task authorization.
