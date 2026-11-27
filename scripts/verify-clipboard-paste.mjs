import assert from 'node:assert/strict'

// Real browser paste, including its default insertion, on the isolated review server.
export async function verifyClipboardPaste(page, capture, size) {
  const input = page.getByRole('textbox', { name: '给 Pegas 发消息' })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  async function clipboard(text, image) {
    await page.evaluate(
      async ({ text, image }) => {
        const data = {}
        if (text !== null)
          data['text/plain'] = new Blob([text], { type: 'text/plain' })
        if (image) {
          const canvas = globalThis.document.createElement('canvas')
          canvas.width = canvas.height = 2
          data['image/png'] = await new Promise(resolve =>
            canvas.toBlob(resolve),
          )
        }
        await navigator.clipboard.write([new globalThis.ClipboardItem(data)])
      },
      { text, image },
    )
  }
  async function paste() {
    await input.focus()
    await input.press('ControlOrMeta+V')
  }
  try {
    await input.fill('前文替换后文')
    await input.evaluate(element => element.setSelectionRange(2, 4))
    await clipboard('图文说明', true)
    await paste()
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#pegas-message').value ===
        '前文图文说明后文',
    )
    await page.getByRole('button', { name: '移除附件', exact: true }).waitFor()
    assert.equal(await input.evaluate(element => element.selectionStart), 6)
    await capture(
      page,
      `${size}-clipboard-mixed.png`,
      `${size}-clipboard-mixed`,
    )
    await page.getByRole('button', { name: '移除附件', exact: true }).click()

    await clipboard(null, true)
    await paste()
    await page.getByRole('button', { name: '移除附件', exact: true }).waitFor()
    assert.equal(await input.inputValue(), '前文图文说明后文')
    await page.getByRole('button', { name: '移除附件', exact: true }).click()

    await input.fill('前后')
    await input.evaluate(element => element.setSelectionRange(1, 1))
    await clipboard('纯文本', false)
    await paste()
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#pegas-message').value ===
        '前纯文本后',
    )
    assert.equal(
      await page.getByRole('button', { name: '移除附件', exact: true }).count(),
      0,
    )
  } finally {
    await input.fill('')
    await page.context().clearPermissions()
  }
}
