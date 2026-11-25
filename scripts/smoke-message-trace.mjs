import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

import { createControlPlane } from '../dist/control-plane/server.js'
import { ModelTaskRouter } from '../dist/router/router.js'
import { PegasStore } from '../dist/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../dist/worker/processor.js'

const store = new PegasStore(':memory:')
const server = createControlPlane({ store, webRoot: resolve('dist/web') })
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${String(server.address().port)}`
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() =>
    localStorage.setItem('pegas-setup-complete', 'true'),
  )
  const firstSnapshot = page.waitForResponse(response =>
    response.url().includes('/v1/outbox?'),
  )
  await page.goto(base)
  await firstSnapshot
  let delayOutbox = false
  let releaseOutbox
  let outboxGate
  await page.route(/\/v1\/outbox\?/u, async route => {
    if (delayOutbox) await outboxGate
    await route.continue()
  })

  function waitForRenderedReceipt() {
    return page.waitForResponse(
      response =>
        response.url().endsWith('/v1/observability/browser-receipts') &&
        response.ok() &&
        response.request().postData()?.includes('"phase":"rendered"'),
    )
  }

  async function drive({ text, output, failRoute }) {
    const submitted = page.waitForResponse(
      response =>
        response.url() === `${base}/v1/events` &&
        response.request().method() === 'POST',
    )
    await page.locator('#pegas-message').fill(text)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const response = await submitted
    assert.equal(response.status(), 202)
    const { event } = await response.json()
    const router = new ModelTaskRouter({
      provider: {
        name: 'fixture-model',
        async generateJson() {
          if (failRoute) throw new Error('fixture unavailable')
          return {
            kind: 'create_task',
            taskId: '',
            title: text,
            goal: text,
            reason: 'fixture decision',
          }
        },
      },
      observeCall: (eventId, call) =>
        store.recordMessageTraceRouterCall(eventId, call),
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(router, 'fixture'),
      'worker',
    )
    const claim = store.claimNextRun('worker')
    assert.ok(claim)
    await executeClaimedRun(
      store,
      {
        name: 'fixture',
        async execute(input) {
          input.onProgress?.({
            type: 'tool_call',
            callId: 'shell-1',
            tool: 'bash',
            input: JSON.stringify({ command: 'pwd' }),
          })
          input.onProgress?.({
            type: 'tool_result',
            callId: 'shell-1',
            status: 'completed',
            result: 'fixture tool output',
          })
          return { executorRef: 'fixture-session', output }
        },
      },
      claim,
      'worker',
      process.cwd(),
      new AbortController().signal,
      base,
    )
    return event.id
  }

  const normalRendered = waitForRenderedReceipt()
  const normal = await drive({
    text: '检查调用链的正常路径',
    output: '调用链正常路径已完成',
    failRoute: false,
  })
  await page
    .locator('article')
    .filter({ hasText: '调用链正常路径已完成' })
    .waitFor()
  await normalRendered
  await page
    .locator('article')
    .filter({ hasText: '检查调用链的正常路径' })
    .getByRole('button', { name: '查看调用链' })
    .click()
  const drawer = page.getByRole('dialog', { name: '调用链' })
  await drawer.getByText('模型归类', { exact: true }).waitFor()
  await drawer.getByRole('button', { name: '刷新', exact: true }).focus()
  await page.keyboard.press('Tab')
  await drawer.locator('summary:focus').waitFor()
  await drawer.getByText('执行 · fixture', { exact: true }).click()
  await drawer.getByRole('button', { name: '加载工具输入和输出' }).click()
  const tool = drawer.locator('summary').filter({ hasText: 'pwd' }).first()
  await tool.waitFor()
  await tool.click()
  await drawer.getByText('fixture tool output', { exact: true }).waitFor()
  assert.ok(store.messageTrace(normal, 'owner').results[0]?.renderedAt)
  await drawer.getByRole('button', { name: '关闭详情' }).click()

  await page
    .locator('article.is-user')
    .filter({ hasText: '检查调用链的正常路径' })
    .getByRole('button', { name: '查看工作详情' })
    .click()
  const work = page.getByRole('dialog', { name: '工作详情' })
  await work.getByRole('button', { name: '查看调用链' }).click()
  await drawer.getByText(normal, { exact: false }).waitFor()
  await drawer.getByRole('button', { name: '返回事情详情' }).click()
  await work.getByRole('heading', { name: '检查调用链的正常路径' }).waitFor()
  await work.getByRole('button', { name: '关闭详情' }).click()

  delayOutbox = true
  outboxGate = new Promise(done => {
    releaseOutbox = done
  })
  const delayed = await drive({
    text: '检查归类兜底和延迟刷新',
    output: '调用链延迟路径已完成',
    failRoute: true,
  })
  const before = store.messageTrace(delayed, 'owner')
  assert.equal(before.calls[0].outcome, 'provider_error')
  assert.equal(before.decision.kind, 'create_task')
  const result = before.results.find(
    message => message.type === 'run.completed',
  )
  assert.ok(result)
  assert.equal(result.fetchedAt, undefined)
  assert.equal(result.renderedAt, undefined)

  const delayedRendered = waitForRenderedReceipt()
  delayOutbox = false
  releaseOutbox()
  await page
    .locator('article')
    .filter({ hasText: '调用链延迟路径已完成' })
    .waitFor()
  await delayedRendered
  await page
    .locator('article')
    .filter({ hasText: '检查归类兜底和延迟刷新' })
    .getByRole('button', { name: '查看调用链' })
    .click()
  await drawer.getByText(/规则兜底/).waitFor()
  await drawer.getByText('完成卡片', { exact: true }).click()
  await drawer.getByText(/首次渲染/).waitFor()
  assert.ok(
    store
      .messageTrace(delayed, 'owner')
      .results.find(message => message.id === result.id)?.renderedAt,
  )
  console.log(
    'Message trace smoke passed (normal tool output, router fallback, delayed browser render).',
  )
} finally {
  await browser?.close()
  await new Promise(done => server.close(done))
  store.close()
}
