import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Resolve the same installed CLI for catalog reads and execution, including
 * Finder's minimal PATH. Never source shell startup files or a personal profile. */
export function dshLaunch(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (
    process.platform === 'win32' ||
    (command.includes('/') && !isAbsolute(command))
  )
    return { command, args }
  const candidates = command.includes('/')
    ? [command]
    : [
        ...(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map(directory => join(directory, command)),
        ...(command === 'dsh'
          ? [
              join(environment.HOME ?? homedir(), '.local', 'bin', 'dsh'),
              '/opt/homebrew/bin/dsh',
              '/usr/local/bin/dsh',
            ]
          : []),
      ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    // Node CLIs use the already-running Node/Electron runtime, so an env-node
    // shebang does not introduce another dependency on Finder's PATH.
    let descriptor: number | undefined
    try {
      descriptor = openSync(candidate, 'r')
      const header = Buffer.alloc(256)
      const length = readSync(descriptor, header, 0, header.length, 0)
      const shebang = header
        .subarray(0, length)
        .toString('utf8')
        .split('\n')[0]
        ?.trim()
      if (shebang === '#!/usr/bin/env node') {
        return { command: process.execPath, args: [candidate, ...args] }
      }
    } catch {
      // Preserve the operating system's normal launch error for unreadable files.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    return { command: candidate, args }
  }
  return { command, args }
}
