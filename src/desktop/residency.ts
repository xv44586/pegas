import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ResidencyPreference {
  resident: boolean
}

interface ResidencyState extends ResidencyPreference {
  loginItemRegistered: boolean
}

export interface LoginItemSettings {
  openAtLogin: boolean
  openAsHidden: boolean
}

export interface ResidencyController {
  state: () => ResidencyState
  setResident: (resident: boolean) => ResidencyState
}

/**
 * Residency is a machine-local desktop preference: how processes live on
 * this Mac. It never enters server runtime_settings and never syncs across
 * devices. Default is non-resident — quitting the app stops the services.
 */
export function readResidencyPreference(
  directory: string,
): ResidencyPreference {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(directory, 'desktop.json'), 'utf8'),
    )
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { resident?: unknown }).resident === 'boolean'
    )
      return { resident: (parsed as { resident: boolean }).resident }
  } catch {
    // Missing or corrupt preference falls back to the honest default.
  }
  return { resident: false }
}

export function writeResidencyPreference(
  directory: string,
  resident: boolean,
): void {
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'desktop.json')
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ resident }, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporary, target)
}

export function createResidencyController(options: {
  preferenceDirectory: string
  applyLoginItem: (settings: LoginItemSettings) => void
  readLoginItem: () => { openAtLogin: boolean }
}): ResidencyController {
  let preference = readResidencyPreference(options.preferenceDirectory)

  function state(): ResidencyState {
    return {
      resident: preference.resident,
      loginItemRegistered: options.readLoginItem().openAtLogin,
    }
  }

  return {
    state,
    setResident: (resident: boolean) => {
      const current = state()
      if (
        current.resident === resident &&
        current.loginItemRegistered === resident
      )
        return current
      // Apply the OS registration first; only a successful switch persists
      // the preference. A failed registration keeps the previous state.
      options.applyLoginItem({
        openAtLogin: resident,
        openAsHidden: resident,
      })
      writeResidencyPreference(options.preferenceDirectory, resident)
      preference = { resident }
      return state()
    },
  }
}
