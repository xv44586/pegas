import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dshNodeRuntime } from '../src/executor/dsh-node-runtime.js'

const directories: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pegas-node-runtime-'))
  directories.push(root)
  return join(root, 'node')
}
afterEach(() => {
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('standalone DSH Node runtime', () => {
  it('uses a compatible standalone development host when no bundle exists', () => {
    expect(
      dshNodeRuntime({
        bundledPath: fixture(),
        execPath: '/standalone/node',
        versions: { node: '24.9.0' },
      }),
    ).toBe('/standalone/node')
  })

  it.each([
    { node: '22.22.1', electron: '39.8.10' },
    { node: '24.22.1', electron: '44.0.0' },
    { node: '24.8.0' },
    { node: '22.22.1' },
    { node: 'invalid' },
  ])('fails closed for unsupported host %j without a bundle', versions => {
    expect(() => dshNodeRuntime({ bundledPath: fixture(), versions })).toThrow(
      '独立 Node.js >=24.9.0',
    )
  })

  it('probes and selects the bundled standalone executable even from Electron', () => {
    expect(
      dshNodeRuntime({
        bundledPath: process.execPath,
        versions: { node: '22.22.1', electron: '39.8.10' },
      }),
    ).toBe(process.execPath)
  })

  it.each([
    'not-json',
    '{"node":"24.8.0"}',
    '{"node":"24.22.1","electron":"44.0.0"}',
    'null',
  ])(
    'rejects a broken or incompatible bundle without host fallback: %s',
    output => {
      const bundledPath = fixture()
      writeFileSync(bundledPath, `#!/bin/sh\nprintf '%s' '${output}'\n`, {
        mode: 0o700,
      })
      expect(() => dshNodeRuntime({ bundledPath })).toThrow(
        '独立 Node.js >=24.9.0',
      )
    },
  )

  it('rejects an executable failure even when stdout claims compatibility', () => {
    const bundledPath = fixture()
    writeFileSync(
      bundledPath,
      '#!/bin/sh\necho \'{"node":"24.22.1"}\'\nexit 1\n',
      { mode: 0o700 },
    )
    expect(() => dshNodeRuntime({ bundledPath })).toThrow(
      '独立 Node.js >=24.9.0',
    )
  })
})
