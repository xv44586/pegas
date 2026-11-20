import { execFileSync, spawn } from 'node:child_process'
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

const dataDirectory = mkdtempSync(resolve(tmpdir(), 'pegas-ui-review-'))
const port = await availablePort()
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_EXECUTOR: 'echo',
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

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const page = await desktop.newPage()
  page.setDefaultTimeout(12_000)
  await page.goto(`http://127.0.0.1:${String(port)}/`)
  const composerInput = page.getByRole('textbox', { name: '给 Pegas 发消息' })
  await composerInput.waitFor()
  await capture(page, 'desktop-conversation.png', 'desktop-conversation')
  await composerInput.focus()
  await capture(page, 'desktop-composer-focus.png', 'desktop-composer-focus')
  await page.getByRole('button', { name: /选择执行模型/ }).click()
  await page.getByRole('dialog', { name: '选择模型' }).waitFor()
  await capture(
    page,
    'desktop-composer-model-picker.png',
    'desktop-composer-model-picker',
  )
  await page.keyboard.press('Escape')
  await composerInput.fill(
    '请帮我整理下周的重点工作。\n先列出计划，再标记需要我确认的事项。',
  )
  await capture(
    page,
    'desktop-composer-multiline.png',
    'desktop-composer-multiline',
  )
  await composerInput.fill('')

  await page
    .getByLabel('主导航')
    .getByRole('button', { name: '所有事情' })
    .click()
  await page.getByRole('heading', { name: '所有事情', exact: true }).waitFor()
  await capture(page, 'desktop-all-work.png', 'desktop-all-work')

  await page
    .getByLabel('主导航')
    .getByRole('button', { name: '待你处理' })
    .click()
  await page.getByRole('heading', { name: '待你处理', exact: true }).waitFor()
  await capture(page, 'desktop-attention.png', 'desktop-attention')

  await page
    .getByLabel('主导航')
    .getByRole('button', { name: '自动化' })
    .click()
  await page.getByRole('heading', { name: '自动化', exact: true }).waitFor()
  await capture(page, 'desktop-automation.png', 'desktop-automation')

  await page.getByLabel('主导航').getByRole('button', { name: '记忆' }).click()
  await page.getByRole('heading', { name: '记忆', exact: true }).waitFor()
  await capture(page, 'desktop-memory.png', 'desktop-memory')

  await page.getByLabel('主导航').getByRole('button', { name: '对话' }).click()
  await page
    .getByLabel('主导航')
    .getByRole('button')
    .filter({ hasText: '封板' })
    .first()
    .click()
  await page.getByLabel('工作详情').waitFor()
  await capture(page, 'desktop-work-detail.png', 'desktop-work-detail')
  const artifact = page.getByRole('button', { name: /执行方案\.md/u })
  if (await artifact.count()) {
    await artifact.click()
    await page.getByRole('heading', { name: '文件预览' }).waitFor()
    await capture(page, 'desktop-file-preview.png', 'desktop-file-preview')
  }
  await page.getByRole('button', { name: '关闭详情' }).click()

  await page
    .getByLabel('主导航')
    .getByRole('button', { name: '设置', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Pegas', exact: true }).waitFor()
  await capture(page, 'desktop-settings-pegas.png', 'desktop-settings-pegas')
  await page.getByRole('tab', { name: '行为与规则' }).click()
  await capture(
    page,
    'desktop-settings-behavior.png',
    'desktop-settings-behavior',
  )
  await page.getByRole('button', { name: '查看运行时' }).click()
  await page.getByRole('heading', { name: '执行环境详情' }).waitFor()
  await capture(page, 'desktop-runtime.png', 'desktop-runtime')
  await page.getByRole('button', { name: '关闭详情' }).click()

  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '外观', exact: true })
    .click()
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor()
  await capture(
    page,
    'desktop-settings-appearance.png',
    'desktop-settings-appearance',
  )

  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '模型服务' })
    .click()
  await page.getByRole('heading', { name: '模型服务', exact: true }).waitFor()
  await capture(page, 'desktop-settings-models.png', 'desktop-settings-models')
  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '事情归类' })
    .click()
  await page.getByRole('heading', { name: '事情归类', exact: true }).waitFor()
  await capture(page, 'desktop-settings-router.png', 'desktop-settings-router')
  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '语音与输入' })
    .click()
  await page.getByRole('heading', { name: '语音与输入', exact: true }).waitFor()
  await page.getByLabel('语音服务').selectOption('openai-compatible')
  await page.getByLabel('启用轻量改写').check()
  await capture(page, 'desktop-settings-voice.png', 'desktop-settings-voice')
  await page.getByRole('button', { name: '测试改写' }).scrollIntoViewIfNeeded()
  await capture(
    page,
    'desktop-settings-rewrite.png',
    'desktop-settings-rewrite',
  )
  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '模型用量' })
    .click()
  await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor()
  await capture(page, 'desktop-settings-usage.png', 'desktop-settings-usage')

  for (const [label, slug] of [
    ['能力与连接', 'connections'],
    ['记忆', 'memory'],
    ['隐私', 'privacy'],
    ['通知', 'notifications'],
    ['数据与恢复', 'recovery'],
    ['关于', 'about'],
  ]) {
    await page
      .getByLabel('设置分类')
      .getByRole('button', { name: label, exact: true })
      .click()
    if (slug === 'about') await page.locator('.about-pane').waitFor()
    else await page.getByRole('heading', { name: label, exact: true }).waitFor()
    await capture(
      page,
      `desktop-settings-${slug}.png`,
      `desktop-settings-${slug}`,
    )
  }

  await page.goto(`http://127.0.0.1:${String(port)}/?setup=1`)
  await page
    .getByRole('heading', { name: '欢迎使用 Pegas', exact: true })
    .waitFor()
  await capture(page, 'desktop-onboarding.png', 'desktop-onboarding')
  for (const [heading, slug] of [
    ['连接模型服务', 'models'],
    ['准备执行环境', 'runtime'],
    ['语音与完成确认', 'finish'],
  ]) {
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    await capture(
      page,
      `desktop-onboarding-${slug}.png`,
      `desktop-onboarding-${slug}`,
    )
  }
  await desktop.close()

  const dark = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const darkPage = await dark.newPage()
  await darkPage.addInitScript(() =>
    localStorage.setItem('pegas-theme', 'dark'),
  )
  await darkPage.goto(`http://127.0.0.1:${String(port)}/`)
  await darkPage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  await capture(darkPage, 'desktop-dark.png', 'desktop-dark')
  await darkPage
    .getByLabel('主导航')
    .getByRole('button', { name: '设置', exact: true })
    .click()
  await darkPage
    .getByLabel('设置分类')
    .getByRole('button', { name: '事情归类' })
    .click()
  await capture(
    darkPage,
    'desktop-dark-settings-router.png',
    'desktop-dark-settings-router',
  )
  await dark.close()

  for (const theme of ['warm', 'system']) {
    const themed = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme === 'system' ? 'dark' : 'light',
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    })
    const themedPage = await themed.newPage()
    await themedPage.addInitScript(
      value => localStorage.setItem('pegas-theme', value),
      theme,
    )
    await themedPage.goto(`http://127.0.0.1:${String(port)}/`)
    await themedPage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
    await capture(themedPage, `desktop-${theme}.png`, `desktop-${theme}`)
    await themed.close()
  }

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    hasTouch: true,
  })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(`http://127.0.0.1:${String(port)}/`)
  const mobileComposer = mobilePage.getByRole('textbox', {
    name: '给 Pegas 发消息',
  })
  await mobileComposer.waitFor()
  await capture(mobilePage, 'mobile-conversation.png', 'mobile-conversation')
  await mobileComposer.focus()
  await capture(
    mobilePage,
    'mobile-composer-focus.png',
    'mobile-composer-focus',
  )
  await mobilePage.getByRole('button', { name: /选择执行模型/ }).click()
  await mobilePage.getByRole('dialog', { name: '选择模型' }).waitFor()
  await capture(
    mobilePage,
    'mobile-composer-model-picker.png',
    'mobile-composer-model-picker',
  )
  await mobilePage.keyboard.press('Escape')
  await mobilePage
    .getByLabel('移动端主导航')
    .getByRole('button', { name: '所有事情' })
    .click()
  await mobilePage
    .getByRole('heading', { name: '所有事情', exact: true })
    .waitFor()
  await capture(mobilePage, 'mobile-all-work.png', 'mobile-all-work')
  await mobilePage.getByRole('tab', { name: '已完成' }).click()
  const mobileWork = mobilePage
    .getByLabel('事情列表')
    .getByRole('button')
    .first()
  if (await mobileWork.count()) {
    await mobileWork.click()
    await mobilePage.getByLabel('工作详情').waitFor()
    await capture(mobilePage, 'mobile-work-detail.png', 'mobile-work-detail')
    await mobilePage.getByRole('button', { name: '关闭详情' }).click()
  }
  await mobilePage
    .getByLabel('移动端主导航')
    .getByRole('button', { name: '设置' })
    .click()
  await mobilePage
    .getByRole('heading', { name: 'Pegas', exact: true })
    .waitFor()
  await capture(mobilePage, 'mobile-settings.png', 'mobile-settings')
  await mobilePage
    .getByLabel('设置分类')
    .getByRole('button', { name: '外观', exact: true })
    .click()
  await capture(
    mobilePage,
    'mobile-settings-appearance.png',
    'mobile-settings-appearance',
  )
  await mobilePage
    .getByLabel('设置分类')
    .getByRole('button', { name: '事情归类', exact: true })
    .click()
  await capture(
    mobilePage,
    'mobile-settings-router.png',
    'mobile-settings-router',
  )
  await mobilePage
    .getByLabel('设置分类')
    .getByRole('button', { name: '语音与输入', exact: true })
    .click()
  await mobilePage.getByLabel('语音服务').selectOption('openai-compatible')
  await mobilePage.getByLabel('启用轻量改写').check()
  await mobilePage
    .getByRole('button', { name: '测试改写' })
    .scrollIntoViewIfNeeded()
  await capture(
    mobilePage,
    'mobile-settings-voice.png',
    'mobile-settings-voice',
  )
  await mobile.close()

  const reviewFixtures = [
    'task-completed',
    'task-running',
    'task-waiting',
    'task-failed',
    'preview-file',
    'preview-image',
    'preview-video',
    'preview-web',
  ]
  for (const [size, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const review = await browser.newContext({
      viewport,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    })
    for (const fixture of reviewFixtures) {
      const fixturePage = await review.newPage()
      await fixturePage.addInitScript(value => {
        globalThis.__PEGAS_UI_REVIEW__ = value
      }, fixture)
      await fixturePage.goto(`http://127.0.0.1:${String(port)}/`)
      await fixturePage.getByRole('button', { name: '关闭详情' }).waitFor()
      await capture(fixturePage, `${size}-${fixture}.png`, `${size}-${fixture}`)
      await fixturePage.close()
    }
    await review.close()
  }

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
    '为 Pegas 封板新的白底界面',
    '检查设置与工作详情是否一致',
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
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/channels?userId=owner`,
    )
    const body = await response.json()
    if (body.channels?.length >= 2) return
    await wait(50)
  }
  throw new Error('UI review channels were not created')
}

async function capture(page, name, label) {
  await assertGeometry(page, label)
  await page.screenshot({
    path: resolve(outputDirectory, name),
    fullPage: false,
    animations: 'disabled',
  })
}

async function assertGeometry(page, label) {
  const failures = await page.evaluate(() => {
    const out = []
    const root = globalThis.document.documentElement
    if (root.scrollWidth > root.clientWidth + 1)
      out.push(
        `page overflows ${String(root.scrollWidth)}>${String(root.clientWidth)}`,
      )
    for (const element of globalThis.document.querySelectorAll(
      '.app-shell, .composer-wrap, .detail-drawer, .settings-page, .onboarding-dialog, .command-dialog',
    )) {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (rect.left < -1 || rect.right > globalThis.innerWidth + 1)
        out.push(
          `${element.className} crosses viewport ${String(Math.round(rect.left))}..${String(Math.round(rect.right))} of ${String(globalThis.innerWidth)}`,
        )
    }
    for (const element of globalThis.document.querySelectorAll(
      '.page-header, .setting-summary-row, .compact-field-row, .artifact-row, .work-list > button',
    )) {
      if (element.scrollWidth > element.clientWidth + 1)
        out.push(
          `${element.className} clips horizontally ${String(element.scrollWidth)}>${String(element.clientWidth)}`,
        )
    }
    const settingsContent =
      globalThis.document.querySelector('.settings-content')
    const scrollRegion = globalThis.document.querySelector(
      '.settings-scroll-region',
    )
    const settingsFooter = globalThis.document.querySelector('.settings-footer')
    if (settingsContent && scrollRegion && settingsFooter) {
      if (settingsFooter.parentElement !== settingsContent)
        out.push('settings footer is not a direct child of settings content')
      if (scrollRegion.contains(settingsFooter))
        out.push('settings footer is inside the scrolling region')
      const scrollRect = scrollRegion.getBoundingClientRect()
      const footerRect = settingsFooter.getBoundingClientRect()
      if (Math.abs(scrollRect.bottom - footerRect.top) > 2)
        out.push(
          `settings layers do not meet ${String(Math.round(scrollRect.bottom))}..${String(Math.round(footerRect.top))}`,
        )
    }
    for (const element of globalThis.document.querySelectorAll('select')) {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const style = globalThis.getComputedStyle(element)
      if (style.appearance !== 'none')
        out.push(`select keeps native appearance (${style.appearance})`)
      if (rect.height < 40)
        out.push(`select is too short (${String(Math.round(rect.height))})`)
      if (Number.parseFloat(style.paddingRight) < 32)
        out.push(`select chevron padding is too small (${style.paddingRight})`)
    }
    for (const row of globalThis.document.querySelectorAll('.test-row')) {
      const button = row.querySelector('button')
      const input = row.querySelector('input')
      if (!button || !input) continue
      const buttonRect = button.getBoundingClientRect()
      const inputRect = input.getBoundingClientRect()
      if (buttonRect.width < 72)
        out.push(`test button is too narrow (${String(buttonRect.width)})`)
      if (button.scrollWidth > button.clientWidth + 1)
        out.push('test button text wraps or clips')
      if (inputRect.width <= buttonRect.width)
        out.push('test input does not receive the flexible row width')
    }
    for (const label of globalThis.document.querySelectorAll(
      '.radio-row label',
    )) {
      if (label.scrollWidth > label.clientWidth + 1)
        out.push('radio label wraps or clips')
    }
    for (const toggle of globalThis.document.querySelectorAll(
      ".switch-row input[type='checkbox']",
    )) {
      const rect = toggle.getBoundingClientRect()
      if (Math.abs(rect.width - 40) > 1 || Math.abs(rect.height - 22) > 1)
        out.push(
          `switch track changed size (${String(Math.round(rect.width))}x${String(Math.round(rect.height))})`,
        )
    }
    const composer = globalThis.document.querySelector('.composer')
    const composerInput = composer?.querySelector('textarea')
    const sendButton = composer?.querySelector('.send-button')
    if (composer && composerInput && sendButton) {
      const composerStyle = globalThis.getComputedStyle(composer)
      const inputStyle = globalThis.getComputedStyle(composerInput)
      const sendRect = sendButton.getBoundingClientRect()
      if (Number.parseFloat(composerStyle.borderRadius) > 26)
        out.push(`composer is too pill-shaped (${composerStyle.borderRadius})`)
      if (inputStyle.fieldSizing !== 'content')
        out.push(
          `composer textarea does not auto-size (${inputStyle.fieldSizing})`,
        )
      if (sendRect.width < 38 || sendRect.height < 38)
        out.push(
          `composer send target is too small (${String(Math.round(sendRect.width))}x${String(Math.round(sendRect.height))})`,
        )
      if (globalThis.document.activeElement === composerInput) {
        if (
          inputStyle.outlineStyle !== 'none' &&
          Number.parseFloat(inputStyle.outlineWidth) > 0
        )
          out.push('composer textarea draws its own inner focus rectangle')
        if (composerStyle.boxShadow === 'none')
          out.push('focused composer has no visible outer focus treatment')
      }
    }
    const modelPicker = globalThis.document.querySelector(
      '.composer-model-picker',
    )
    if (modelPicker) {
      const rect = modelPicker.getBoundingClientRect()
      if (
        rect.left < -1 ||
        rect.right > globalThis.innerWidth + 1 ||
        rect.top < -1 ||
        rect.bottom > globalThis.innerHeight + 1
      )
        out.push(
          `model picker escapes viewport (${String(Math.round(rect.left))}, ${String(Math.round(rect.top))}, ${String(Math.round(rect.right))}, ${String(Math.round(rect.bottom))})`,
        )
      if (!modelPicker.querySelector('[role="option"]'))
        out.push('model picker has no selectable options')
    }
    return out
  })
  if (failures.length) throw new Error(`${label}: ${failures.join('; ')}`)
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
      // Control Plane is still starting.
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
