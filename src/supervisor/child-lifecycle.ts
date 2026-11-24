import type { ChildProcess } from 'node:child_process'

export function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export function onceChildExited(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', () => resolveExit()))
}

export function signalChildGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: { killGroup?: (pgid: number, signal: NodeJS.Signals) => void } = {},
): void {
  // Business processes lead their own groups so descendant executors die
  // with them; a supervisor kill must never orphan a DSH session.
  if (process.platform !== 'win32' && child.pid) {
    const killGroup =
      options.killGroup ??
      ((pgid: number, groupSignal: NodeJS.Signals) =>
        process.kill(pgid, groupSignal))
    try {
      killGroup(-child.pid, signal)
      return
    } catch (error) {
      const code =
        error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined
      // ESRCH: the group is already gone. EPERM: the leader exited and its
      // pgid was recycled by a foreign group we must never signal. Both
      // mean group signaling is unavailable; fall back to the child handle.
      if (code !== 'ESRCH' && code !== 'EPERM') throw error
    }
  }
  child.kill(signal)
}

export async function stopChildProcesses(
  children: ChildProcess[],
  options: {
    graceMs?: number
    signal?: (child: ChildProcess, signal: NodeJS.Signals) => void
  } = {},
): Promise<void> {
  const graceMs = options.graceMs ?? 5000
  const signal = options.signal ?? signalChildGroup
  const running = children.filter(child => !childHasExited(child))
  for (const child of running) signal(child, 'SIGTERM')
  await Promise.race([
    Promise.all(running.map(child => onceChildExited(child))),
    new Promise(resolveWait => setTimeout(resolveWait, graceMs)),
  ])
  const stubborn = running.filter(child => !childHasExited(child))
  for (const child of stubborn) signal(child, 'SIGKILL')
  await Promise.all(stubborn.map(child => onceChildExited(child)))
}
