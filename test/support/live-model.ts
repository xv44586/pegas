import { spawnSync } from 'node:child_process'
import { defaultMagpieRouterModel } from '../../src/core/model-defaults.js'

// Live gates exercise the same default route as the product. Explicit
// overrides remain authoritative, including failures: never skip or fall back.
export function liveModelName(): string {
  const configured = process.env.PEGAS_LIVE_MODEL?.trim() ?? ''
  return configured.length > 0 ? configured : defaultMagpieRouterModel
}

// Refuse before even probing the gateway or launching DSH. A reachable
// developer gateway is not authorization to consume tokens.
export async function requireLiveModelRuntime({
  requireDsh = false,
  environment = process.env,
  fetcher = globalThis.fetch,
  checkDsh = () =>
    spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 30_000 })
      .status === 0,
}: {
  requireDsh?: boolean
  environment?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  checkDsh?: () => boolean
} = {}): Promise<void> {
  if (environment.PEGAS_LIVE_TESTS !== '1') {
    throw new Error('Paid model tests require explicit opt-in: pnpm test:live')
  }
  if (requireDsh && !checkDsh()) {
    throw new Error(
      'Live model tests require dsh on PATH; no tests were skipped',
    )
  }
  const response = await fetcher('http://127.0.0.1:3425/v1/models', {
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) {
    throw new Error(
      `Live model gateway unavailable (${String(response.status)}); no tests were skipped`,
    )
  }
}
