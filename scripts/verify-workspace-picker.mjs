import assert from 'node:assert/strict'

/** Uses the isolated review instance; no real user directory is registered. */
export async function verifyWorkspacePicker(page, capture, size, directory) {
  await page.getByRole('button', { name: /^工作目录：/ }).click()
  const form = page.getByRole('form', { name: '工作目录设置' })
  await form.getByLabel('位置', { exact: true }).click()
  await page
    .getByRole('option', { name: '普通文件夹（无需创建项目）', exact: true })
    .click()
  await form.getByLabel('该电脑上的完整目录').fill(directory)
  await capture(
    page,
    `${size}-workspace-folder.png`,
    `${size}-workspace-folder`,
  )
  const geometry = await form.boundingBox()
  assert(geometry && geometry.width > 0 && geometry.x >= 0)
  assert(geometry.x + geometry.width <= page.viewportSize().width + 1)
  await form.getByRole('button', { name: '应用目录' }).click()
  await page
    .getByRole('button', { name: `工作目录：${directory}`, exact: true })
    .waitFor()
  // Temporarily targeting a task must not reset the visible selection while
  // the composer still retains its directory target for the next new task.
  const input = page.getByRole('textbox', { name: '给 Pegas 发消息' })
  await input.fill('@')
  await page
    .getByRole('listbox', { name: '选择已有事情' })
    .getByRole('option')
    .first()
    .click()
  assert.equal(
    await page.getByRole('button', { name: /^工作目录：/ }).count(),
    0,
  )
  await page.getByRole('button', { name: '取消继续当前事情' }).click()
  await page
    .getByRole('button', { name: `工作目录：${directory}`, exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^工作目录：/ }).click()
  await form.getByLabel('位置', { exact: true }).click()
  await page.getByRole('option', { name: '默认工作区', exact: true }).click()
  await form.getByRole('button', { name: '应用目录' }).click()
  await page
    .getByRole('button', { name: '工作目录：默认', exact: true })
    .waitFor()
}
