import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createResidencyController,
  readResidencyPreference,
  writeResidencyPreference,
} from '../src/desktop/residency.js'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-residency-test-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('desktop residency preference', () => {
  it('defaults to non-resident when no preference exists', () => {
    expect(readResidencyPreference(temporaryDirectory())).toEqual({
      resident: false,
    })
  })

  it('round-trips the preference and treats corrupt files as default-off', () => {
    const directory = temporaryDirectory()
    writeResidencyPreference(directory, true)
    expect(readResidencyPreference(directory)).toEqual({ resident: true })
    expect(
      JSON.parse(readFileSync(join(directory, 'desktop.json'), 'utf8')),
    ).toMatchObject({ resident: true })
    writeResidencyPreference(directory, false)
    expect(readResidencyPreference(directory)).toEqual({ resident: false })
  })
})

describe('desktop residency controller', () => {
  function harness(options: { failEnable?: boolean } = {}) {
    const directory = temporaryDirectory()
    const calls: { openAtLogin: boolean; openAsHidden: boolean }[] = []
    const controller = createResidencyController({
      preferenceDirectory: directory,
      applyLoginItem: settings => {
        if (options.failEnable && settings.openAtLogin)
          throw new Error('login item registration failed')
        calls.push(settings)
      },
      readLoginItem: () => ({
        openAtLogin: calls.at(-1)?.openAtLogin ?? false,
      }),
    })
    return { directory, calls, controller }
  }

  it('enabling registers a hidden login item and persists the preference', () => {
    const { directory, calls, controller } = harness()
    const state = controller.setResident(true)
    expect(state).toEqual({ resident: true, loginItemRegistered: true })
    expect(calls).toEqual([{ openAtLogin: true, openAsHidden: true }])
    expect(readResidencyPreference(directory)).toEqual({ resident: true })
  })

  it('disabling unregisters the login item and returns to app lifecycle', () => {
    const { calls, controller } = harness()
    controller.setResident(true)
    const state = controller.setResident(false)
    expect(state).toEqual({ resident: false, loginItemRegistered: false })
    expect(calls.at(-1)).toEqual({
      openAtLogin: false,
      openAsHidden: false,
    })
  })

  it('failed registration keeps the previous state and reports honestly', () => {
    const { directory, controller } = harness({ failEnable: true })
    expect(() => controller.setResident(true)).toThrow(
      'login item registration failed',
    )
    expect(readResidencyPreference(directory)).toEqual({ resident: false })
    expect(controller.state()).toEqual({
      resident: false,
      loginItemRegistered: false,
    })
  })

  it('toggle round-trips keep login item and preference consistent', () => {
    const { controller } = harness()
    controller.setResident(true)
    controller.setResident(false)
    const state = controller.setResident(true)
    expect(state).toEqual({ resident: true, loginItemRegistered: true })
    expect(controller.state()).toEqual(state)
  })

  it('repeated identical toggles are idempotent', () => {
    const { calls, controller } = harness()
    controller.setResident(true)
    controller.setResident(true)
    expect(calls).toHaveLength(1)
  })
})
