import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
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
const dshFixture = resolve(dataDirectory, 'ui-review-dsh')
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
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', async () => {
  const sessionId = 'ui-review-' + process.env.PEGAS_RUN_ID
  const text = input.split('\\n')[0]
  if (
    text.includes('调研托盘常驻显示方案') &&
    process.env.PEGAS_CONTROL_PLANE_URL &&
    process.env.PEGAS_RUN_ID &&
    process.env.PEGAS_RUN_CLAIM_TOKEN &&
    process.env.PEGAS_INPUT_EVENT_ID
  ) {
    const goal = {
      basedOnEventIds: [process.env.PEGAS_INPUT_EVENT_ID],
      desiredOutcome: '托盘常驻显示方案通过评审。',
      beneficiaries: ['owner'],
      successCriteria: [
        {
          criterionId: 'criterion-tray',
          observableStatement: '托盘截图与交互合同一致。',
          required: true,
          evidencePlanRef: 'plan-tray',
        },
      ],
      nonGoals: ['不对外发布。'],
      constraints: ['保持用户数据私有。'],
      contextSources: [
        {
          sourceRef: process.env.PEGAS_INPUT_EVENT_ID,
          freshness: 'current',
          authority: 'user',
          conflictPriority: 0,
        },
      ],
      assumptions: [],
      unknowns: [],
      prerequisites: [],
      permissionBoundary: { externalWrites: false },
      reviewCheckpoints: ['final'],
      evidencePlan: [
        {
          id: 'plan-tray',
          criterionId: 'criterion-tray',
          acceptedKinds: ['screenshot'],
          acceptedTrustClasses: ['control-plane'],
          minimumCount: 1,
          presentation: 'inline',
        },
      ],
      failureAndRecovery: '保留事情并等待有效证据。',
      feedbackSignals: ['user_acceptance'],
    }
    const response = await fetch(
      process.env.PEGAS_CONTROL_PLANE_URL +
        '/v1/runs/' +
        process.env.PEGAS_RUN_ID +
        '/goal-proposals',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': process.env.PEGAS_RUN_CLAIM_TOKEN,
        },
        body: JSON.stringify({ commandId: 'feature-review-tray-goal', goal }),
      },
    )
    if (response.status !== 201) {
      console.log(
        JSON.stringify({
          type: 'error',
          message: 'tray goal proposal failed: ' + response.status,
        }),
      )
      process.exit(1)
    }
  }
  console.log(
    JSON.stringify({
      type: 'final',
      sessionId,
      text,
      reason: { kind: 'completed' },
    }),
  )
})
`,
)
chmodSync(dshFixture, 0o755)
const port = await availablePort()
const recoveryPort = await availablePort()
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
  PEGAS_EXECUTOR: 'dsh',
  PEGAS_MODEL_BASE_URL: `http://127.0.0.1:${String(modelGatewayPort)}/v1`,
  PEGAS_MODEL_NAME: 'deepseek-v4.1-flash',
  PEGAS_RECOVERY_BASE_URL: `http://127.0.0.1:${String(recoveryPort)}`,
  PEGAS_SPEECH_PROVIDER: 'disabled',
  PEGAS_PUSH_MODE: 'disabled',
  PEGAS_ROUTE_COLLECT_WINDOW_MS: '0',
  PEGAS_ROUTER: 'rules',
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
  spawn(process.execPath, [resolve(repositoryRoot, 'dist/scheduler/main.js')], {
    cwd: repositoryRoot,
    env: { ...environment, PEGAS_SCHEDULER_POLL_MS: '50' },
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
  await desktop.addInitScript(() =>
    localStorage.setItem('pegas-setup-complete', 'true'),
  )
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
  await assertPickerPagination(page, 'desktop model picker')
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
  await page.getByLabel('待处理列表').getByRole('article').first().waitFor()
  await capture(page, 'desktop-attention.png', 'desktop-attention')
  await page
    .getByRole('group', { name: '筛选' })
    .getByRole('button', { name: /^待你处理 / })
    .click()
  await page.getByLabel('待处理列表').getByRole('article').first().waitFor()
  await capture(
    page,
    'desktop-attention-approval-filter.png',
    'desktop-attention-approval-filter',
  )
  await page
    .getByRole('group', { name: '筛选' })
    .getByRole('button', { name: /^全部 / })
    .click()
  await page.getByLabel('搜索待处理内容').fill('不存在的关键词')
  await page.getByText('当前筛选下没有待处理项').waitFor()
  await capture(
    page,
    'desktop-attention-search-empty.png',
    'desktop-attention-search-empty',
  )
  await page.getByLabel('搜索待处理内容').fill('')
  const filterRow = page.getByRole('group', { name: '筛选' })
  await filterRow.evaluate(element => {
    element.scrollLeft = element.scrollWidth
  })
  await page
    .getByRole('group', { name: '筛选' })
    .getByRole('button', { name: /^事情动态 / })
    .click()
  await page.getByLabel('待处理列表').getByRole('article').first().waitFor()
  await capture(
    page,
    'desktop-attention-result-filter.png',
    'desktop-attention-result-filter',
  )
  await page
    .getByRole('group', { name: '筛选' })
    .getByRole('button', { name: /^全部 / })
    .click()

  await page
    .getByLabel('主导航')
    .getByRole('button', { name: '自动化' })
    .click()
  await page.getByRole('heading', { name: '自动化', exact: true }).waitFor()
  await page.getByText('晨间简报').waitFor()
  await capture(page, 'desktop-automation.png', 'desktop-automation')
  await page.getByRole('button', { name: '查看指令' }).first().click()
  await page.locator('.automation-prompt').first().waitFor()
  await capture(page, 'desktop-automation-prompt.png', 'desktop-automation')
  await page.getByRole('button', { name: '收起指令' }).first().click()
  await page.getByRole('button', { name: /已结束 2/ }).click()
  await page.getByText('每分钟报数 1→10').waitFor()
  await capture(page, 'desktop-automation-ended.png', 'desktop-automation')
  const endedHistoryRow = page
    .getByLabel('已结束的自动化')
    .getByRole('article')
    .filter({ hasText: '触发记录示例' })
  await endedHistoryRow.getByRole('button', { name: '删除' }).click()
  await endedHistoryRow.getByRole('button', { name: '确认删除' }).waitFor()
  await capture(
    page,
    'desktop-automation-delete-confirm.png',
    'desktop-automation-delete-confirm',
  )
  await endedHistoryRow.getByRole('button', { name: '保留' }).click()
  await endedHistoryRow.getByRole('button', { name: '触发记录' }).click()
  await page.locator('.record-history .invocation-summary').first().waitFor()
  await capture(
    page,
    'desktop-automation-history.png',
    'desktop-automation-history',
  )
  await endedHistoryRow.getByRole('button', { name: '触发记录' }).click()
  await page.getByRole('button', { name: /已结束 2/ }).click()

  await page.getByLabel('主导航').getByRole('button', { name: '记忆' }).click()
  await page.getByRole('heading', { name: '记忆', exact: true }).waitFor()
  await page.getByText('我喜欢安静、白底、信息层级清楚的界面。').waitFor()
  await capture(page, 'desktop-memory.png', 'desktop-memory')

  await page.getByLabel('主导航').getByRole('button', { name: '对话' }).click()
  await page
    .getByLabel('主导航')
    .getByRole('button')
    .filter({ hasText: '封板' })
    .first()
    .click()
  await page.getByRole('dialog', { name: '工作详情' }).waitFor()
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
  await page.getByRole('button', { name: '更换模型' }).click()
  await assertPickerPagination(page, 'desktop settings execution picker', {
    pinnedOptions: 1,
  })
  await capture(
    page,
    'desktop-settings-pegas-picker.png',
    'desktop-settings-pegas-picker',
  )
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: '选择模型' })
    .waitFor({ state: 'detached' })
  const fastPoolTrigger = page.getByRole('button', {
    name: /，fast 池模型$/,
  })
  await fastPoolTrigger.scrollIntoViewIfNeeded()
  await fastPoolTrigger.click()
  await assertPickerPagination(page, 'desktop settings fast pool picker', {
    title: 'fast 池模型',
    pinnedOptions: 1,
  })
  await capture(
    page,
    'desktop-settings-pool-picker.png',
    'desktop-settings-pool-picker',
  )
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: 'fast 池模型' })
    .waitFor({ state: 'detached' })
  await page.getByRole('tab', { name: '行为与规则' }).click()
  await page
    .getByText('产品设计优先给出具体界面方案', { exact: true })
    .waitFor()
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
  await page.getByRole('button', { name: '获取模型目录' }).click()
  await page.getByText('已读取 34 个模型').waitFor()
  const catalogRows = page.locator('.model-table > div')
  if ((await catalogRows.count()) !== 31)
    throw new Error('model catalog page one must show 30 rows plus header')
  await page.getByRole('button', { name: '下一页' }).click()
  await page.getByText('Fixture Model 34', { exact: true }).waitFor()
  await page.getByRole('button', { name: '上一页' }).click()
  const catalogSearch = page.getByPlaceholder('按名称或模型 ID 搜索')
  await catalogSearch.click()
  await capture(
    page,
    'desktop-settings-models-search-focus.png',
    'desktop-settings-models-search-focus',
  )
  await catalogSearch.fill('')
  await page
    .getByLabel('设置分类')
    .getByRole('button', { name: '事情归类' })
    .click()
  await page.getByRole('heading', { name: '事情归类', exact: true }).waitFor()
  await capture(page, 'desktop-settings-router.png', 'desktop-settings-router')
  await page.getByRole('button', { name: /，归类模型名称$/ }).click()
  await assertPickerPagination(page, 'desktop settings router picker', {
    title: '归类模型',
  })
  await capture(
    page,
    'desktop-settings-router-picker.png',
    'desktop-settings-router-picker',
  )
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: '归类模型' })
    .waitFor({ state: 'detached' })
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
    if (slug === 'recovery')
      await page
        .locator('.health-badge')
        .filter({ hasText: '状态不可用' })
        .waitFor()
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
    if (slug === 'models') {
      await page.getByRole('button', { name: /，默认模型$/ }).click()
      await assertPickerPagination(page, 'onboarding model picker')
      const panelGeometry = await page.evaluate(() => {
        const panel = globalThis.document.querySelector(
          '.setup-form .model-picker-panel',
        )
        if (!panel) return 'onboarding picker panel missing'
        const rect = panel.getBoundingClientRect()
        if (
          rect.left < -1 ||
          rect.right > globalThis.innerWidth + 1 ||
          rect.top < -1 ||
          rect.bottom > globalThis.innerHeight + 1
        )
          return `onboarding picker panel escapes viewport ${JSON.stringify(rect)}`
        const probe = globalThis.document.elementFromPoint(
          rect.left + rect.width / 2,
          Math.min(rect.bottom - 8, globalThis.innerHeight - 8),
        )
        if (!probe || !panel.contains(probe))
          return 'onboarding picker panel bottom is clipped or covered'
        return ''
      })
      if (panelGeometry) throw new Error(panelGeometry)
      await capture(
        page,
        'desktop-onboarding-models-picker.png',
        'desktop-onboarding-models-picker',
      )
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /，默认模型$/ }).waitFor()
    }
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
  await dark.addInitScript(() =>
    localStorage.setItem('pegas-setup-complete', 'true'),
  )
  const darkPage = await dark.newPage()
  await darkPage.addInitScript(() =>
    localStorage.setItem('pegas-theme', 'dark'),
  )
  await darkPage.goto(`http://127.0.0.1:${String(port)}/`)
  await darkPage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  await capture(darkPage, 'desktop-dark.png', 'desktop-dark')
  await darkPage
    .getByLabel('主导航')
    .getByRole('button', { name: '待你处理' })
    .click()
  await darkPage
    .getByRole('heading', { name: '待你处理', exact: true })
    .waitFor()
  await darkPage.getByLabel('待处理列表').getByRole('article').first().waitFor()
  await capture(
    darkPage,
    'desktop-dark-attention.png',
    'desktop-dark-attention',
  )
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
    await themed.addInitScript(() =>
      localStorage.setItem('pegas-setup-complete', 'true'),
    )
    const themedPage = await themed.newPage()
    await themedPage.addInitScript(
      value => localStorage.setItem('pegas-theme', value),
      theme,
    )
    await themedPage.goto(`http://127.0.0.1:${String(port)}/`)
    await themedPage.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
    await capture(themedPage, `desktop-${theme}.png`, `desktop-${theme}`)
    await themedPage
      .getByLabel('主导航')
      .getByRole('button', { name: '待你处理' })
      .click()
    await themedPage
      .getByRole('heading', { name: '待你处理', exact: true })
      .waitFor()
    await themedPage
      .getByLabel('待处理列表')
      .getByRole('article')
      .first()
      .waitFor()
    await capture(
      themedPage,
      `desktop-${theme}-attention.png`,
      `desktop-${theme}-attention`,
    )
    await themed.close()
  }

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    hasTouch: true,
  })
  await mobile.addInitScript(() =>
    localStorage.setItem('pegas-setup-complete', 'true'),
  )
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
  await assertPickerPagination(mobilePage, 'mobile model picker')
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
  await capture(mobilePage, 'mobile-attention.png', 'mobile-attention')
  const mobileFilters = mobilePage.getByRole('group', { name: '筛选' })
  await mobileFilters.evaluate(element => {
    element.scrollLeft = element.scrollWidth
  })
  await mobileFilters.getByRole('button', { name: /^事情动态 / }).click()
  await mobilePage
    .getByLabel('待处理列表')
    .getByRole('article')
    .first()
    .waitFor()
  await mobileFilters.evaluate(element => {
    element.scrollLeft = element.scrollWidth
  })
  await capture(
    mobilePage,
    'mobile-attention-result-filter.png',
    'mobile-attention-result-filter',
  )
  await mobileFilters.getByRole('button', { name: /^全部 / }).click()
  await mobileFilters.evaluate(element => {
    element.scrollLeft = 0
  })
  await mobilePage
    .getByLabel('待处理列表')
    .getByRole('button', { name: /^打开事情：/ })
    .first()
    .click()
  await mobilePage.getByRole('dialog', { name: '工作详情' }).waitFor()
  await capture(
    mobilePage,
    'mobile-attention-detail.png',
    'mobile-attention-detail',
  )
  await mobilePage.getByRole('button', { name: '关闭详情' }).click()
  await mobilePage
    .getByLabel('移动端主导航')
    .getByRole('button', { name: '所有事情' })
    .click()
  await mobilePage
    .getByRole('heading', { name: '所有事情', exact: true })
    .waitFor()
  const mobileWork = mobilePage
    .getByLabel('事情列表')
    .getByRole('button')
    .first()
  if (await mobileWork.count()) {
    await mobileWork.click()
    await mobilePage.getByRole('dialog', { name: '工作详情' }).waitFor()
    await capture(mobilePage, 'mobile-work-detail.png', 'mobile-work-detail')
    await mobilePage.getByRole('button', { name: '关闭详情' }).click()
  }
  await mobilePage
    .getByLabel('移动端主导航')
    .getByRole('button', { name: '自动化' })
    .click()
  await mobilePage
    .getByRole('heading', { name: '自动化', exact: true })
    .waitFor()
  await mobilePage.getByText('晨间简报').waitFor()
  await mobilePage.getByRole('button', { name: /已结束 2/ }).click()
  await mobilePage.getByText('每分钟报数 1→10').waitFor()
  await capture(mobilePage, 'mobile-automation.png', 'mobile-automation')
  const mobileEndedHistoryRow = mobilePage
    .getByLabel('已结束的自动化')
    .getByRole('article')
    .filter({ hasText: '触发记录示例' })
  await mobileEndedHistoryRow.getByRole('button', { name: '触发记录' }).click()
  await mobilePage
    .locator('.record-history .invocation-summary')
    .first()
    .waitFor()
  await capture(
    mobilePage,
    'mobile-automation-history.png',
    'mobile-automation-history',
  )
  await mobileEndedHistoryRow.getByRole('button', { name: '触发记录' }).click()
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
    'task-activity',
    'task-activity-open',
    'task-activity-running',
    'task-web-agent',
    'task-todo-search',
    'task-run-artifacts',
    'task-output-archive',
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
      if (fixture === 'task-output-archive') {
        await fixturePage.route('**/v1/runs/**', async route => {
          const url = route.request().url()
          if (url.includes('/output?')) {
            const offset = Number(
              new URL(url).searchParams.get('offset') ?? '0',
            )
            if (url.includes('/call-6/')) {
              const head = Array.from(
                { length: 40 },
                (_, index) =>
                  `line ${String(index + 1).padStart(3, '0')}: coverage head output`,
              ).join('\n')
              const middle = Array.from(
                { length: 40 },
                (_, index) =>
                  `line ${String(index + 41).padStart(3, '0')}: omitted middle output — coverage detail`,
              ).join('\n')
              const gapStart = head.length
              const gapEnd = gapStart + middle.length
              const content =
                offset === 0 ? head : offset === gapStart ? middle : ''
              await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                  runId: 'review-completed',
                  callId: 'call-6',
                  content,
                  offset,
                  totalCharacters: 12_000,
                  archivedCharacters: 12_000,
                  truncatedArchive: false,
                  gapStart,
                  gapEnd,
                }),
              })
              return
            }
            if (url.includes('/call-7/')) {
              const full =
                offset === 0
                  ? `${Array.from(
                      { length: 40 },
                      (_, index) =>
                        `line ${String(index + 1).padStart(3, '0')}: spilled full build log`,
                    ).join(
                      '\n',
                    )}\nERROR: build failed at step 42 — full log kept by the executor`
                  : ''
              await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                  runId: 'review-completed',
                  callId: 'call-7',
                  content: full,
                  offset,
                  totalCharacters: 2_400,
                  archivedCharacters: 2_400,
                  truncatedArchive: false,
                }),
              })
              return
            }
            const isWebPreview = url.includes('/call-4/')
            const tail =
              offset === (isWebPreview ? 4_001 : 4_000)
                ? Array.from(
                    { length: 40 },
                    (_, index) =>
                      `line ${String(index + 161).padStart(3, '0')}: archived tail output — ${isWebPreview ? 'readme remainder' : 'suite finished'}`,
                  ).join('\n')
                : ''
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                runId: 'review-completed',
                callId: isWebPreview ? 'call-4' : 'call-2',
                content: tail,
                offset,
                totalCharacters: 14_800,
                archivedCharacters: 14_800,
                truncatedArchive: false,
              }),
            })
            return
          }
          if (url.includes('/output-file?')) {
            await route.fulfill({
              contentType: 'text/plain; charset=utf-8',
              body: 'spilled full build log\nERROR: build failed at step 42',
            })
            return
          }
          if (url.includes('/image?')) {
            const png = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              'base64',
            )
            await route.fulfill({ contentType: 'image/png', body: png })
            return
          }
          await route.fulfill({
            contentType: 'application/json',
            status: 404,
            body: JSON.stringify({ error: 'not_found' }),
          })
        })
      }
      await fixturePage.goto(`http://127.0.0.1:${String(port)}/`)
      await fixturePage.getByRole('button', { name: '关闭详情' }).waitFor()
      if (fixture.startsWith('task-activity')) {
        await fixturePage.getByText('工作流程记录', { exact: false }).click()
        if (fixture === 'task-activity-open') {
          await fixturePage
            .locator('.activity-batch > details > summary')
            .filter({ hasText: '运行了 2 条命令' })
            .click()
          await fixturePage
            .locator('.activity-tool')
            .filter({ hasText: 'git merge origin/main' })
            .locator('summary')
            .click()
          await fixturePage
            .locator('.activity-timeline > .activity-tool')
            .filter({ hasText: '已编辑' })
            .locator('summary')
            .first()
            .click()
          await fixturePage
            .locator('.activity-card.diff-card')
            .first()
            .scrollIntoViewIfNeeded()
        }
      }
      if (fixture === 'task-web-agent') {
        await fixturePage.getByText('工作流程记录', { exact: false }).click()
        await fixturePage
          .locator('.activity-batch > details > summary')
          .filter({ hasText: '访问了 2 个网页' })
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '已搜索网页' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-batch > details > summary')
          .filter({ hasText: '正在协调子 agent' })
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '查看了子 agent' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-card.agent-card')
          .first()
          .scrollIntoViewIfNeeded()
      }
      if (fixture === 'task-todo-search') {
        await fixturePage.getByText('工作流程记录', { exact: false }).click()
        await fixturePage
          .locator('.activity-batch > details > summary')
          .filter({ hasText: '搜索了 2 次' })
          .click()
        await fixturePage
          .locator('.activity-todo-fold')
          .locator('summary')
          .first()
          .click()
        await fixturePage
          .locator('.activity-todo-fold .todo-history > summary')
          .click()
        await fixturePage
          .locator('.activity-batch .activity-tool')
          .filter({ hasText: '搜索命中' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-batch .activity-tool')
          .filter({ hasText: '匹配了文件' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '你回答了提问' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-card.ask-card')
          .first()
          .scrollIntoViewIfNeeded()
      }
      if (fixture === 'task-run-artifacts') {
        await fixturePage.getByText('工作流程记录', { exact: false }).click()
        await fixturePage
          .locator('.activity-changes > details > summary')
          .click()
        await fixturePage
          .locator('.changes-files > li > details > summary')
          .first()
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '查看了图片' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '声明了交付物' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-card.delivery-card')
          .scrollIntoViewIfNeeded()
      }
      if (fixture === 'task-output-archive') {
        await fixturePage.getByText('工作流程记录', { exact: false }).click()
        await fixturePage.locator('.activity-batch > details > summary').click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: 'pnpm check' })
          .locator('summary')
          .click()
        await fixturePage
          .getByRole('button', { name: '加载后续输出' })
          .first()
          .click()
        await fixturePage
          .getByText('archived tail output', { exact: false })
          .first()
          .waitFor()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: 'pnpm test:coverage' })
          .locator('summary')
          .click()
        await fixturePage.getByRole('button', { name: '加载省略内容' }).click()
        await fixturePage
          .getByText('coverage head output', { exact: false })
          .first()
          .waitFor()
        await fixturePage.getByRole('button', { name: '加载省略内容' }).click()
        await fixturePage
          .getByText('omitted middle output', { exact: false })
          .first()
          .waitFor()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: 'cat /tmp/huge-build.log' })
          .locator('summary')
          .click()
        await fixturePage.getByRole('link', { name: '完整输出文件' }).waitFor()
        if (size === 'desktop') {
          await fixturePage
            .locator('.activity-tool')
            .filter({ hasText: 'pnpm test:coverage' })
            .evaluate(element => element.scrollIntoView({ block: 'start' }))
          await capture(
            fixturePage,
            `${size}-${fixture}-headtail.png`,
            `${size}-${fixture}-headtail`,
          )
        }
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: 'example.com/long-readme' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.preview-card')
          .getByRole('button', { name: '加载后续输出' })
          .click()
        await fixturePage
          .getByText('readme remainder', { exact: false })
          .first()
          .waitFor()
        await fixturePage
          .locator('.activity-changes > details > summary')
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: '查看了图片' })
          .locator('summary')
          .click()
        await fixturePage
          .locator('.activity-tool')
          .filter({ hasText: 'cat /tmp/huge-build.log' })
          .evaluate(element => element.scrollIntoView({ block: 'start' }))
      }
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
  await new Promise(resolveClose => modelGateway.close(resolveClose))
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
          source: 'web',
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
    if (body.channels?.length >= 2) break
    await wait(50)
  }
  const trayEventResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        dedupeKey: 'feature-review-tray',
        payload: { text: '调研托盘常驻显示方案' },
      }),
    },
  )
  if (trayEventResponse.status !== 202)
    throw new Error('Unable to seed UI review tray task')
  const trayDeadline = Date.now() + 30_000
  let trayReady = false
  while (Date.now() < trayDeadline) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/channels?userId=owner`,
    )
    const body = await response.json()
    const channel = body.channels?.find(
      item => item.title === '调研托盘常驻显示方案',
    )
    if (channel?.statusReason === 'awaiting_evidence') {
      trayReady = true
      break
    }
    await wait(50)
  }
  if (!trayReady) throw new Error('UI review tray task never opened up')
  const automationResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation',
        automation: {
          title: '晨间简报',
          prompt: '整理今天需要处理的事情。',
          schedule: { kind: 'interval', everySeconds: 3600 },
          target: { kind: 'new_task' },
        },
      }),
    },
  )
  if (automationResponse.status !== 201)
    throw new Error('Unable to seed UI review automation')
  const longPromptResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation-counting',
        automation: {
          title: '每分钟报数 1→10',
          prompt:
            '这是「从 1 数到 10」周期自动化的本次触发，是独立的机器输入。严格按以下步骤执行，禁止用 sleep/循环模拟周期等待：\n1. 读取状态文件 count-automation-state.json，字段为 {count, automationId, revision}。\n2. 将 count 加 1，写回状态文件。\n3. 报数：使用本次触发 Run 自己的环境变量与 capability 文件中的 claimToken，调用 POST /v1/runs/:runId/messages，text 只包含该数字本身。\n4. 若加 1 后的 count 等于 10，报数完成后取消本自动化。\n5. 若 count 小于 10，报数后直接结束本次 Run，把等待交给调度器。',
          schedule: { kind: 'interval', everySeconds: 60 },
          target: { kind: 'new_task' },
        },
      }),
    },
  )
  if (longPromptResponse.status !== 201)
    throw new Error('Unable to seed UI review counting automation')
  const countingAutomation = (await longPromptResponse.json()).automation
  // Park the counting automation far in the future so the seeded scheduler
  // cannot fire it during the capture, then end it for the delete fixture.
  const countingParkResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations/${countingAutomation.id}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation-counting-park',
        expectedRevision: countingAutomation.revision,
        automation: {
          title: '每分钟报数 1→10',
          prompt: countingAutomation.prompt,
          schedule: {
            kind: 'interval',
            everySeconds: 60,
            startsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          target: { kind: 'new_task' },
        },
      }),
    },
  )
  if (countingParkResponse.status !== 200)
    throw new Error('Unable to park UI review counting automation')
  const parkedCounting = (await countingParkResponse.json()).automation
  const countingCancelResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations/${countingAutomation.id}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation-counting-cancel',
        expectedRevision: parkedCounting.revision,
      }),
    },
  )
  if (countingCancelResponse.status !== 200)
    throw new Error('Unable to end UI review counting automation')
  // A dedicated history fixture fires once right away; its real run output
  // feeds the invocation summary shown in the history panel.
  const historyFixtureResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation-history',
        automation: {
          title: '触发记录示例',
          prompt: '报出下一个数字。',
          schedule: {
            kind: 'interval',
            everySeconds: 3600,
            startsAt: new Date(Date.now() + 500).toISOString(),
          },
          target: { kind: 'new_task' },
        },
      }),
    },
  )
  if (historyFixtureResponse.status !== 201)
    throw new Error('Unable to seed UI review history automation')
  const historyAutomation = (await historyFixtureResponse.json()).automation
  // Let the counting automation fire one real trigger through the seeded
  // scheduler + worker (its run summary feeds the history panel), then end
  // it before the second fire so no extra channel lingers in the sidebar.
  const historyDeadline = Date.now() + 90_000
  let countingHistory = { invocations: [] }
  while (Date.now() < historyDeadline) {
    const historyResponse = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/automations/${historyAutomation.id}/invocations?userId=owner&limit=25`,
    )
    countingHistory = await historyResponse.json()
    if (countingHistory.invocations.some(item => item.summary)) break
    await wait(250)
  }
  if (!countingHistory.invocations.some(item => item.summary))
    throw new Error(
      'UI review counting automation never produced a run summary',
    )
  const historyCancelResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/automations/${historyAutomation.id}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-automation-history-cancel',
        expectedRevision: historyAutomation.revision,
      }),
    },
  )
  if (historyCancelResponse.status !== 200)
    throw new Error('Unable to end UI review history automation')
  // Bump the two fixture channels back to the top of the recent-work
  // window (the trigger's channel is newer) so later captures stay
  // deterministic. Explicit taskId continuations resume the same Tasks
  // instead of creating duplicate channels.
  const bumpChannelsResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/channels?userId=owner`,
  )
  const bumpChannelsBody = await bumpChannelsResponse.json()
  for (const [index, title] of [
    '检查设置与工作详情是否一致',
    '为 Pegas 封板新的白底界面',
  ].entries()) {
    const bumpChannel = bumpChannelsBody.channels?.find(
      item => item.title === title,
    )
    if (!bumpChannel)
      throw new Error('Unable to find UI review channel to bump')
    const bumpResponse = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          type: 'user.message',
          source: 'web',
          dedupeKey: `feature-review-recent-bump-${String(index)}`,
          payload: { taskId: bumpChannel.taskId, text: '请确认当前进展。' },
        }),
      },
    )
    if (bumpResponse.status !== 202)
      throw new Error('Unable to bump UI review recent channels')
    const bumpDeadline = Date.now() + 25_000
    let bumpSettled = false
    while (Date.now() < bumpDeadline) {
      const timelineResponse = await fetch(
        `http://127.0.0.1:${String(apiPort)}/v1/channels/${bumpChannel.taskId}/timeline?userId=owner`,
      )
      const timelineBody = await timelineResponse.json()
      if (
        timelineBody.runs?.length > 1 &&
        timelineBody.runs.every(
          run => !['queued', 'running', 'waiting'].includes(run.status),
        )
      ) {
        bumpSettled = true
        break
      }
      await wait(100)
    }
    if (!bumpSettled) throw new Error('UI review channel bump never settled')
  }
  const memoryResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/memories`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'feature-review-memory',
        memory: {
          scope: 'global',
          category: 'preference',
          content: '我喜欢安静、白底、信息层级清楚的界面。',
          source: { kind: 'user_confirmation' },
        },
      }),
    },
  )
  if (memoryResponse.status !== 201)
    throw new Error('Unable to seed UI review memory')
  for (const [index, rule] of [
    {
      title: '产品设计优先给出具体界面方案',
      content: '涉及产品设计时，优先给出具体界面方案，而不是只给抽象建议。',
      enabled: true,
    },
    {
      title: '发布前先说明回滚路径',
      content: '涉及发布操作时，先列出回滚路径。',
      enabled: false,
    },
  ].entries()) {
    const ruleResponse = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/rules`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: `feature-review-rule-${String(index)}`,
          rule,
        }),
      },
    )
    if (ruleResponse.status !== 201)
      throw new Error('Unable to seed UI review work rule')
  }
  const behaviorResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/settings/behavior`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        expectedRevision: 0,
        customInstructions:
          '涉及产品设计时，优先给出具体界面方案；涉及发布操作时，先列出回滚路径。',
      }),
    },
  )
  if (behaviorResponse.status !== 200)
    throw new Error('Unable to seed UI review behavior preferences')
  const channelsResponse = await fetch(
    `http://127.0.0.1:${String(apiPort)}/v1/channels?userId=owner`,
  )
  const channelsBody = await channelsResponse.json()
  const firstChannel = channelsBody.channels?.find(
    item => item.title === '为 Pegas 封板新的白底界面',
  )
  if (!firstChannel) throw new Error('Unable to seed UI review attention')
  const attentionFixtures = [
    {
      dedupeKey: 'feature-review-attention-result',
      taskId: firstChannel.id,
      payload: {
        type: 'run.completed',
        taskId: firstChannel.id,
        text: '这是测试相关事情的入口。我目前可以处理你在这条对话里提出的测试类需求，例如：\n\n- **测试规划**：要测什么、验收条件、非目标、风险边界\n- **测试编写**：为某个 Feature 写自动化测试\n- **测试执行与门禁**：跑 `pnpm check`、`pnpm smoke`',
      },
    },
    {
      dedupeKey: 'feature-review-attention-approval',
      taskId: firstChannel.id,
      payload: {
        type: 'approval.required',
        taskId: firstChannel.id,
        approvalId: 'feature-review-approval',
        summary: '发布前需要确认影响范围',
        text: '完整审批说明：本次操作会影响候选版本的发布窗口。',
      },
    },
    {
      dedupeKey: 'feature-review-attention-input',
      taskId: firstChannel.id,
      payload: {
        type: 'goal.clarification_required',
        taskId: firstChannel.id,
        questions: ['发布窗口是哪个时间段？', '允许影响哪些用户？'],
        text: '发布窗口是哪个时间段？\n允许影响哪些用户？',
      },
    },
    {
      dedupeKey: 'feature-review-attention-failed',
      taskId: firstChannel.id,
      payload: {
        type: 'run.failed',
        taskId: firstChannel.id,
        error: '上游模型超时，请稍后重试。',
      },
    },
    {
      dedupeKey: 'feature-review-attention-delivery',
      payload: {
        type: 'run.failed',
        error: '通知投递结果未知，需要人工核对。',
      },
    },
  ]
  for (const fixture of attentionFixtures) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/outbox`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          channel: 'conversation',
          ...fixture,
        }),
      },
    )
    if (response.status !== 202)
      throw new Error('Unable to seed UI review attention')
  }
}

async function assertPickerPagination(
  page,
  label,
  { title = '选择模型', pinnedOptions = 0 } = {},
) {
  const picker = page.getByRole('dialog', { name: title })
  await picker.getByText('34 个可用').waitFor()
  const optionCount = await picker.getByRole('option').count()
  if (optionCount !== 30 + pinnedOptions)
    throw new Error(
      `${label}: expected ${String(30 + pinnedOptions)} options on page one, saw ${String(optionCount)}`,
    )
  await picker.getByRole('button', { name: '下一页' }).click()
  const tailCount = await picker.getByRole('option').count()
  if (tailCount !== 4 + pinnedOptions)
    throw new Error(
      `${label}: expected ${String(4 + pinnedOptions)} options on page two, saw ${String(tailCount)}`,
    )
  await picker.getByRole('option', { name: /Fixture Model 34/ }).waitFor()
  await picker.getByRole('button', { name: '上一页' }).click()
  await picker.getByRole('option', { name: /DeepSeek V4.1 Flash/ }).waitFor()
}

async function capture(page, name, label) {
  await assertGeometry(page, label)
  await page.evaluate(async () => {
    const images = [...globalThis.document.images]
    await Promise.all(
      images.map(image => {
        if (image.complete) return Promise.resolve()
        if (!image.isConnected || !image.getAttribute('src'))
          return Promise.resolve()
        return Promise.race([
          image.decode().catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 3000)),
        ])
      }),
    )
  })
  await page.screenshot({
    path: resolve(outputDirectory, name),
    fullPage: false,
    animations: 'disabled',
  })
}

async function assertGeometry(page, label) {
  const failures = await page.evaluate(async () => {
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
      '.page-header, .setting-summary-row, .compact-field-row, .artifact-row, .work-list > button, .attention-list article',
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
    if (globalThis.matchMedia('(pointer: coarse)').matches) {
      for (const control of globalThis.document.querySelectorAll(
        '.page-toolbar button, .attention-action, .attention-title, .filter-row button',
      )) {
        const rect = control.getBoundingClientRect()
        if (rect.width && (rect.width < 44 || rect.height < 44))
          out.push(
            `touch target is too small (${String(Math.round(rect.width))}x${String(Math.round(rect.height))})`,
          )
      }
    }
    for (const title of globalThis.document.querySelectorAll(
      '.attention-title',
    )) {
      const style = globalThis.getComputedStyle(title)
      if (style.webkitLineClamp !== '2')
        out.push('attention title is not clamped to two lines')
      if (title.scrollHeight > title.clientHeight + 1)
        out.push('attention title overflows its clamp')
    }
    for (const filters of globalThis.document.querySelectorAll(
      '.attention-filters',
    )) {
      const initialScrollLeft = filters.scrollLeft
      const style = globalThis.getComputedStyle(filters)
      if (
        filters.scrollWidth > filters.clientWidth + 1 &&
        style.overflowX !== 'auto'
      )
        out.push('overflowing filters cannot scroll')
      for (const control of filters.querySelectorAll('button')) {
        control.focus()
        const controlRect = control.getBoundingClientRect()
        const filtersRect = filters.getBoundingClientRect()
        if (
          controlRect.left < filtersRect.left - 1 ||
          controlRect.right > filtersRect.right + 1
        ) {
          control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          const settledRect = control.getBoundingClientRect()
          const settledFiltersRect = filters.getBoundingClientRect()
          if (
            settledRect.left < settledFiltersRect.left - 1 ||
            settledRect.right > settledFiltersRect.right + 1
          )
            out.push('focused filter remains outside its scrollport')
        }
      }
      filters.querySelector('button')?.focus()
      filters.scrollLeft = initialScrollLeft
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
      const multiline = composer.classList.contains('is-multiline')
      if (composerStyle.transitionProperty.includes('border-radius')) {
        await new Promise(resolve => setTimeout(resolve, 260))
      }
      const settledStyle = globalThis.getComputedStyle(composer)
      const radius = Number.parseFloat(settledStyle.borderRadius)
      if (multiline && radius > 26)
        out.push(
          `multiline composer is too pill-shaped (${settledStyle.borderRadius})`,
        )
      if (!multiline && radius < 100)
        out.push(
          `single-line composer is not a capsule (${settledStyle.borderRadius})`,
        )
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
      const modelTrigger = composer.querySelector('.composer-model-button')
      const triggerName = modelTrigger?.querySelector('strong')
      const triggerDetail = modelTrigger?.querySelector('small')
      if (modelTrigger && triggerName && triggerDetail) {
        const triggerRect = modelTrigger.getBoundingClientRect()
        const nameRect = triggerName.getBoundingClientRect()
        const detailRect = triggerDetail.getBoundingClientRect()
        if (detailRect.top < nameRect.bottom - 1)
          out.push('composer model trigger glues name and provider inline')
        if (
          nameRect.right > triggerRect.right + 1 ||
          detailRect.right > triggerRect.right + 1 ||
          detailRect.bottom > triggerRect.bottom + 1
        )
          out.push('composer model trigger text overflows its button')
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
    for (const search of globalThis.document.querySelectorAll(
      '.model-search, .composer-model-search',
    )) {
      const input = search.querySelector('input')
      if (!input) continue
      const inputStyle = globalThis.getComputedStyle(input)
      if (
        inputStyle.outlineStyle !== 'none' &&
        Number.parseFloat(inputStyle.outlineWidth) > 0
      )
        out.push('search input draws its own focus outline')
      if (Number.parseFloat(inputStyle.borderTopWidth) > 0)
        out.push('search input keeps an inner border')
      if (search.matches(':focus-within')) {
        await new Promise(resolveSettled =>
          globalThis.setTimeout(resolveSettled, 80),
        )
        const containerStyle = globalThis.getComputedStyle(search)
        if (
          containerStyle.borderTopColor === 'rgba(0, 0, 0, 0)' ||
          Number.parseFloat(containerStyle.borderTopWidth) === 0
        )
          out.push('focused search container has no visible border')
      }
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
