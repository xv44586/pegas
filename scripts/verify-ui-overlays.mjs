import assert from 'node:assert/strict'

// Run against the isolated UI-review server, never against user data.
export async function verifyUiOverlays(page, capture, size) {
  const base = new URL('/', page.url()).href
  const errors = []
  const onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  let cycles = 0
  async function hit(locator, label) {
    await locator.scrollIntoViewIfNeeded()
    // Portaled poppers can be visible before their position/z-index settles.
    // Wait for actual pointer actionability, retaining the independent hit test.
    try {
      await locator.click({ trial: true })
    } catch (error) {
      console.error(
        'Overlay hit failure',
        label,
        await locator.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return {
            rect: rect.toJSON(),
            stack: globalThis.document
              .elementsFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              )
              .slice(0, 5)
              .map(node => ({
                tag: node.tagName,
                role: node.getAttribute('role'),
                className: node.className,
                zIndex: globalThis.getComputedStyle(node).zIndex,
              })),
          }
        }),
      )
      await capture(
        page,
        `${size}-overlay-hit-failure.png`,
        `${size}-overlay-hit-failure`,
      )
      throw error
    }
    assert.equal(
      await locator.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        return (
          x >= 0 &&
          y >= 0 &&
          x < globalThis.innerWidth &&
          y < globalThis.innerHeight &&
          element.contains(globalThis.document.elementFromPoint(x, y))
        )
      }),
      true,
      `${size} ${label}: clipped or covered`,
    )
  }
  async function restored(trigger) {
    await page.waitForFunction(
      element => globalThis.document.activeElement === element,
      await trigger.elementHandle(),
    )
  }
  async function selects(parent = page) {
    const triggers = parent.getByRole('combobox')
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i)
      if (await trigger.isDisabled()) continue
      const label =
        (await trigger.getAttribute('aria-label')) ??
        (await trigger.getAttribute('id'))
      for (let cycle = 0; cycle < 3; cycle++) {
        if (cycle === 1) {
          await trigger.focus()
          await trigger.press('Enter')
        } else await trigger.click()
        const popup = page.getByRole('listbox')
        await popup.waitFor()
        await hit(popup.getByRole('option').first(), label)
        await hit(popup.getByRole('option').last(), label)
        if (cycle === 2) {
          const selected = popup.locator(
            '[role="option"][aria-selected="true"]',
          )
          await (
            (await selected.count())
              ? selected
              : popup.getByRole('option').first()
          ).click()
        } else await page.keyboard.press('Escape')
        await popup.waitFor({ state: 'detached' })
        await restored(trigger)
        cycles++
      }
    }
  }
  async function nav(name) {
    await page
      .getByLabel(size === 'mobile' ? '移动端主导航' : '主导航')
      .getByRole('button', { name, exact: true })
      .click()
    if (name === '设置') await page.locator('.settings-page').waitFor()
    else await page.getByRole('heading', { name, exact: true }).waitFor()
  }
  async function modelPickers(parent = page) {
    const triggers = parent.locator('.model-picker-control > button')
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i)
      if (await trigger.isDisabled()) continue
      for (let cycle = 0; cycle < 3; cycle++) {
        await trigger.click()
        const panel = page.locator('.model-picker-panel')
        await panel.waitFor()
        await hit(panel.getByRole('option').first(), '模型首项')
        await hit(panel.getByRole('option').last(), '模型末项')
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'detached' })
        await restored(trigger)
        cycles++
      }
    }
  }
  async function closeDialog(dialog) {
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.notEqual(
      await page
        .locator('body')
        .evaluate(el => globalThis.getComputedStyle(el).pointerEvents),
      'none',
    )
  }
  try {
    await modelPickers()
    await page.keyboard.press('Control+k')
    const search = page.getByRole('dialog', { name: '全局搜索' })
    await search.waitFor()
    await selects(search)
    await closeDialog(search)

    await nav('所有事情')
    const sort = page.getByRole('button', { name: /排序/ })
    for (let i = 0; i < 3; i++) {
      await sort.click()
      const menu = page.getByRole('menu')
      await hit(menu.getByRole('menuitemradio').last(), '事情排序')
      await page.keyboard.press('Escape')
      await restored(sort)
      cycles++
    }

    await nav('自动化')
    for (const action of ['新建自动化', '编辑']) {
      const trigger = page
        .getByRole('button', { name: action, exact: true })
        .first()
      await trigger.click()
      const dialog = page.getByRole('dialog', {
        name: action === '编辑' ? '编辑自动化' : action,
      })
      await selects(dialog)
      await dialog.getByRole('combobox', { name: '目标', exact: true }).click()
      await page.getByRole('option', { name: /续接/ }).click()
      await selects(dialog)
      await closeDialog(dialog)
      await restored(trigger)
    }

    await nav('记忆')
    for (const action of ['添加记忆', '编辑']) {
      const trigger = page
        .getByRole('button', { name: action, exact: true })
        .first()
      await trigger.click()
      const dialog = page.getByRole('dialog', {
        name: action === '编辑' ? '编辑记忆' : action,
      })
      await selects(dialog)
      await dialog.getByRole('combobox', { name: '作用范围' }).click()
      await page.getByRole('option', { name: '事情', exact: true }).click()
      await selects(dialog)
      await closeDialog(dialog)
      await restored(trigger)
    }

    await nav('设置')
    for (const category of [
      'Pegas',
      '模型服务',
      '事情归类',
      '语音与输入',
      '通知',
      '隐私',
    ]) {
      await page
        .getByLabel('设置分类')
        .getByRole('button', { name: category, exact: true })
        .click()
      await selects()
      if (category === '事情归类') {
        await page.getByRole('tab', { name: '智能判断' }).click()
        await selects()
      }
      if (category === '语音与输入') {
        await page.getByRole('switch', { name: '启用轻量改写' }).click()
        await page.getByRole('tab', { name: '独立服务', exact: true }).click()
        await selects()
      }
      await modelPickers()
    }

    // The automatic-memory correction path is absent from normal seeded data.
    const route = '**/v1/derived-memories?*'
    await page.route(route, request =>
      request.fulfill({
        json: {
          memories: [
            {
              id: 'overlay-derived',
              text: '自动记忆交互回归',
              type: 'world',
              tags: ['pegas:global'],
              metadata: {},
            },
          ],
          sync: null,
        },
      }),
    )
    await page.goto(base)
    await nav('记忆')
    const correct = page.getByRole('button', { name: '纠正', exact: true })
    for (let i = 0; i < 3; i++) {
      await correct.click()
      const dialog = page.getByRole('dialog', { name: '纠正自动记忆' })
      await dialog.waitFor()
      assert.equal(
        await dialog.evaluate(el => globalThis.getComputedStyle(el).position),
        'fixed',
        'memory correction must be a modal overlay',
      )
      await hit(
        dialog.getByRole('textbox', { name: '正确内容' }),
        '自动记忆纠正',
      )
      await dialog
        .getByRole('textbox', { name: '正确内容' })
        .fill('仅验证草稿，不保存')
      const cancel = dialog.getByRole('button', { name: '取消', exact: true })
      await cancel.focus()
      for (let tab = 0; tab < 6; tab++) {
        await page.keyboard.press('Tab')
        assert.equal(
          await dialog.evaluate(el =>
            el.contains(globalThis.document.activeElement),
          ),
          true,
          'correction focus escaped',
        )
      }
      if (i === 0)
        await capture(
          page,
          `${size}-memory-correction.png`,
          `${size}-memory-correction`,
        )
      await closeDialog(dialog)
      await restored(correct)
      cycles++
    }
    await page.unroute(route)
    await page.goto(`${base}?setup=1`)
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await selects()
    await modelPickers(page.locator('.onboarding-dialog'))
    await page.goto(base)
    await page
      .getByRole('textbox', { name: '给 Pegas 发消息' })
      .fill('交互已恢复')
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).fill('')
    assert.deepEqual(errors, [], `${size} overlay page errors`)
    console.log(
      `Overlay audit ${size}: ${cycles} open/select/dismiss cycles passed`,
    )
  } finally {
    page.off('pageerror', onError)
  }
}
