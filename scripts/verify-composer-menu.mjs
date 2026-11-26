import assert from 'node:assert/strict'

// Uses the isolated review instance and its seeded tasks, never production data.
export async function verifyComposerMenu(page, capture, size) {
  const input = page.getByRole('textbox', { name: '给 Pegas 发消息' })
  const add = page.getByRole('button', { name: '添加内容', exact: true })
  const errors = []
  const onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  async function focused(locator) {
    await page.waitForFunction(
      element => globalThis.document.activeElement === element,
      await locator.elementHandle(),
    )
  }
  async function visiblePanel(panel) {
    await panel.waitFor()
    const result = await panel.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const button = element.querySelector('button')
      const row = button?.getBoundingClientRect()
      return {
        fits:
          rect.left >= 0 &&
          rect.right <= globalThis.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= globalThis.innerHeight,
        hit:
          row &&
          button.contains(
            globalThis.document.elementFromPoint(
              row.x + row.width / 2,
              row.y + row.height / 2,
            ),
          ),
      }
    })
    assert.equal(result.fits, true, `${size}: composer popup outside viewport`)
    assert.equal(result.hit, true, `${size}: composer popup covered`)
  }
  try {
    await input.fill('保留这份草稿')
    await add.click()
    let menu = page.getByRole('menu', { name: '添加内容', exact: true })
    await menu
      .getByRole('menuitem', { name: /添加照片和文件/ })
      .click({ trial: true })
    await visiblePanel(menu)
    await capture(
      page,
      `${size}-composer-add-menu.png`,
      `${size}-composer-add-menu`,
    )
    await page.keyboard.press('Escape')
    await focused(add)
    assert.equal(await input.inputValue(), '保留这份草稿')
    await add.click()
    await input.click()
    await menu.waitFor({ state: 'detached' })
    await focused(input)
    await add.press('ArrowDown')
    menu = page.getByRole('menu', { name: '添加内容', exact: true })
    await focused(menu.getByRole('menuitem').first())
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await focused(page.getByRole('menuitem', { name: /命令帮助/ }))
    await page.keyboard.press('Escape')
    await focused(add)

    await input.fill('/')
    const commands = page.getByRole('listbox', { name: '基础命令' })
    await commands.getByRole('option').first().click({ trial: true })
    await visiblePanel(commands)
    await focused(input)
    await capture(
      page,
      `${size}-composer-commands.png`,
      `${size}-composer-commands`,
    )
    await input.press('ArrowDown')
    assert.equal(
      await commands
        .getByRole('option', { name: /添加照片和文件/ })
        .getAttribute('aria-selected'),
      'true',
    )
    await input.press('Escape')
    assert.equal(await input.inputValue(), '/')
    await input.fill('/he')
    await page.getByRole('listbox', { name: '基础命令' }).waitFor()
    await input.press('Tab')
    await page
      .getByRole('listbox', { name: '基础命令' })
      .waitFor({ state: 'detached' })
    assert.equal(
      await input.evaluate(
        element => globalThis.document.activeElement === element,
      ),
      false,
      'Tab must leave completion',
    )

    await input.fill('/model')
    await input.press('Enter')
    const models = page.getByRole('dialog', { name: '选择模型' })
    await models.waitFor()
    await focused(models.getByRole('searchbox'))
    await page.keyboard.press('Escape')
    await models.waitFor({ state: 'detached' })
    await focused(page.getByRole('button', { name: /选择执行模型/ }))

    await input.fill('@')
    const tasks = page.getByRole('listbox', { name: '选择已有事情' })
    await tasks.getByRole('option').first().click({ trial: true })
    await visiblePanel(tasks)
    await capture(
      page,
      `${size}-composer-task-mention.png`,
      `${size}-composer-task-mention`,
    )
    await tasks.getByRole('option').first().click()
    await focused(input)
    assert.equal(await input.inputValue(), '')
    await page
      .locator('.composer-context')
      .filter({ hasText: '继续事情：' })
      .waitFor()
    await input.fill('/auto')
    await input.press('Enter')
    assert.equal(
      await page
        .locator('.composer-context')
        .filter({ hasText: '继续事情：' })
        .count(),
      0,
    )

    await add.click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: /添加照片和文件/ }).click()
    await (
      await fileChooser
    ).setFiles({
      name: 'composer-check.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('local review fixture'),
    })
    await page.getByText('composer-check.txt', { exact: true }).waitFor()
    await page.getByRole('button', { name: '移除附件' }).click()
    await input.fill('')
    assert.deepEqual(errors, [])
    console.log(
      `Composer menu verified: ${size}, plus/file/slash/model/@/auto/keyboard/focus/viewport`,
    )
  } finally {
    page.off('pageerror', onError)
  }
}
