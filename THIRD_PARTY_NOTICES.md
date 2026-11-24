# Third-party notices

## DS Bot interface utility icons

Parts of `web/src/DsBotIcons.tsx` reproduce or adapt SVG geometry from the DS Bot
client. The source is licensed under the Apache License, Version 2.0. The adapted
file contains a prominent modification notice. Pegas uses its own generated
product and Worker identities; only generic interface controls remain adapted
from DS Bot, and Pegas does not display the DS Bot name as its product name.

Source: [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot), reviewed from a
local research checkout retrieved 2026-11-18. License: Apache-2.0.

## Beautiful UI components

`web/src/bui/` reproduces and adapts the Beautiful UI component library
(22 primitives, 11 atoms, design tokens, foundation/reset/utilities CSS).
Adaptations for Pegas: original oklch token values kept as the visual
authority with AA-safe text/fill tones, the paid central-icons imports
replaced by a local lucide-react shim, iconoir icons mapped to lucide
equivalents, `@/` imports rewritten to `@bui/`, and strict-TypeScript
fixes. The overlay components in `web/src/bui/overlays/` are original
Pegas code that skins Radix UI primitives (MIT) and cmdk (MIT) with the
same tokens.

Source: [flornkm/beautifului](https://github.com/flornkm/beautifului),
local research checkout at commit `44a274e` retrieved 2026-11-23.
License: MIT, Copyright (c) 2026 Shane Levine.

Motion/chart dependencies used by the adapted primitives:
[glimm](https://www.npmjs.com/package/glimm) (MIT, Noman Ijaz) and
[liveline](https://www.npmjs.com/package/liveline) (MIT, Benji Taylor).
Interface icons: [lucide](https://lucide.dev) (ISC). Headless overlay
behavior: [Radix UI](https://www.radix-ui.com) (MIT) and
[cmdk](https://cmdk.paco.me) (MIT).
