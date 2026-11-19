import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'

import { chromium } from 'playwright'

const repositoryRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const changedFrom = option('--changed-from')
const force = args.includes('--force')
if (!force && !changedFrom)
  throw new Error('--changed-from is required unless --force is used')
if (
  !force &&
  !changedFiles(changedFrom).some(path => path.startsWith('web/'))
) {
  console.log('UI review skipped: no web files changed')
  process.exit(0)
}

const outputDirectory = resolve(
  repositoryRoot,
  option('--output') ?? 'output/feature-review/media',
)
const outputRelative = relative(repositoryRoot, outputDirectory)
if (
  outputRelative === '' ||
  outputRelative.startsWith('..') ||
  !outputRelative.split(sep).join('/').startsWith('output/feature-review/')
) {
  throw new Error('UI review output must stay under output/feature-review/')
}
rmSync(outputDirectory, { recursive: true, force: true })
mkdirSync(outputDirectory, { recursive: true })

const dataDirectory = mkdtempSync(joinPath(tmpdir(), 'pegas-ui-review-'))
const port = await availablePort()
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_EXECUTOR: 'echo',
  PEGAS_ROUTER: 'rules',
  PEGAS_MODEL_NAME: 'magpie/auto',
  PEGAS_SPEECH_PROVIDER: 'disabled',
  PEGAS_PUSH_MODE: 'disabled',
}
const children = [
  spawn(
    process.execPath,
    [resolve(repositoryRoot, 'dist/control-plane/main.js')],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    },
  ),
  spawn(process.execPath, [resolve(repositoryRoot, 'dist/worker/main.js')], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  }),
]
let browser
try {
  await waitUntilReady(port)
  await seedConversation(port)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(`http://127.0.0.1:${String(port)}/`)
  await page.getByRole('textbox', { name: '告诉 Pegas 你想完成什么' }).waitFor()
  await assertGeometry(page, 'desktop-home')
  await shot(page, 'desktop-home.png')

  await page.getByRole('button', { name: '打开工作区' }).click()
  await page.getByRole('button', { name: '关闭工作区' }).waitFor()
  await waitForPanelInViewport(page)
  await assertGeometry(page, 'workspace-open')
  await shot(page, 'workspace-open.png')
  await page.getByRole('button', { name: '关闭工作区' }).click()

  await page
    .getByRole('button', { name: /^打开 Channel：/u })
    .first()
    .click()
  await page.getByRole('heading', { name: '模型用量' }).waitFor()
  await waitForPanelInViewport(page)
  await assertGeometry(page, 'workspace-usage')
  await shot(page, 'workspace-usage.png')
  await page.getByRole('button', { name: '关闭工作区' }).click()

  await page.getByRole('button', { name: /Outbox/u }).click()
  await page.getByRole('heading', { name: '需要你关注的消息' }).waitFor()
  await assertGeometry(page, 'outbox')
  await shot(page, 'outbox.png')
  await page.getByRole('button', { name: /Channels/u }).click()

  await page.getByRole('button', { name: '收起侧栏' }).click()
  await page.getByRole('button', { name: '展开侧栏' }).waitFor()
  await assertGeometry(page, 'sidebar-collapsed')
  await shot(page, 'sidebar-collapsed.png')
  await page.getByRole('button', { name: '展开侧栏' }).click()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '关闭设置' }).waitFor()
  await assertGeometry(page, 'settings')
  await shot(page, 'settings.png')
  await page.getByRole('button', { name: '关闭设置' }).click()

  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('button', { name: '关闭插件' }).waitFor()
  await assertGeometry(page, 'plugins')
  await shot(page, 'plugins.png')
  await page
    .getByRole('button', { name: /查看插件：/u })
    .first()
    .click()
  await page.getByRole('button', { name: '关闭插件详情' }).waitFor()
  await assertGeometry(page, 'plugin-detail')
  await shot(page, 'plugin-detail.png')
  await context.close()

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(`http://127.0.0.1:${String(port)}/`)
  await mobilePage
    .getByRole('textbox', { name: '告诉 Pegas 你想完成什么' })
    .waitFor()
  await assertGeometry(mobilePage, 'mobile-home')
  await shot(mobilePage, 'mobile-home.png')
  await mobilePage.goto(`http://127.0.0.1:${String(port)}/?view=outbox`)
  await mobilePage.getByRole('heading', { name: '需要你关注的消息' }).waitFor()
  await assertGeometry(mobilePage, 'mobile-outbox')
  await shot(mobilePage, 'mobile-outbox.png')
  await mobilePage.goto(`http://127.0.0.1:${String(port)}/`)
  await mobilePage.getByRole('button', { name: '展开侧栏' }).click()
  await mobilePage.getByRole('button', { name: '收起侧栏' }).waitFor()
  await assertGeometry(mobilePage, 'mobile-sidebar-open')
  await shot(mobilePage, 'mobile-sidebar-open.png')
  await mobilePage
    .getByRole('button', { name: /^打开 Channel：/u })
    .first()
    .click()
  await mobilePage.getByRole('heading', { name: '模型用量' }).waitFor()
  await waitForPanelInViewport(mobilePage)
  await assertGeometry(mobilePage, 'mobile-workspace-usage')
  await shot(mobilePage, 'mobile-workspace-usage.png')
  await mobile.close()
  console.log(`UI review captured in ${outputRelative}`)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  for (const child of children) child.kill('SIGTERM')
  await Promise.race([
    Promise.all(children.map(child => waitForExit(child))),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000)),
  ])
  rmSync(dataDirectory, { recursive: true, force: true })
}

