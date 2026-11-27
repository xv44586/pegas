interface VisualDiffSource {
  side: 'base' | 'head'
  path: string
  line: number
}

interface VisualDiffNode {
  id: string
  label: string
  before: string | null
  after: string | null
  change: 'added' | 'modified' | 'removed' | 'unchanged'
  sources: VisualDiffSource[]
}

interface VisualDiffEdge {
  from: string
  to: string
  label: string
}

/** Portable, versioned data; never accepts executable SVG, HTML or URLs. */
export interface VisualDiff {
  version: 1
  title: string
  summary: string
  base: string
  head: string
  nodes: VisualDiffNode[]
  beforeEdges: VisualDiffEdge[]
  afterEdges: VisualDiffEdge[]
  ignored: { path: string; reason: string }[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a visual diff object')
  return value as Record<string, unknown>
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
      return true
  }
  return false
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    hasControlCharacters(value)
  )
    throw new Error('Invalid visual diff text')
  return value.trim()
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('Invalid visual diff list')
  return value
}

function path(value: unknown): string {
  const result = text(value, 240)
  if (
    result.startsWith('/') ||
    result.startsWith('-') ||
    result.includes('\\') ||
    result.split('/').some(part => !part || part === '..' || part === '.git') ||
    /[\r\n:]/u.test(result)
  )
    throw new Error('Invalid repository-relative source path')
  return result
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new Error('Visual diff requires full Git commit hashes')
  return value
}

function source(value: unknown): VisualDiffSource {
  const item = record(value)
  if (item.side !== 'base' && item.side !== 'head')
    throw new Error('Source side must be base or head')
  if (!Number.isSafeInteger(item.line) || Number(item.line) < 1)
    throw new Error('Source line must be positive')
  return { side: item.side, path: path(item.path), line: Number(item.line) }
}

export function parseVisualDiff(value: unknown): VisualDiff {
  const input = record(value)
  if (input.version !== 1) throw new Error('Unsupported visual diff version')
  const nodes = list(input.nodes, 8).map((value): VisualDiffNode => {
    const node = record(value)
    const id = text(node.id, 40)
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id))
      throw new Error('Invalid visual diff node id')
    const before = node.before === null ? null : text(node.before, 72)
    const after = node.after === null ? null : text(node.after, 72)
    const change = node.change
    if (
      (change !== 'added' || before !== null || after === null) &&
      (change !== 'removed' || after !== null || before === null) &&
      (change !== 'modified' ||
        before === null ||
        after === null ||
        before === after) &&
      (change !== 'unchanged' || before === null || before !== after)
    )
      throw new Error('Change classification disagrees with before/after')
    const sources = list(node.sources, 4).map(source)
    if (!sources.length) throw new Error('Every node needs source evidence')
    for (const side of ['base', 'head'] as const) {
      const present = side === 'base' ? before !== null : after !== null
      if (present && !sources.some(item => item.side === side))
        throw new Error(
          'Every existing version of a node needs source evidence',
        )
      if (!present && sources.some(item => item.side === side))
        throw new Error('Absent node version cannot cite source evidence')
    }
    return {
      id,
      label: text(node.label, 36),
      before,
      after,
      change,
      sources,
    }
  })
  if (nodes.length < 2 || !nodes.some(node => node.change !== 'unchanged'))
    throw new Error('Visual diff requires a material change')
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length) throw new Error('Duplicate visual diff node')
  const edges = (value: unknown, side: 'before' | 'after') => {
    const seen = new Set<string>()
    return list(value, 12).map((value): VisualDiffEdge => {
      const edge = record(value)
      const from = text(edge.from, 40)
      const to = text(edge.to, 40)
      if (
        !nodes.some(node => node.id === from && node[side] !== null) ||
        !nodes.some(node => node.id === to && node[side] !== null) ||
        from === to ||
        seen.has(`${from}/${to}`)
      )
        throw new Error('Invalid or duplicate visual diff edge')
      seen.add(`${from}/${to}`)
      return { from, to, label: edge.label ? text(edge.label, 24) : '' }
    })
  }
  const base = sha(input.base)
  const head = sha(input.head)
  if (base === head) throw new Error('Identical visual diff revisions')
  return {
    version: 1,
    title: text(input.title, 80),
    summary: text(input.summary, 240),
    base,
    head,
    nodes,
    beforeEdges: edges(input.beforeEdges, 'before'),
    afterEdges: edges(input.afterEdges, 'after'),
    ignored: list(input.ignored ?? [], 16).map(value => {
      const item = record(value)
      return { path: path(item.path), reason: text(item.reason, 120) }
    }),
  }
}
