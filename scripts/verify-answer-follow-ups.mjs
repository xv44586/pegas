import assert from 'node:assert/strict'

// Fixture data through the actual Conversation renderer; never user data.
export async function verifyAnswerFollowUps(page, capture, size) {
  const routePattern = '**/v1/outbox?*'
  const question = '哪些因素推动了本季度收入增长？'
  const questions = [
    question,
    '比较两个季度的毛利率与成本结构',
    '哪些假设会改变结论？',
    '进一步分析复购率的变化',
  ]
  const posts = []
  const acceptedEvents = []
  const replyAt = new Date(Date.now() - 1000).toISOString()
  let streaming = true
  await page.route('**/v1/events', route => {
    if (route.request().method() !== 'POST') return route.continue()
    posts.push(route.request().postDataJSON())
    const event = {
      ...posts.at(-1),
      id: `followup-event-${posts.length}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    acceptedEvents.push(event)
    return route.fulfill({ status: 202, json: { event } })
  })
  await page.route('**/v1/events?*', async route => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      json: { ...body, events: [...body.events, ...acceptedEvents] },
    })
  })
  await page.route('**/v1/channels?*', async route => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      json: {
        ...body,
        channels: [
          ...body.channels,
          {
            id: 'followup-conversation',
            taskId: 'followup-conversation',
            userId: 'owner',
            title: '季度收入分析',
            goal: '分析季度收入变化',
            status: 'completed',
            canResume: true,
            canStop: false,
            workerIconId: 'computer',
            createdAt: replyAt,
            updatedAt: replyAt,
          },
        ],
      },
    })
  })
  await page.route(routePattern, route =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'followup-review',
            userId: 'owner',
            taskId: 'followup-conversation',
            status: 'sent',
            createdAt: replyAt,
            payload: {
              type: 'agent.message',
              text: '本季度收入同比增长，主要来自产品组合和复购率的变化。',
              streaming,
              followUps: questions,
            },
            projection: { lane: 'say', weight: 'inline' },
          },
        ],
      },
    }),
  )
  try {
    await page.reload()
    await page
      .getByText('本季度收入同比增长，主要来自产品组合和复购率的变化。')
      .waitFor()
    assert.equal(await page.getByRole('button', { name: question }).count(), 0)
    streaming = false
    await page.reload()
    const first = page.getByRole('button', { name: question })
    await first.waitFor()
    await first.click({ trial: true })
    await first.focus()
    await page.keyboard.press('Tab')
    const second = page.getByRole('button', {
      name: '比较两个季度的毛利率与成本结构',
    })
    assert.equal(
      await second.evaluate(el => el === globalThis.document.activeElement),
      true,
    )
    await page.keyboard.press('Shift+Tab')
    assert.equal(
      await first.evaluate(el => el === globalThis.document.activeElement),
      true,
    )
    const composer = page.getByRole('textbox', { name: '给 Pegas 发消息' })
    await composer.fill('保留用户正在写的问题')
    const article = first.locator('xpath=ancestor::article')
    assert.equal(
      await article
        .getByRole('list', { name: '继续深入' })
        .getByRole('button')
        .count(),
      4,
    )
    assert.equal(
      await article
        .getByText('发送到「季度收入分析」', { exact: true })
        .count(),
      0,
    )
    const editor = article.getByRole('textbox', { name: '回复内容' })
    await page.mouse.move(0, 0)
    const canHover = await page.evaluate(
      () => globalThis.matchMedia('(hover: hover)').matches,
    )
    if (canHover) {
      assert.equal(await editor.isVisible(), false)
      await first.hover()
      await editor.waitFor({ state: 'visible' })
    }
    await editor.click()
    const inputBounds = await editor.boundingBox()
    const sendBounds = await article
      .getByRole('button', { name: '发送回复' })
      .boundingBox()
    assert.ok(inputBounds && sendBounds)
    assert.ok(
      sendBounds.y + sendBounds.height <=
        inputBounds.y + inputBounds.height + 1,
      'Inline send button must stay inside its input on touch devices',
    )
    await editor.fill('具体展开复购率的影响')
    await first.focus()
    const accepted = page.waitForResponse(
      response =>
        response.url().endsWith('/v1/events') &&
        response.request().method() === 'POST',
    )
    await first.press('Enter')
    await accepted
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].payload, {
      text: question,
      replyToMessageId: 'followup-review',
    })
    assert.equal(await composer.inputValue(), '保留用户正在写的问题')
    assert.equal(await editor.inputValue(), '具体展开复购率的影响')
    await page.locator('[data-message-id="followup-event-1"]').waitFor()
    assert.equal(
      await page
        .locator('[data-message-id="followup-event-1"] .message-content')
        .innerText(),
      question,
    )
    await first.press('Enter')
    assert.equal(posts.length, 1)
    const customAccepted = page.waitForResponse(
      response =>
        response.url().endsWith('/v1/events') &&
        response.request().method() === 'POST',
    )
    await editor.press('Enter')
    await customAccepted
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[1].payload, {
      text: '具体展开复购率的影响',
      replyToMessageId: 'followup-review',
    })
    assert.equal(await composer.inputValue(), '保留用户正在写的问题')
    await page.locator('[data-message-id="followup-event-2"]').waitFor()
    assert.equal(
      await page
        .locator('[data-message-id="followup-event-2"] .message-content')
        .innerText(),
      '具体展开复购率的影响',
    )
    assert.equal(
      await page
        .locator('.message-row.is-user')
        .filter({ hasText: question })
        .count(),
      1,
    )
    await article.scrollIntoViewIfNeeded()
    await capture(
      page,
      `${size}-answer-followups.png`,
      `${size}-answer-followups`,
    )
    await composer.fill('')
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    )
    assert.equal(overflow, false)
  } finally {
    await page.unroute(routePattern)
    await page.unroute('**/v1/events')
    await page.unroute('**/v1/events?*')
    await page.unroute('**/v1/channels?*')
    await page.reload()
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  }
}
