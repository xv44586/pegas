import { createOfflineFetch } from './offline-fetch.js'

// Assign directly so vi.unstubAllGlobals()/restoreAllMocks() restore this
// guarded baseline, while individual tests can still inject fake responses.
globalThis.fetch = createOfflineFetch(globalThis.fetch)