async function seedConversation(apiPort) {
  for (const [index, text] of [
    '复核 Pegas 的首页与工作区布局',
    '确认设置和插件详情仍然可达',
  ].entries()) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          type: 'user.message',
          source: 'feature-review',
          dedupeKey: `feature-review-${String(index)}`,
          payload: { text },
        }),
      },
    )
    if (response.status !== 202)
      throw new Error(`Unable to seed UI review (${String(response.status)})`)
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/tasks?userId=owner`,
    )
    const body = await response.json()
    if (body.tasks?.length >= 2) return
    await wait(50)
  }
  throw new Error('UI review tasks were not created')
}

async function assertGeometry(page, label) {
  const failures = await page.evaluate(() => {
    const out = []
    const root = globalThis.document.documentElement
    if (root.scrollWidth > root.clientWidth + 1)
      out.push(`page overflows ${root.scrollWidth}>${root.clientWidth}`)
    const composer = globalThis.document.querySelector('.composer-wrap')
    if (composer) {
      const rect = composer.getBoundingClientRect()
      if (rect.left < -1 || rect.right > globalThis.innerWidth + 1)
        out.push(`composer crosses viewport ${rect.left}..${rect.right}`)
      if (rect.bottom > globalThis.innerHeight + 1 || rect.top < -1)
        out.push(`composer is not visible ${rect.top}..${rect.bottom}`)
    }
    for (const element of globalThis.document.querySelectorAll(
      '.identity-rail, .workspace-panel, .settings-layer, .plugin-dialog, .plugin-detail',
    )) {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (rect.left < -1 || rect.right > globalThis.innerWidth + 1)
        out.push(
          `${element.className} crosses viewport ${String(Math.round(rect.left))}..${String(Math.round(rect.right))} of ${String(globalThis.innerWidth)}`,
        )
    }
    for (const element of globalThis.document.querySelectorAll(
      '.detail-title, .usage-summary, .usage-source-note, .section-heading-row',
    )) {
      if (element.scrollWidth > element.clientWidth + 1)
        out.push(
          `${element.className} has clipped horizontal content ${String(element.scrollWidth)}>${String(element.clientWidth)} rect=${String(Math.round(element.getBoundingClientRect().width))} display=${globalThis.getComputedStyle(element).display}`,
        )
    }
    return out
  })
  if (label === 'sidebar-collapsed' || label === 'mobile-home') {
    const visibleRailButtons = page.locator('.identity-rail button:visible')
    const count = await visibleRailButtons.count()
    if (count !== 1)
      failures.push(`collapsed sidebar exposes ${String(count)} buttons`)
    else if (
      (await visibleRailButtons.first().getAttribute('aria-label')) !==
      '展开侧栏'
    )
      failures.push('collapsed sidebar button does not expand the sidebar')
  }
  if (failures.length) throw new Error(`${label}: ${failures.join('; ')}`)
}

async function waitForPanelInViewport(page) {
  await page.waitForFunction(() => {
    const panel = globalThis.document.querySelector('.workspace-panel')
    if (!panel) return false
    const rect = panel.getBoundingClientRect()
    const minimumExpectedWidth = Math.min(320, globalThis.innerWidth - 56)
    return (
      rect.width >= minimumExpectedWidth &&
      rect.left >= -1 &&
      rect.right <= globalThis.innerWidth + 1
    )
  })
}

async function shot(page, name) {
  await page.screenshot({
    path: resolve(outputDirectory, name),
    fullPage: true,
    animations: 'disabled',
  })
}

function changedFiles(base) {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRT', `${base}...HEAD`],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .map(path => path.trim())
    .filter(Boolean)
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return reject(new Error('No TCP address'))
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitUntilReady(apiPort) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(apiPort)}/readyz`)
      if (response.ok) return
    } catch {
      // The process is still starting.
    }
    await wait(50)
  }
  throw new Error('Control plane did not become ready for UI review')
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}

function joinPath(...parts) {
  return resolve(...parts)
}
