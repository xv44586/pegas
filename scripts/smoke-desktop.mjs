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
  await waitForCompletedRun(window, smokeMessage)
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
  const workerPid = desktopServicePid(
    application.process().pid,
    'worker/main.js',
  )
  const controlPlanePid = desktopServicePid(
    application.process().pid,
    'control-plane/main.js',
  )
  serviceGroupPids.push(workerPid, controlPlanePid)
  process.kill(workerPid, 'SIGTERM')
  await window.getByRole('heading', { name: 'Pegas 服务已停止' }).waitFor()
  await window.screenshot({
    path: resolve(outputDirectory, 'desktop-electron-service-failure.png'),
  })
  await assert.rejects(
    window.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor({
      state: 'visible',
      timeout: 250,
    }),
  )
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

async function waitForCompletedRun(window, expectedOutput) {
  const deadline = Date.now() + 10_000
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
