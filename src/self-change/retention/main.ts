import { basename, dirname, resolve } from 'node:path'
import {
  defaultInstances,
  pruneReleaseHistory,
  recordRetentionResult,
} from '../release-retention.js'

const [releasePath, statePath, dataDirectory] = process.argv.slice(2)
if (!releasePath || !statePath || !dataDirectory)
  throw new Error(
    'release root, Supervisor state and data directory are required',
  )
const candidateRoot = dirname(resolve(releasePath))
if (basename(candidateRoot) === 'candidates') {
  const root = dirname(candidateRoot)
  const result = await pruneReleaseHistory({
    releaseRoot: root,
    instances: defaultInstances(root, {
      statePath: resolve(statePath),
      dataDirectory: resolve(dataDirectory),
    }),
  })
  await recordRetentionResult(root, result)
  console.log(JSON.stringify({ event: 'release.retention', ...result }))
}
