import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

/** Fixture-only browser evidence through the production App and API adapters. */
export async function verifyTaskConversation(hostPage, capture, size) {
  const page = await hostPage.context().newPage()
  await page.setViewportSize(hostPage.viewportSize())
  page.setDefaultTimeout(12000)
  const date = new Date(Date.now() - 120000).toISOString()
  const taskId = 'conversation-review'
  const channel = {
    id: taskId,
    taskId,
    userId: 'owner',
    originEventId: 'history-0',
    title: '梳理季度经营数据',
    goal: '整理本季度收入与成本，形成可审查的分析结果。',
    status: 'completed',
    canResume: true,
    canStop: false,
    workerIconId: 'computer',
    createdAt: date,
    updatedAt: date,
    latestActivityAt: date,
  }
  const events = Array.from({ length: 205 }, (_, index) => ({
    id: `history-${index}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    status: 'processed',
    payload: {
      text:
        index === 204
          ? '请把主要变化和还需要核对的数据整理出来。'
          : `历史补充 ${index + 1}：按原始数据核对季度统计口径。`,
    },
    createdAt: date,
  }))
  const messages = [
    {
      id: 'review-answer',
      userId: 'owner',
      taskId,
      status: 'sent',
      createdAt: new Date().toISOString(),
      payload: {
        type: 'agent.message',
        text: '已经整理好本季度的收入与成本变化。\n\n收入增长主要来自复购，毛利率受产品组合影响。渠道费用仍有两笔记录需要核对，当前结论已标明这一限制。\n\n你可以继续补充材料，或告诉我下一步要重点看哪一部分。',
        followUps: ['继续分析毛利率变化', '列出仍需核对的数据'],
      },
      projection: { lane: 'say', weight: 'inline' },
    },
  ]
  const run = {
    id: 'conversation-run',
    retryOfRunId: 'conversation-failed',
    taskId,
    executor: 'dsh',
    status: 'completed',
    attempts: 1,
    input: channel.goal,
    createdAt: date,
    updatedAt: date,
    executionContext: {
      executor: 'dsh',
      model: 'deepseek-v4.1-flash',
      workspace: '/review/quarterly-analysis',
    },
  }
  const failedRun = {
    ...run,
    id: 'conversation-failed',
    retryOfRunId: undefined,
    status: 'failed',
    createdAt: new Date(Date.parse(date) - 60000).toISOString(),
    updatedAt: new Date(Date.parse(date) - 60000).toISOString(),
  }
  const activityEntries = [
    {
      seq: 1,
      kind: 'tool_call',
      tool: 'todo_write',
      callId: 'plan-1',
      status: 'completed',
      label: '制定核对计划',
      semantic: {
        kind: 'todo',
        items: [
          { content: '核对季度数据口径', status: 'completed' },
          { content: '分析收入与毛利率变化', status: 'completed' },
          { content: '列出尚待核实的数据', status: 'completed' },
        ],
      },
    },
    {
      seq: 2,
      kind: 'thinking',
      status: 'completed',
      label: '先核对口径，再形成结论',
      detail:
        '收入按已确认订单统计；渠道费用有两笔缺少凭据，因此将其标记为待核实，暂不计入确定结论。',
    },
    {
      seq: 3,
      kind: 'tool_call',
      tool: 'read',
      callId: 'call-1',
      status: 'completed',
      label: '读取季度数据',
      semantic: {
        kind: 'file_read',
        path: 'quarterly.csv',
        preview: '收入,成本\n120000,72000',
        lineCount: 2,
      },
    },
    {
      seq: 4,
      kind: 'tool_call',
      tool: 'bash',
      callId: 'check-1',
      status: 'completed',
      label: '重新校验数据',
      semantic: {
        kind: 'shell',
        command: 'python check_quarterly.py quarterly.csv',
        output: '核对完成：收入 120000，成本 72000；2 笔渠道费用待核实。',
        exitCode: 0,
      },
    },
  ].map(entry => ({ ...entry, createdAt: date, updatedAt: date }))
  const profile = {
    id: 'conversation-profile',
    taskId,
    revision: 1,
    modelMode: 'inherit',
    permissionMode: 'inherit',
    createdAt: date,
    updatedAt: date,
  }
  const goal = {
    id: 'conversation-goal',
    taskId,
    revision: 1,
    desiredOutcome: channel.goal,
    successCriteria: [
      {
        criterionId: 'sources',
        observableStatement: '收入、成本和毛利率均注明数据口径。',
      },
      {
        criterionId: 'limits',
        observableStatement: '未核实的数据单独标注，不作为确定结论。',
      },
    ],
    nonGoals: ['不修改原始财务记录。'],
  }
  const posts = []
  let failHistory = false
  try {
    await page.route('**/v1/channels?*', route =>
      route.fulfill({ json: { channels: [channel] } }),
    )
    await page.route(`**/v1/channels/${taskId}/timeline?*`, route => {
      if (failHistory)
        return route.fulfill({ status: 503, json: { message: '读取暂时失败' } })
      const cursor = new URL(route.request().url()).searchParams.get('cursor')
      return route.fulfill({
        json: {
          channel,
          events: cursor ? events.slice(200) : events.slice(0, 200),
          messages,
          runs: [failedRun, run],
          ...(!cursor ? { nextCursor: 'history-199' } : {}),
        },
      })
    })
    await page.route(`**/v1/tasks/${taskId}/delivery?*`, route =>
      route.fulfill({ json: { goal, artifacts: [], evidence: [] } }),
    )
    await page.route(`**/v1/tasks/${taskId}/worker-profile?*`, route =>
      route.fulfill({
        json: {
          profile,
          effective: {
            profile,
            source: 'global',
            modelMode: 'profile',
            modelRef: 'profile',
            permissionTier: 'standard',
            permissionSource: 'global',
          },
        },
      }),
    )
    await page.route(`**/v1/tasks/${taskId}/worker-profile/changes?*`, route =>
      route.fulfill({ json: { changes: [] } }),
    )
    await page.route(`**/v1/tasks/${taskId}/approval-rules?*`, route =>
      route.fulfill({ json: { rules: [] } }),
    )
    await page.route('**/v1/runs/conversation-run/activity?*', route =>
      route.fulfill({
        json: {
          runId: run.id,
          taskId,
          entries: activityEntries,
          truncated: false,
          totalEntries: activityEntries.length,
        },
      }),
    )
    await page.route('**/v1/runs/conversation-failed/activity?*', route =>
      route.fulfill({
        json: {
          runId: failedRun.id,
          taskId,
          totalEntries: 1,
          truncated: false,
          entries: [
            {
              seq: 1,
              kind: 'tool_call',
              tool: 'bash',
              callId: 'failed-check',
              status: 'error',
              label: '校验原始数据',
              createdAt: failedRun.createdAt,
              updatedAt: failedRun.updatedAt,
              semantic: {
                kind: 'shell',
                command: 'python check_quarterly.py missing.csv',
                exitCode: 1,
                output:
                  'FileNotFoundError: missing.csv。确认正确文件为 quarterly.csv 后重试。',
              },
            },
          ],
        },
      }),
    )
    await page.route('**/v1/events/history-204/trace?*', route =>
      route.fulfill({
        status: 503,
        json: { message: '调用链暂时不可用，请刷新重试。' },
      }),
    )
    await page.route('**/v1/events', route => {
      const body = route.request().postDataJSON()
      posts.push(body)
      const event = {
        ...body,
        id: `accepted-${posts.length}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
      }
      events.push(event)
      return route.fulfill({ status: 202, json: { event, inserted: true } })
    })
    const url = new URL(hostPage.url())
    url.search = ''
    await page.goto(url.href)
    await page
      .getByRole('textbox', { name: '给 Pegas 发消息' })
      .fill('主聊天的独立草稿')
    if (size === 'desktop') {
      await page
        .getByRole('button', { name: channel.title, exact: true })
        .click()
    } else {
      url.searchParams.set('task', taskId)
      await page.goto(url.href)
    }
    const composer = page.getByRole('textbox', { name: '就这件事继续聊天' })
    await composer.waitFor()
    const require = createRequire(import.meta.url)
    await page.addScriptTag({
      content: readFileSync(require.resolve('axe-core'), 'utf8'),
    })
    assert.equal(
      await page.locator('[data-message-id="history-204"]').count(),
      1,
    )
    assert.equal(
      await page.getByRole('group', { name: '进行中的事情' }).count(),
      0,
    )
    assert.equal(
      await page.getByRole('button', { name: '查看工作详情' }).count(),
      0,
    )
    assert.equal(
      await page
        .getByRole('button', { name: '查看调用链', exact: true })
        .count(),
      0,
    )
    await capture(
      page,
      `${size}-task-conversation.png`,
      `${size}-task-conversation`,
    )
    assert.equal(
      await page.getByRole('button', { name: '全局搜索', exact: true }).count(),
      0,
    )
    assert.equal(
      await page.getByRole('button', { name: /切换到.*外观/ }).count(),
      0,
    )
    await composer.fill('搜索期间保留的草稿')
    const searchToggle = page.getByRole('button', {
      name: '搜索当前事情',
      exact: true,
    })
    await searchToggle.click()
    const searchDialog = page.getByRole('dialog', {
      name: '搜索当前事情',
      exact: true,
    })
    const searchInput = searchDialog.getByRole('searchbox')
    await searchInput.press('Control+k')
    assert.equal(
      await page.getByRole('dialog', { name: '全局搜索', exact: true }).count(),
      0,
    )
    await searchInput.fill('历史补充 1：')
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await globalThis.axe.run('[role="dialog"]', {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
          })
        ).violations.map(item => ({
          id: item.id,
          nodes: item.nodes.map(node => node.failureSummary),
        })),
      ),
      [],
    )
    await capture(page, `${size}-task-search.png`, `${size}-task-search`)
    await searchInput.press('Tab')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        globalThis.document.activeElement?.getAttribute('data-message-id') ===
        'history-0',
    )
    const original = page.locator('[data-message-id="history-0"]')
    const rowBox = await original.boundingBox()
    const scrollBox = await page.locator('.conversation-scroll').boundingBox()
    assert.ok(
      rowBox &&
        scrollBox &&
        rowBox.y >= scrollBox.y &&
        rowBox.y < scrollBox.y + scrollBox.height,
    )
    assert.equal(await composer.inputValue(), '搜索期间保留的草稿')
    await searchToggle.click()
    await searchInput.fill('不存在的关键词')
    await searchDialog.getByText('当前事情中没有匹配的消息。').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () =>
        globalThis.document.activeElement?.getAttribute('aria-label') ===
        '搜索当前事情',
    )
    for (const text of ['请再核对一次数据来源', '只保留可以核实的结论']) {
      await composer.fill(text)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.waitForFunction(
        () => globalThis.document.querySelector('#pegas-message')?.value === '',
      )
    }
    assert.equal(posts.length, 2)
    assert.ok(posts.every(body => body.payload.taskId === taskId))
    if (size === 'mobile')
      await page.getByRole('button', { name: '展开事情信息' }).click()
    for (const [tab, file] of [
      ['概览', 'overview'],
      ['交付', 'delivery'],
      ['执行记录', 'execution'],
      ['设置', 'settings'],
    ]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      if (tab === '执行记录') {
        const latest = page
          .locator('details')
          .filter({
            has: page
              .locator('summary')
              .filter({ hasText: '执行过程 · 最新一次' }),
          })
          .first()
        assert.equal(await latest.getAttribute('open'), '')
        await latest.locator('.activity-timeline').waitFor()
        await latest
          .locator('summary')
          .filter({ hasText: '更新任务清单' })
          .click()
        await latest.locator('summary').filter({ hasText: '思考' }).click()
        await latest.getByText('核对季度数据口径', { exact: true }).waitFor()
        await capture(
          page,
          `${size}-task-process-plan.png`,
          `${size}-task-process-plan`,
        )
        await latest.locator('summary').filter({ hasText: '已读取' }).click()
        await latest
          .locator('summary')
          .filter({ hasText: 'python check_quarterly.py quarterly.csv' })
          .click()
        await latest.locator('.shell-output').scrollIntoViewIfNeeded()
        await capture(
          page,
          `${size}-task-process-tools.png`,
          `${size}-task-process-tools`,
        )
        const history = page
          .locator('summary')
          .filter({ hasText: '执行过程 · 历史执行' })
        await history.click()
        const failed = page.locator('details').filter({ has: history }).first()
        await failed.locator('.activity-timeline').waitFor()
        await failed
          .locator('summary')
          .filter({ hasText: 'python check_quarterly.py missing.csv' })
          .click()
        await failed.locator('.shell-output').scrollIntoViewIfNeeded()
        await capture(
          page,
          `${size}-task-process-retry.png`,
          `${size}-task-process-retry`,
        )
        await history.click()
        await latest
          .locator('summary')
          .filter({ hasText: '执行过程 · 最新一次' })
          .scrollIntoViewIfNeeded()
        await page.locator('summary').filter({ hasText: '消息调用链' }).click()
      }
      if (tab === '设置')
        await page
          .getByRole('combobox', { name: '执行模型', exact: true })
          .waitFor()
      await capture(page, `${size}-task-${file}.png`, `${size}-task-${file}`)
    }
    const violations = await page.evaluate(
      async () =>
        (
          await globalThis.axe.run(globalThis.document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
          })
        ).violations,
    )
    assert.deepEqual(
      violations.map(item => ({
        id: item.id,
        nodes: item.nodes.map(node => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
      [],
    )
    // Close and reopen using both the explicit close button and the header toggle.
    await page
      .getByRole('button', { name: '关闭事情信息', exact: true })
      .click()
    const toggle = page.getByRole('button', {
      name: '展开事情信息',
      exact: true,
    })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await page.waitForFunction(() =>
      globalThis.document.activeElement?.matches('[data-task-info]'),
    )
    await capture(
      page,
      `${size}-task-sidebar-closed.png`,
      `${size}-task-sidebar-closed`,
    )
    await toggle.press('Enter')
    assert.equal(
      await page
        .getByRole('tab', { name: '设置', exact: true })
        .getAttribute('aria-selected'),
      'true',
    )
    if (size === 'desktop') {
      await page
        .getByRole('button', { name: '收起事情信息', exact: true })
        .click()
      await toggle.click()
      assert.equal(
        await page
          .getByRole('tab', { name: '设置', exact: true })
          .getAttribute('aria-selected'),
        'true',
      )
    }
    await page.getByRole('tab', { name: '执行记录', exact: true }).click()
    await page.locator('summary').filter({ hasText: '消息调用链' }).click()
    const traceRequest = page.waitForRequest(
      request =>
        new URL(request.url()).pathname === '/v1/events/history-204/trace',
    )
    await page
      .getByRole('button', {
        name: '查看调用链：请把主要变化和还需要核对的数据整理出来。',
        exact: true,
      })
      .click()
    await traceRequest
    const traceDialog = page.getByRole('dialog', {
      name: '调用链',
      exact: true,
    })
    await traceDialog.getByRole('alert').waitFor()
    await page.keyboard.press('Escape')
    await traceDialog.waitFor({ state: 'hidden' })
    if (size === 'mobile') {
      await toggle.click()
      assert.equal(
        await page
          .getByRole('tab', { name: '执行记录', exact: true })
          .getAttribute('aria-selected'),
        'true',
      )
      await page.keyboard.press('Escape')
      await page.waitForFunction(() =>
        globalThis.document.activeElement?.matches('[data-task-info]'),
      )
    }
    await composer.fill('切换后仍保留的事情草稿')
    if (size === 'desktop') {
      await page.goBack()
      assert.equal(
        await page
          .getByRole('textbox', { name: '给 Pegas 发消息' })
          .inputValue(),
        '主聊天的独立草稿',
      )
      await page.goForward()
      assert.equal(await composer.inputValue(), '切换后仍保留的事情草稿')
    }
    failHistory = true
    await page.reload()
    await page.getByRole('button', { name: '重新读取事情历史' }).click()
    await capture(
      page,
      `${size}-task-history-error.png`,
      `${size}-task-history-error`,
    )
    failHistory = false
    await page.getByRole('button', { name: '重新读取事情历史' }).click()
    await composer.waitFor()
    assert.equal(await composer.inputValue(), '切换后仍保留的事情草稿')
    channel.title =
      '季度经营分析与数据核对 · ' + 'quarterly_reconciliation_'.repeat(6)
    await page.reload()
    await composer.waitFor()
    await capture(
      page,
      `${size}-task-long-title.png`,
      `${size}-task-long-title`,
    )
    console.log(
      `Task conversation verified: ${size}, 205 inputs, fixed sends, four tabs, scoped search + keyboard navigation, plans/tools/retry process, trace entry, sidebar close/reopen + focus, history recovery, zero a11y violations`,
    )
  } finally {
    await page.close()
  }
}
