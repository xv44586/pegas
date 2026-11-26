import assert from 'node:assert/strict'

// Isolated API fixtures exercise deployed UI without sending user work or decisions.
export async function verifyDetailClosure(page, capture, size) {
  const base = new URL('/', page.url()).href
  const taskId = 'detail-closure-task'
  const at = new Date().toISOString()
  const channel = {
    id: taskId,
    taskId,
    userId: 'owner',
    title: '语音输入方案调研',
    goal: '比较语音输入方案',
    status: 'completed',
    canResume: true,
    canStop: false,
    workerIconId: 'computer',
    createdAt: at,
    updatedAt: at,
    workflow: { state: 'delivered', resultMessageId: 'detail-result' },
  }
  const candidates = [
    '比较方案体积',
    '分析内存使用',
    '比较识别效果',
    '查看实现步骤',
  ]
  const message = (id, payload) => ({
    id,
    taskId,
    userId: 'owner',
    status: 'sent',
    createdAt: at,
    payload,
  })
  let messages = [
    {
      ...message('detail-result', {
        type: 'run.completed',
        text: '调研已完成，建议先验证本地语音识别。',
        followUps: candidates,
      }),
      projection: { lane: 'work', weight: 'card' },
    },
    message('detail-failure', {
      type: 'run.failed',
      error: '历史失败，已有后续结果',
    }),
    message('detail-stale', {
      type: 'action.outcome_unknown',
      actionId: 'settled-action',
      text: '已经核对的旧待办',
    }),
    message('detail-settled', {
      type: 'action.reconciled',
      actionId: 'settled-action',
      resolution: 'failed',
      text: '动作已核对',
    }),
    message('detail-pending', {
      type: 'approval.required',
      approvalId: 'still-pending',
      text: '仍需独立确认',
    }),
  ]
  const runs = [
    {
      id: 'detail-run',
      taskId,
      executor: 'dsh',
      status: 'completed',
      attempts: 1,
      input: channel.goal,
      output: messages[0].payload.text,
      createdAt: at,
      updatedAt: at,
    },
  ]
  const events = []
  const posts = []
  const reads = []
  const handler = async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const respond = json => route.fulfill({ json })
    if (path === '/v1/events' && request.method() === 'POST') {
      const body = request.postDataJSON()
      posts.push(body)
      const event = {
        ...body,
        id: `detail-event-${posts.length}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      events.push(event)
      return route.fulfill({ status: 202, json: { event } })
    }
    if (path.endsWith('/read')) {
      const id = path.split('/')[3]
      const found = messages.find(item => item.id === id)
      assert.ok(found, 'Only fixture messages may be marked read')
      reads.push(id)
      const updated = { ...found, readAt: new Date().toISOString() }
      messages = messages.map(item => (item.id === id ? updated : item))
      return respond({ message: updated })
    }
    if (path === '/v1/observability/browser-receipts')
      return respond({
        recorded: request.postDataJSON().receipts.map(() => true),
      })
    if (request.method() !== 'GET')
      throw new Error(`Unexpected mutation: ${path}`)
    if (path === '/v1/events') return respond({ events })
    if (path === '/v1/channels') return respond({ channels: [channel] })
    if (path === '/v1/runs') return respond({ runs })
    if (path === '/v1/outbox') return respond({ messages })
    if (path.endsWith('/timeline'))
      return respond({ channel, events, messages, runs })
    if (path.endsWith('/delivery'))
      return respond({ artifacts: [], evidence: [], continuation: {} })
    if (path.endsWith('/collaborations')) return respond({ relations: [] })
    if (path.endsWith('/approval-rules')) return respond({ rules: [] })
    if (path.endsWith('/worker-profile/changes'))
      return respond({ changes: [] })
    if (path.endsWith('/worker-profile')) {
      const profile = {
        id: `worker-profile:${taskId}`,
        taskId,
        revision: 1,
        modelMode: 'inherit',
        createdAt: at,
        updatedAt: at,
      }
      return respond({
        profile,
        effective: {
          profile,
          source: 'global',
          modelMode: 'profile',
          modelRef: 'profile',
        },
      })
    }
    return route.continue()
  }
  await page.route('**/v1/**', handler)
  const nav = name =>
    page
      .getByLabel(size === 'mobile' ? '移动端主导航' : '主导航')
      .getByRole('button', { name })
  try {
    await page.goto(base)
    await page
      .getByRole('textbox', { name: '给 Pegas 发消息' })
      .fill('保留公共草稿')
    assert.equal(
      await page.getByRole('button', { name: '解释这次结果' }).count(),
      0,
    )
    await nav(/待你处理/).click()
    await page
      .locator('.main-canvas')
      .getByRole('button', { name: '待你处理 1', exact: true })
      .waitFor()
    assert.equal(await page.getByText('已经核对的旧待办').count(), 0)
    await page
      .getByRole('button', {
        name: '最新：调研已完成，建议先验证本地语音识别。',
      })
      .click()
    const detail = page.getByRole('dialog', { name: '工作详情' })
    const reply = detail.locator('[data-detail-reply]')
    await reply.getByRole('button', { name: candidates[0] }).waitFor()
    for (const name of ['解释这次结果', '继续执行', '新建相关事情'])
      assert.equal(
        await detail.getByRole('button', { name, exact: true }).count(),
        0,
      )
    await reply.hover()
    const editor = reply.getByRole('textbox', { name: '回复内容' })
    await editor.waitFor({ state: 'visible' })
    await editor.fill('还有哪些限制？')
    const accepted = page.waitForResponse(
      response =>
        response.url().endsWith('/v1/events') &&
        response.request().method() === 'POST',
    )
    await reply.getByRole('button', { name: candidates[0] }).click()
    await accepted
    assert.deepEqual(posts[0].payload, {
      text: candidates[0],
      replyToMessageId: 'detail-result',
    })
    await page.waitForFunction(
      () =>
        !globalThis.document.querySelector('[data-detail-reply] textarea')
          ?.disabled,
    )
    assert.equal(await editor.inputValue(), '还有哪些限制？')
    const acceptedCustom = page.waitForResponse(
      response =>
        response.url().endsWith('/v1/events') &&
        response.request().method() === 'POST',
    )
    await editor.press('Enter')
    await acceptedCustom
    assert.deepEqual(posts[1].payload, {
      text: '还有哪些限制？',
      replyToMessageId: 'detail-result',
    })
    await page.waitForFunction(
      () =>
        !globalThis.document.querySelector('[data-detail-reply] textarea')
          ?.disabled,
    )
    assert.deepEqual(
      new Set(reads),
      new Set(['detail-result', 'detail-failure']),
    )
    assert.equal(reads.length, 2)
    assert.equal(await reply.getByRole('listitem').count(), 4)
    const bounds = await editor.boundingBox()
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= page.viewportSize().width,
    )
    await capture(page, `${size}-detail-closure.png`, `${size}-detail-closure`)
    await detail.getByRole('button', { name: '关闭详情' }).click()
    await page.getByText(/1 条未读/).waitFor()
    await nav(/^对话$/).click()
    assert.equal(
      await page.getByRole('textbox', { name: '给 Pegas 发消息' }).inputValue(),
      '保留公共草稿',
    )
    for (const [index, text] of [candidates[0], '还有哪些限制？'].entries()) {
      const content = page.locator(
        `[data-message-id="detail-event-${index + 1}"] .message-content`,
      )
      await content.waitFor()
      assert.equal(await content.innerText(), text)
    }
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).fill('')
    console.log(
      `${size} detail closure passed: exact replies, Chat messages, read state, resolved todo, four candidates`,
    )
  } finally {
    await page.unroute('**/v1/**', handler)
    await page.goto(base)
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  }
}
