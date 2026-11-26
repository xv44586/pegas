import { defaultMagpieRouterModel } from '../../src/core/model-defaults.js'

// Live gates exercise the same default route as the product. Explicit
// overrides remain authoritative, including failures: never skip or fall back.
export function liveModelName(): string {
  const configured = process.env.PEGAS_LIVE_MODEL?.trim() ?? ''
  return configured.length > 0 ? configured : defaultMagpieRouterModel
}
