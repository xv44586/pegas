import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { chromium } from 'playwright'

const repositoryRoot = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const axeSource = readFileSync(require.resolve('axe-core'), 'utf8')

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
    server.on('error', reject)
  })
}

const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds))

async function waitUntilReady(port) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`)
      if (response.ok) return
    } catch {
      // not ready yet
    }
    await wait(100)
  }
  throw new Error('Control plane did not become ready')
}

const dataDirectory = mkdtempSync(resolve(tmpdir(), 'pegas-a11y-'))
const dshFixture = resolve(dataDirectory, 'a11y-dsh')
writeFileSync(
  dshFixture,
  `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--dump-config')) {
  const patchIndex = process.argv.indexOf('--patch')
  const patchPath = patchIndex >= 0 ? process.argv[patchIndex + 1] : undefined
  const entries = patchPath
    ? JSON.parse(fs.readFileSync(patchPath, 'utf8'))
    : []
  process.stdout.write(JSON.stringify(entries))
  process.exit(0)
}
process.stdout.write('- id: m1\\n  config:\\n    provider: fixture\\n    model: test-model\\n')
`,
)
chmodSync(dshFixture, 0o755)
const port = await availablePort()
const modelGateway = createHttpServer((request, response) => {
  if (request.url?.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        data: Array.from({ length: 34 }, (_, index) => ({
          id:
            index === 0
              ? 'deepseek-v4.1-flash'
              : `fixture/model-${String(index + 1).padStart(2, '0')}`,
          display_name:
            index === 0
              ? 'DeepSeek V4.1 Flash'
              : `Fixture Model ${String(index + 1).padStart(2, '0')}`,
        })),
      }),
    )
    return
  }
  if (request.url?.endsWith('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    )
    return
  }
  response.writeHead(404).end()
})
await new Promise(resolveListen =>
  modelGateway.listen(0, '127.0.0.1', resolveListen),
)
const modelGatewayPort = modelGateway.address().port
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_DSH_COMMAND: dshFixture,
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_EXECUTOR: 'echo',
  PEGAS_MODEL_BASE_URL: `http://127.0.0.1:${String(modelGatewayPort)}/v1`,
  PEGAS_MODEL_NAME: 'deepseek-v4.1-flash',
  PEGAS_SPEECH_PROVIDER: 'disabled',
  PEGAS_PUSH_MODE: 'disabled',
}
const children = [
  spawn(
    process.execPath,
    [resolve(repositoryRoot, 'dist/control-plane/main.js')],
    { cwd: repositoryRoot, env: environment, stdio: 'ignore' },
  ),
  spawn(process.execPath, [resolve(repositoryRoot, 'dist/worker/main.js')], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'ignore',
  }),
]

const runOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
}

async function audit(page, label) {
  await page.evaluate(axeSource)
  const results = await page.evaluate(
    options => globalThis.axe.run(globalThis.document, options),
    runOptions,
  )
  const serious = results.violations.filter(violation =>
    ['serious', 'critical'].includes(violation.impact),
  )
  if (serious.length) {
    for (const violation of serious) {
      console.error(
        `a11y ${label}: ${violation.id} (${violation.impact}) ${violation.help}`,
      )
      for (const node of violation.nodes.slice(0, 6))
        console.error(`   ${node.html} :: ${node.failureSummary}`)
    }
    throw new Error(`a11y violations on ${label}`)
  }
  console.log(
    `a11y ${label}: ${results.violations.length} violations, ${results.passes.length} passes`,
  )
}

