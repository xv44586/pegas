import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { dshLaunch } from '../src/executor/dsh-launch.js'

const directories: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'pegas-dsh-launch-'))
  directories.push(home)
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const command = join(bin, 'dsh')
  writeFileSync(
    command,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n',
    { mode: 0o700 },
  )
  return { home, bin, command }
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('DSH launch resolution', () => {
  it('runs user-installed Node CLI arguments without a node executable on PATH', async () => {
    const { home, command } = fixture()
    const environment = { HOME: home, PATH: '/usr/bin:/bin' }
    const args = ['--profile', 'headless', '--json', '-']
    const launch = dshLaunch('dsh', args, environment)
    expect(launch).toEqual({
      command: process.execPath,
      args: [command, ...args],
    })
    const result = await promisify(execFile)(launch.command, launch.args, {
      env: environment,
    })
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('prefers the executable on PATH over fallback installation locations', () => {
    const fallback = fixture()
    const selected = fixture()
    expect(
      dshLaunch('dsh', ['--dump-config'], {
        HOME: fallback.home,
        PATH: selected.bin,
      }).args[0],
    ).toBe(selected.command)
  })

  it('honors an explicit absolute Node CLI and preserves shell wrappers', () => {
    const { command } = fixture()
    expect(dshLaunch(command, ['--dump-config']).args[0]).toBe(command)
    writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(dshLaunch(command, ['--dump-config'])).toEqual({
      command,
      args: ['--dump-config'],
    })
  })

  it('leaves relative wrappers relative to the executor working directory', () => {
    expect(dshLaunch('./tools/dsh', ['--json'])).toEqual({
      command: './tools/dsh',
      args: ['--json'],
    })
  })

  it('does not replace a missing explicitly configured command with default DSH', () => {
    const { home } = fixture()
    expect(
      dshLaunch('missing-custom-dsh', [], {
        HOME: home,
        PATH: '/no-such-path',
      }),
    ).toEqual({ command: 'missing-custom-dsh', args: [] })
  })
})
