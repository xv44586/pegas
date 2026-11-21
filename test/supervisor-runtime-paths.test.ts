import { isAbsolute, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveSupervisorRuntimePaths } from '../src/supervisor/runtime-paths.js'

describe('Supervisor runtime paths', () => {
  it('pins a relative data directory to the Supervisor cwd for every release', () => {
    const paths = resolveSupervisorRuntimePaths(
      './shared-data',
      '/srv/pegas-supervisor',
    )

    expect(paths).toEqual({
      dataDir: resolve('/srv/pegas-supervisor', 'shared-data'),
      databasePath: resolve(
        '/srv/pegas-supervisor',
        'shared-data',
        'pegas.sqlite',
      ),
    })
    expect(isAbsolute(paths.dataDir)).toBe(true)
    expect(resolve('/releases/candidate', paths.dataDir, 'pegas.sqlite')).toBe(
      paths.databasePath,
    )
  })

  it('preserves an absolute configured data directory', () => {
    expect(
      resolveSupervisorRuntimePaths('/var/lib/pegas', '/srv/supervisor'),
    ).toEqual({
      dataDir: '/var/lib/pegas',
      databasePath: '/var/lib/pegas/pegas.sqlite',
    })
  })
})
