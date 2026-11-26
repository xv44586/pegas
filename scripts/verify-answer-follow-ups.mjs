import assert from 'node:assert/strict'

// Fixture data through the actual Conversation renderer; never user data.
export async function verifyAnswerFollowUps(page, capture, size) {
  const routePattern = '**/v1/outbox?*'
  const question = '哪些因素推动了本季度收入增长？'
  let streaming = true
  await page.route(routePattern, route =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'followup-review',
            userId: 'owner',
            taskId: 'followup-conversation',
            status: 'sent',
            createdAt: '2026-11-26T08:00:00.000Z',
            payload: {
              type: 'agent.message',
              text: '本季度收入同比增长，主要来自产品组合和复购率的变化。',
              streaming,
              followUps: [question, '比较两个季度的毛利率与成本结构'],
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
    await capture(
      page,
      `${size}-answer-followups.png`,
      `${size}-answer-followups`,
    )
    await page.keyboard.press('Enter')
    const composer = page.getByRole('textbox', { name: '给 Pegas 发消息' })
    assert.equal(await composer.inputValue(), question)
    assert.equal(
      await composer.evaluate(el => el === globalThis.document.activeElement),
      true,
    )
    await composer.fill('保留用户正在写的问题')
    assert.equal(await second.getAttribute('aria-disabled'), 'true')
    await second.focus()
    await second.press('Enter')
    assert.equal(await composer.inputValue(), '保留用户正在写的问题')
    await composer.fill('')
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    )
    assert.equal(overflow, false)
  } finally {
    await page.unroute(routePattern)
    await page.reload()
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  }
}