let browser
try {
  await waitUntilReady(port)
  await fetch(`http://127.0.0.1:${port}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      dedupeKey: 'a11y-seed',
      payload: { text: '为 Pegas 检查可访问性' },
    }),
  })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const body = await (
      await fetch(`http://127.0.0.1:${port}/v1/channels?userId=owner`)
    ).json()
    if (body.channels?.length >= 1) break
    await wait(100)
  }
  const channelsBody = await (
    await fetch(`http://127.0.0.1:${port}/v1/channels?userId=owner`)
  ).json()
  const firstChannel = channelsBody.channels?.[0]
  if (!firstChannel) throw new Error('Unable to seed a11y attention')
  for (const [index, payload] of [
    {
      type: 'run.completed',
      taskId: firstChannel.id,
      text: '这是测试相关事情的入口。我目前可以处理你在这条对话里提出的测试类需求。',
    },
    {
      type: 'approval.required',
      taskId: firstChannel.id,
      approvalId: 'a11y-approval',
      summary: '发布前需要确认影响范围',
    },
    {
      type: 'goal.clarification_required',
      taskId: firstChannel.id,
      questions: ['发布窗口是哪个时间段？'],
      text: '发布窗口是哪个时间段？',
    },
    {
      type: 'run.failed',
      taskId: firstChannel.id,
      error: '上游模型超时，请稍后重试。',
    },
  ].entries()) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/outbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        channel: 'conversation',
        dedupeKey: `a11y-attention-${String(index)}`,
        taskId: firstChannel.id,
        payload,
      }),
    })
    if (response.status !== 202)
      throw new Error('Unable to seed a11y attention')
  }

  browser = await chromium.launch({ headless: true })
  for (const theme of ['light', 'warm', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme === 'dark' ? 'dark' : 'light',
      reducedMotion: 'reduce',
    })
    await context.addInitScript(value => {
      localStorage.setItem('pegas-setup-complete', 'true')
      localStorage.setItem('pegas-theme', value)
    }, theme)
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
    await audit(page, `${theme}-conversation`)
    for (const [nav, heading] of [
      ['所有事情', '所有事情'],
      ['待你处理', '待你处理'],
      ['自动化', '自动化'],
      ['记忆', '记忆'],
    ]) {
      await page.getByLabel('主导航').getByRole('button', { name: nav }).click()
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      if (nav === '待你处理')
        await page
          .getByLabel('待处理列表')
          .getByRole('article')
          .first()
          .waitFor()
      await audit(page, `${theme}-${nav}`)
    }
    await page
      .getByLabel('主导航')
      .getByRole('button', { name: '设置' })
      .click()
    await page.getByRole('heading', { name: 'Pegas', exact: true }).waitFor()
    await audit(page, `${theme}-settings`)
    await context.close()
  }

  const onboarding = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  const onboardingPage = await onboarding.newPage()
  onboardingPage.setDefaultTimeout(12_000)
  await onboardingPage.goto(`http://127.0.0.1:${port}/?setup=1`)
  await onboardingPage
    .getByRole('heading', { name: '欢迎使用 Pegas', exact: true })
    .waitFor()
  await onboardingPage
    .getByRole('button', { name: '继续', exact: true })
    .click()
  await onboardingPage
    .getByRole('heading', { name: '连接模型服务', exact: true })
    .waitFor()
  await audit(onboardingPage, 'onboarding-models')
  await onboardingPage.getByRole('button', { name: /，默认模型$/ }).click()
  await onboardingPage.getByRole('dialog', { name: '选择模型' }).waitFor()
  await audit(onboardingPage, 'onboarding-model-picker')
  await onboarding.close()
  const unconfigured = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  const unconfiguredPage = await unconfigured.newPage()
  unconfiguredPage.setDefaultTimeout(12_000)
  await unconfiguredPage.route('**/v1/settings/agent-models', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        defaultProvider: 'magpie',
        defaultModel: '',
        models: [],
      }),
    }),
  )
  await unconfiguredPage.goto(`http://127.0.0.1:${port}/?setup=1`)
  await unconfiguredPage
    .getByRole('heading', { name: '欢迎使用 Pegas', exact: true })
    .waitFor()
  await unconfiguredPage
    .getByRole('button', { name: '继续', exact: true })
    .click()
  await unconfiguredPage
    .getByRole('heading', { name: '连接模型服务', exact: true })
    .waitFor()
  const connectionGroup = unconfiguredPage.getByRole('group', {
    name: '模型连接配置',
  })
  await connectionGroup.waitFor()
  await audit(unconfiguredPage, 'onboarding-connection-setup')
  await connectionGroup.getByLabel('API Key').fill('fixture-key')
  await connectionGroup.getByRole('button', { name: '测试连接' }).click()
  await connectionGroup.getByText(/连接正常 · \d+ ms/).waitFor()
  await audit(unconfiguredPage, 'onboarding-connection-tested')
  await unconfiguredPage.unroute('**/v1/settings/agent-models')
  await connectionGroup.getByRole('button', { name: '保存连接' }).click()
  await connectionGroup.waitFor({ state: 'detached' })
  await unconfiguredPage.getByRole('button', { name: /，默认模型$/ }).click()
  await unconfiguredPage.getByRole('dialog', { name: '选择模型' }).waitFor()
  await audit(unconfiguredPage, 'onboarding-connection-picker')
  await unconfigured.close()

  const forced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    forcedColors: 'active',
    reducedMotion: 'reduce',
  })
  await forced.addInitScript(() => {
    localStorage.setItem('pegas-setup-complete', 'true')
    localStorage.setItem('pegas-theme', 'light')
  })
  const forcedPage = await forced.newPage()
  await forcedPage.goto(`http://127.0.0.1:${port}/`)
  await forcedPage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  await forcedPage
    .getByLabel('主导航')
    .getByRole('button', { name: '所有事情' })
    .click()
  await forcedPage
    .getByRole('heading', { name: '所有事情', exact: true })
    .waitFor()
  const forcedState = await forcedPage.evaluate(() => {
    const glyph = globalThis.document.querySelector(
      '.work-icon .pegas-agent-glyph',
    )
    const status = globalThis.document.querySelector('.status-text')
    return {
      hasGlyph: !!glyph,
      glyphBox: glyph?.getBoundingClientRect().width ?? 0,
      statusText: status?.textContent ?? '',
    }
  })
  if (!forcedState.hasGlyph || forcedState.glyphBox < 10)
    throw new Error('forced-colors: worker glyph missing')
  if (!forcedState.statusText.trim())
    throw new Error('forced-colors: status must keep a text cue')
  console.log(
    `a11y forced-colors: glyph ${forcedState.glyphBox}px, status text "${forcedState.statusText}"`,
  )
  await forced.close()

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    hasTouch: true,
  })
  await mobile.addInitScript(() => {
    localStorage.setItem('pegas-setup-complete', 'true')
    localStorage.setItem('pegas-theme', 'light')
  })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(`http://127.0.0.1:${port}/`)
  await mobilePage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  await mobilePage
    .getByLabel('移动端主导航')
    .getByRole('button', { name: '待你处理' })
    .click()
  await mobilePage
    .getByRole('heading', { name: '待你处理', exact: true })
    .waitFor()
  await mobilePage
    .getByLabel('待处理列表')
    .getByRole('article')
    .first()
    .waitFor()
  await audit(mobilePage, 'mobile-attention')
  await mobile.close()

  console.log('Accessibility review passed.')
} finally {
  await browser?.close()
  for (const child of children) child.kill('SIGTERM')
  await new Promise(resolveClose => modelGateway.close(resolveClose))
}
