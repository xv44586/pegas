import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { _electron as electron } from 'playwright'

const repositoryRoot = resolve(import.meta.dirname, '..')
const executablePath = process.env.PEGAS_DESKTOP_EXECUTABLE
const dataDirectory = mkdtempSync(resolve(tmpdir(), 'pegas-desktop-smoke-'))
const outputDirectory = resolve(repositoryRoot, 'output/feature-review/media')
mkdirSync(outputDirectory, { recursive: true })

let application
const serviceGroupPids = []
try {
  application = await electron.launch({
    ...(executablePath ? { executablePath } : { args: [repositoryRoot] }),
    env: {
      ...process.env,
      PEGAS_DESKTOP_TEST: '1',
      PEGAS_DESKTOP_DATA_DIR: dataDirectory,
    },
    timeout: 30_000,
  })
  const window = await application.firstWindow({ timeout: 20_000 })
  const consoleErrors = []
  window.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  try {
    await window.waitForLoadState('domcontentloaded')
    const skipSetup = window.getByRole('button', { name: '稍后设置' })
    if (await skipSetup.isVisible()) await skipSetup.click()
    await window.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  } catch (error) {
    await window.screenshot({
      path: resolve(outputDirectory, 'desktop-electron-startup-failure.png'),
    })
    console.error(
      `Desktop window content:\n${await window.locator('body').innerText()}`,
    )
    throw error
  }
  const smokeMessage = `Desktop worker smoke ${Date.now()}`
  await window
    .getByRole('textbox', { name: '给 Pegas 发消息' })
    .fill(smokeMessage)
  await window.getByRole('button', { name: '发送', exact: true }).click()
  try {
    await waitForCompletedRun(window, smokeMessage)
  } catch (error) {
    const diagnostics = await window.evaluate(async () => {
      const runs = await fetch('/v1/runs?userId=owner').then(r => r.json())
      const events = await fetch('/v1/events?userId=owner').then(r => r.json())
      return { runs: runs.runs?.slice(-3), events: events.events?.slice(-3) }
    })
    console.error('SMOKE DIAGNOSTICS', JSON.stringify(diagnostics, null, 2))
    throw error
  }
  assert.equal(await window.title(), '对话 · Pegas')
  const security = await application.evaluate(({ BrowserWindow }) => {
    const active = BrowserWindow.getAllWindows()[0]
    return active?.webContents.getLastWebPreferences()
  })
  assert.equal(security?.nodeIntegration, false)
  assert.equal(security?.contextIsolation, true)
  assert.equal(security?.sandbox, true)
  await window.screenshot({
    path: resolve(outputDirectory, 'desktop-electron-macos.png'),
  })
  assert.deepEqual(consoleErrors, [])
  await waitForUnreadBadge(application)
  const unreadBefore = await outboxUnreadCount(window)
  assert.ok(
    unreadBefore > 0,
    'completed Run should leave an unread Outbox fact',
  )
  await markFirstUnreadRead(window)
  await waitForBadgeBelow(application, unreadBefore)
  // DESKTOP-001: the shell spawns exactly one Supervisor; business processes
  // are its children. Killing the Supervisor must fail the window honestly.
  const supervisorPid = desktopServicePid(
    application.process().pid,
    'supervisor/main.js',
  )
  serviceGroupPids.push(supervisorPid)
  await verifySupervisorOwnership(window, supervisorPid, dataDirectory)
  await verifyResidentWindowClose(application, window, supervisorPid)
  const restored = await application.firstWindow({ timeout: 15_000 })
  await restored.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  process.kill(supervisorPid, 'SIGTERM')
  let failurePageShown = false
  try {
    // The shell shows its honest failure page; the sealed UI additionally
    // degrades to its offline state. Either is acceptable evidence that the
    // window stopped pretending to be online.
    await Promise.race([
      restored
        .getByRole('heading', { name: 'Pegas 服务已停止' })
        .waitFor()
        .then(() => {
          failurePageShown = true
        }),
      restored.getByText('离线', { exact: true }).waitFor(),
    ])
  } catch (error) {
    console.error(
      'FAILURE PAGE BODY',
      await restored.locator('body').innerText(),
    )
    const alive = await fetch(
      `http://127.0.0.1:${await apiPortFromWindow(restored)}/readyz`,
    )
      .then(r => r.status)
      .catch(() => 'down')
    console.error('CONTROL PLANE AFTER SUPERVISOR DEATH', alive)
    throw error
  }
  await restored.screenshot({
    path: resolve(outputDirectory, 'desktop-electron-service-failure.png'),
  })
  if (failurePageShown) {
    await assert.rejects(
      restored.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor({
        state: 'visible',
        timeout: 250,
      }),
    )
  } else {
    // Offline sealed UI: the composer must not accept new submissions.
    const sendEnabled = await restored
      .getByRole('button', { name: '发送', exact: true })
      .isEnabled()
      .catch(() => false)
    assert.equal(sendEnabled, false, 'offline UI must not accept new input')
  }
  await waitForProcessGroupsGone(serviceGroupPids)
  console.log(
    executablePath
      ? 'Packaged Electron macOS smoke passed'
      : 'Electron macOS smoke passed',
  )
} finally {
  await application?.close()
  for (const pid of serviceGroupPids)
    assert.equal(
      processGroupExists(pid),
      false,
      `Desktop service process group ${pid} survived application close`,
    )
  rmSync(dataDirectory, { recursive: true, force: true })
}

function desktopServicePid(mainPid, entry) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  })
  for (const row of rows.split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, parentPid, command] = match
    if (Number(parentPid) === mainPid && command.includes(entry))
      return Number(pid)
  }
  throw new Error(`Unable to find desktop service ${entry}`)
}

