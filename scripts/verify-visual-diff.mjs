import assert from 'node:assert/strict'
import { renderVisualDiff } from '../dist/visual-diff/render.js'

// Browser fixtures exercise the actual Markdown renderer, authenticated fetch,
// Blob isolation, download and failure UI; Git validity is covered in unit tests.
export async function verifyVisualDiffPreview(page, capture, size) {
  const source = side => [{ side, path: 'flow.ts', line: 2 }]
  const svg = renderVisualDiff({
    version: 1,
    title: '代码变更流程图',
    summary: '就绪状态由 false 改为 true；图为源码说明，不是测试证据。',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    nodes: [
      {
        id: 'entry',
        label: '函数入口',
        before: '调用 run',
        after: '调用 run',
        change: 'unchanged',
        sources: [...source('base'), ...source('head')],
      },
      {
        id: 'result',
        label: '返回值',
        before: '返回 false',
        after: '返回 true',
        change: 'modified',
        sources: [...source('base'), ...source('head')],
      },
    ],
    beforeEdges: [{ from: 'entry', to: 'result', label: '' }],
    afterEdges: [{ from: 'entry', to: 'result', label: '' }],
    ignored: [],
  })
  const probe = await page.context().newPage()
  const worst = {
    version: 1,
    title: '最大宽度'.repeat(20),
    summary: '摘要'.repeat(120),
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    nodes: [
      {
        id: 'one',
        label: '节点'.repeat(18),
        before: '原'.repeat(72),
        after: '改'.repeat(72),
        change: 'modified',
        sources: [...source('base'), ...source('head')],
      },
      {
        id: 'two',
        label: '保留',
        before: '复用',
        after: '复用',
        change: 'unchanged',
        sources: [...source('base'), ...source('head')],
      },
    ],
    beforeEdges: [{ from: 'one', to: 'two', label: '' }],
    afterEdges: [{ from: 'one', to: 'two', label: '' }],
    ignored: [],
  }
  try {
    await probe.setContent(renderVisualDiff(worst))
    const overflow = await probe.evaluate(() =>
      [...globalThis.document.querySelectorAll('g')].flatMap(group => {
        const rect = group.querySelector('rect')?.getBBox()
        if (!rect) return []
        return [...group.querySelectorAll('text')]
          .filter(text => {
            const b = text.getBBox()
            return (
              b.x < rect.x ||
              b.x + b.width > rect.x + rect.width ||
              b.y < rect.y ||
              b.y + b.height > rect.y + rect.height
            )
          })
          .map(text => text.textContent)
      }),
    )
    assert.deepEqual(overflow, [], 'SVG node text must stay inside its card')
    assert.equal(await probe.locator('script, foreignObject, image').count(), 0)
  } finally {
    await probe.close()
  }
  const imagePath = '/v1/runs/visual-browser/visual-diff?userId=owner'
  const imageRoute = '**/v1/runs/visual-browser/visual-diff?*'
  let fail = false
  let authenticated = false
  await page.route(imageRoute, route => {
    authenticated = Boolean(route.request().headers().authorization)
    return fail
      ? route.fulfill({ status: 503, body: 'unavailable' })
      : route.fulfill({ contentType: 'image/svg+xml', body: svg })
  })
  await page.route('**/v1/outbox?*', route =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'visual-browser',
            userId: 'owner',
            status: 'sent',
            createdAt: new Date().toISOString(),
            payload: {
              type: 'agent.message',
              text: `已完成就绪状态修改。\n\n![代码变更流程图](${imagePath})`,
            },
            projection: { lane: 'say', weight: 'inline' },
          },
        ],
      },
    }),
  )
  try {
    await page.reload()
    const image = page.getByRole('img', { name: '代码变更流程图' })
    await image.waitFor()
    await page.waitForFunction(() =>
      [...globalThis.document.images].some(
        item =>
          item.alt === '代码变更流程图' &&
          item.complete &&
          item.naturalWidth === 1200,
      ),
    )
    assert.ok(authenticated)
    assert.ok((await image.getAttribute('src')).startsWith('blob:'))
    const box = await image.boundingBox()
    assert.ok(
      box &&
        box.width > 200 &&
        box.x >= 0 &&
        box.x + box.width <= page.viewportSize().width,
    )
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: '下载动态 SVG' }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), 'pegas-visual-diff.svg')
    const stream = await download.createReadStream()
    let downloaded = ''
    for await (const chunk of stream) downloaded += chunk.toString()
    assert.equal(downloaded, svg)
    await capture(page, `${size}-visual-diff.png`, `${size}-visual-diff`)
    fail = true
    await page.reload()
    await page.getByRole('button', { name: '重试流程图' }).waitFor()
    assert.equal(
      await page.getByText('已完成就绪状态修改。', { exact: true }).count(),
      1,
    )
    fail = false
    await page.getByRole('button', { name: '重试流程图' }).click()
    await image.waitFor()
  } finally {
    await page.unroute(imageRoute)
    await page.unroute('**/v1/outbox?*')
    await page.reload()
    await page.getByRole('textbox', { name: '给 Pegas 发消息' }).waitFor()
  }
}

export async function verifyVisualDiffSetting(page, capture) {
  await page.getByRole('tab', { name: '行为与规则' }).click()
  const toggle = page.getByRole('switch', { name: '代码变更流程图' })
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  await toggle.click()
  const saveResponse = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/v1/settings' &&
      response.request().method() === 'PUT',
  )
  await page.getByRole('button', { name: '保存更改' }).click()
  const response = await saveResponse
  assert.equal(response.status(), 200, await response.text())
  assert.equal((await response.json()).settings.visualDiffEnabled, true)
  await page
    .getByRole('button', { name: '保存中…' })
    .waitFor({ state: 'hidden' })
  await capture(
    page,
    'desktop-visual-diff-setting.png',
    'desktop-visual-diff-setting',
  )
  // Reopen settings to verify the service, not just the draft, kept the choice.
  await page.reload()
  await page.getByRole('tab', { name: '行为与规则' }).click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await toggle.click()
  const disableResponse = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/v1/settings' &&
      response.request().method() === 'PUT',
  )
  await page.getByRole('button', { name: '保存更改' }).click()
  const disabled = await disableResponse
  assert.equal(disabled.status(), 200, await disabled.text())
  assert.equal((await disabled.json()).settings.visualDiffEnabled, false)
  await page
    .getByRole('button', { name: '保存中…' })
    .waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: '执行模型' }).click()
}
