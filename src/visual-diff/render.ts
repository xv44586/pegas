import type { VisualDiff } from './model.js'

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function lines(value: string, width: number): string[] {
  const result: string[] = []
  let line = '',
    size = 0
  for (const char of value.replaceAll(/\s+/gu, ' ')) {
    const next = char.charCodeAt(0) < 128 ? 0.55 : 1
    if (size + next > width) {
      result.push(line)
      line = ''
      size = 0
    }
    line += char
    size += next
  }
  if (line) result.push(line)
  return result
}

function label(
  value: string,
  x: number,
  y: number,
  width: number,
  cls = 'detail',
): string {
  return `<text class="${cls}" x="${String(x)}" y="${String(y)}">${lines(
    value,
    width,
  )
    .map(
      (line, i) =>
        `<tspan x="${String(x)}" dy="${String(i ? (cls === 'title' ? 32 : 21) : 0)}">${escape(line)}</tspan>`,
    )
    .join('')}</text>`
}

/** Pure dependency-free renderer. All user/model text is XML-escaped. */
export function renderVisualDiff(diff: VisualDiff): string {
  const rowHeight = 240,
    top = 200
  const bottom = top + diff.nodes.length * rowHeight
  const footer = lines(diff.summary, 68)
  const ignoredRows = diff.ignored.map(
    item => `已折叠（Agent 分类）：${item.path} — ${item.reason}`,
  )
  const ignoredHeights = ignoredRows.map(
    item => lines(item, 80).length * 21 + 12,
  )
  const height =
    bottom +
    130 +
    footer.length * 21 +
    ignoredHeights.reduce((sum, value) => sum + value, 0)
  const status = {
    added: '+ 新增',
    modified: '~ 修改',
    removed: '− 删除',
    unchanged: '复用',
  }
  const panels = (['before', 'after'] as const)
    .map((side, panel) => {
      const x = panel * 600 + 58,
        cx = x + 200
      const edges = side === 'before' ? diff.beforeEdges : diff.afterEdges
      const other = side === 'before' ? diff.afterEdges : diff.beforeEdges
      const paths = edges
        .map((edge, i) => {
          const from = diff.nodes.findIndex(node => node.id === edge.from)
          const to = diff.nodes.findIndex(node => node.id === edge.to)
          const y1 = top + from * rowHeight + 182
          const y2 = top + to * rowHeight
          const direct = to === from + 1
          const lane = x + 424 + i * 8
          const d = direct
            ? `M${String(cx)} ${String(y1)}V${String(y2 - 8)}`
            : `M${String(x + 400)} ${String(y1 - 60)}H${String(lane)}V${String(y2 + 60)}H${String(x + 408)}`
          const changed = !other.some(
            item =>
              item.from === edge.from &&
              item.to === edge.to &&
              item.label === edge.label,
          )
          return `<path class="edge ${changed ? 'changed' : ''}" d="${d}" marker-end="url(#arrow-${changed ? 'changed' : 'plain'})"/>
${edge.label ? label(edge.label, direct ? cx + 12 : x + 414, direct ? y1 + 29 : (y1 + y2) / 2, direct ? 12 : 9, 'note') : ''}
<circle class="flow" r="4" opacity="0"><animateMotion path="${d}" begin="${(i * 0.28).toFixed(2)}s" dur="1s" fill="freeze"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.9;1" begin="${(i * 0.28).toFixed(2)}s" dur="1s" fill="freeze"/></circle>`
        })
        .join('')
      const nodes = diff.nodes
        .map((node, index) => {
          const y = top + index * rowHeight
          const content = node[side]
          const changed = node.change !== 'unchanged'
          const refs = node.sources.filter(
            s => s.side === (side === 'before' ? 'base' : 'head'),
          )
          const reference = refs
            .map(s => `${s.path}:${String(s.line)}`)
            .join(' · ')
          const shortReference = lines(reference, 26)[0] ?? ''
          return `<g><title>${escape(reference || '此版本没有该步骤')}</title>
<rect x="${String(x)}" y="${String(y)}" width="400" height="182" rx="12" class="node ${content === null ? 'absent' : changed ? 'changed' : ''}"/>
${label(node.label, x + 18, y + 27, 18, 'node-title')}
<text class="note" text-anchor="end" x="${String(x + 382)}" y="${String(y + 27)}">${content === null ? '不存在' : status[node.change]}</text>
${label(content ?? (side === 'before' ? '本次新增的步骤' : '本次移除的步骤'), x + 18, y + 77, 22)}
${label(shortReference + (shortReference === reference ? '' : '…'), x + 18, y + 174, 27, 'note')}
</g>`
        })
        .join('')
      return `<text class="section" x="${String(x)}" y="160">${side === 'before' ? '修改前' : '修改后'}</text><text class="note" text-anchor="end" x="${String(x + 400)}" y="160">${(side === 'before' ? diff.base : diff.head).slice(0, 8)}</text>${paths}${nodes}`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${String(height)}" viewBox="0 0 1200 ${String(height)}" role="img" aria-labelledby="title description">
<title id="title">${escape(diff.title)}</title><desc id="description">${escape(diff.summary)}。蓝色标出修改部分，灰色为复用部分，虚线为该版本不存在的步骤。连线上的动画仅提示关系方向，不代表运行顺序或耗时；本图为源码说明，不是运行录像或测试证明。</desc>
<metadata>${escape(JSON.stringify(diff))}</metadata>
<style>
svg{--bg:#fbfcfe;--fg:#172335;--muted:#59697b;--line:#b7c4d4;--node:#fff;--blue:#2365d7;--tint:#edf4ff;background:var(--bg)}
text{font-family:system-ui,"PingFang SC",sans-serif;fill:var(--fg)}.title{font-size:26px;font-weight:500}.section{font-size:22px;font-weight:500}.node-title{font-size:18px;font-weight:500}.detail{font-size:16px}.note{font-size:13px;fill:var(--muted)}
.node{fill:var(--node);stroke:var(--line);stroke-width:1.3}.node.changed{fill:var(--tint);stroke:var(--blue);stroke-width:1.6}.absent{stroke-dasharray:5 6}.edge{fill:none;stroke:var(--line);stroke-width:1.5}.edge.changed{stroke:var(--blue)}.flow{fill:var(--blue)}
@media(prefers-color-scheme:dark){svg{--bg:#111a28;--fg:#e9eff8;--muted:#a3b3c7;--line:#4b5c73;--node:#1b2738;--blue:#82b4ff;--tint:#1a2c48}}
@media(prefers-reduced-motion:reduce){.flow{display:none}}
</style>
<defs><marker id="arrow-plain" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5 1 9" fill="none" stroke="var(--line)"/></marker><marker id="arrow-changed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5 1 9" fill="none" stroke="var(--blue)"/></marker></defs>
<rect width="1200" height="${String(height)}" fill="var(--bg)"/>
${label(diff.title, 42, 48, 40, 'title')}
<text class="note" x="42" y="114">代码变更流程图 · 蓝色 = 修改范围 · 灰色 = 复用 · 虚线 = 不存在</text>
${panels}
${label(diff.summary, 42, bottom + 14, 68)}
<text class="note" x="42" y="${String(bottom + footer.length * 21 + 36)}">Git 引用已校验；行为解释由执行 Agent 编写。动画仅提示连线方向，自动播放一次；不等同于测试通过。</text>
${ignoredRows.map((item, i) => label(item, 42, bottom + footer.length * 21 + 70 + ignoredHeights.slice(0, i).reduce((sum, value) => sum + value, 0), 80, 'note')).join('')}
</svg>\n`
}