function processGroupExists(leaderPid) {
  try {
    process.kill(-leaderPid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function processExists(pid) {
  // kill(pid, 0) also succeeds for unreaped zombies; ps state is the truth.
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
      encoding: 'utf8',
    }).trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

async function waitForCompletedRun(window, expectedOutput) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const completed = await window.evaluate(async output => {
      const response = await fetch('/v1/runs?userId=owner')
      if (!response.ok) return false
      const body = await response.json()
      return body.runs?.some(
        run => run.status === 'completed' && run.output === output,
      )
    }, expectedOutput)
    if (completed) return
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('Desktop Worker did not complete the submitted Run')
}

async function outboxUnreadCount(window) {
  return window.evaluate(async () => {
    const response = await fetch('/v1/outbox?userId=owner')
    if (!response.ok) return -1
    const body = await response.json()
    return (body.messages ?? []).filter(
      message => !message.readAt && message.status !== 'merged',
    ).length
  })
}

async function markFirstUnreadRead(window) {
  const marked = await window.evaluate(async () => {
    const response = await fetch('/v1/outbox?userId=owner')
    if (!response.ok) return false
    const body = await response.json()
    const unread = (body.messages ?? []).find(
      message => !message.readAt && message.status !== 'merged',
    )
    if (!unread) return false
    const readResponse = await fetch(
      `/v1/outbox/${encodeURIComponent(unread.id)}/read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'owner' }),
      },
    )
    return readResponse.ok
  })
  assert.equal(marked, true, 'marking an Outbox fact read should succeed')
}

async function waitForUnreadBadge(application) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const badge = await application.evaluate(({ app }) =>
      process.platform === 'darwin' ? app.dock?.getBadge() : undefined,
    )
    if (badge && Number(badge) > 0) return Number(badge)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('Dock badge did not reflect the unread Outbox fact')
}

async function waitForBadgeBelow(application, previous) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const badge = await application.evaluate(({ app }) =>
      process.platform === 'darwin' ? app.dock?.getBadge() : undefined,
    )
    const value = badge ? Number(badge) : 0
    if (value < previous) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('Dock badge did not shrink after the fact was read')
}

async function verifySupervisorOwnership(window, supervisorPid, dataDirectory) {
  const { readFileSync } = await import('node:fs')
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  })
  for (const entry of [
    'control-plane/main.js',
    'worker/main.js',
    'scheduler/main.js',
  ]) {
    const owned = rows.split('\n').some(row => {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return (
        match && Number(match[2]) === supervisorPid && match[3].includes(entry)
      )
    })
    assert.equal(owned, true, `${entry} must be owned by the supervisor`)
  }
  const lockPid = Number(
    readFileSync(resolve(dataDirectory, 'supervisor.lock'), 'utf8').trim(),
  )
  assert.equal(lockPid, supervisorPid, 'instance lock must name the supervisor')
  const residency = await window.evaluate(async () => {
    const response = await fetch('/v1/desktop/residency')
    return response.ok ? response.json() : undefined
  })
  assert.equal(residency?.managed, true, 'residency proxy must be wired')
  assert.equal(residency?.resident, false, 'default must be non-resident')
}

async function waitForProcessGroupsGone(pids) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (pids.every(pid => !processExists(pid) && !processGroupExists(pid)))
      return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  for (const pid of pids.filter(candidate => processGroupExists(candidate))) {
    console.error(
      'GROUP DETAIL',
      pid,
      execFileSync('ps', ['-Ao', 'pid=,ppid=,pgid=,state=,command='], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(row => {
          const match = row.trim().match(/^\d+\s+\d+\s+(\d+)/)
          return match && Number(match[1]) === pid
        })
        .map(row => row.slice(0, 160))
        .join('\n'),
    )
  }
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
  })
  console.error(
    'SURVIVING GROUPS',
    pids.filter(pid => processGroupExists(pid)),
    rows
      .split('\n')
      .filter(row => row.includes('dist/'))
      .join('\n'),
  )
  throw new Error('Supervisor did not stop its business process groups')
}

async function apiPortFromWindow(window) {
  return new URL(window.url()).port
}

async function verifyResidentWindowClose(application, window, supervisorPid) {
  // Resident mode: closing the window keeps the service alive; a fresh
  // window reconnects to the same instance. Toggle back off afterwards.
  const enabled = await window.evaluate(async () => {
    const response = await fetch('/v1/desktop/residency', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: true }),
    })
    return response.ok ? response.json() : undefined
  })
  assert.equal(enabled?.resident, true, 'residency switch must succeed')
  const port = await apiPortFromWindow(window)
  // Read the desktop-generated instance bearer from the Supervisor's own
  // process environment (smoke-only; never exposed to the renderer).
  const supervisorEnv = execFileSync(
    'ps',
    ['eww', '-p', String(supervisorPid), '-o', 'command='],
    { encoding: 'utf8' },
  )
  const apiToken = /PEGAS_API_TOKEN=(\S+)/.exec(supervisorEnv)?.[1]
  assert.ok(apiToken, 'supervisor must carry the instance bearer')
  await window.evaluate(() => window.close())
  await new Promise(resolveWait => setTimeout(resolveWait, 1500))
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`)
    .then(response => response.ok)
    .catch(() => false)
  assert.equal(ready, true, 'resident services must survive window close')
  const disabled = await fetch(
    `http://127.0.0.1:${port}/v1/desktop/residency`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ resident: false }),
    },
  ).then(response => (response.ok ? response.json() : undefined))
  assert.equal(disabled?.resident, false, 'residency must toggle back off')
  // Re-open the window the way a user clicks the Dock icon.
  await application.evaluate(({ app }) => app.emit('activate'))
}
