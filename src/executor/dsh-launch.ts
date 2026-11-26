import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { dshNodeRuntime } from './dsh-node-runtime.js'

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
    // Read the shebang separately: runtime validation errors must propagate,
    // never silently fall back to the original env-node launch.
    let descriptor: number | undefined
    let nodeScript = false
    try {
      descriptor = openSync(candidate, 'r')
      const header = Buffer.alloc(256)
      const length = readSync(descriptor, header, 0, header.length, 0)
      const shebang = header
        .subarray(0, length)
        .toString('utf8')
        .split('\n')[0]
        ?.trim()
      nodeScript = shebang === '#!/usr/bin/env node'
    } catch {
      // Preserve the operating system's normal launch error for unreadable files.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    if (nodeScript)
      return { command: dshNodeRuntime(), args: [candidate, ...args] }
    return { command: candidate, args }
  }
  return { command, args }
}
