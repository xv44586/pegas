import { createHash } from 'node:crypto'
import { verifyVisualDiff } from './git.js'
import { renderVisualDiff } from './render.js'

const opening = '<pegas_visual_diff>'
const closing = '</pegas_visual_diff>'

export interface PreparedVisualDiff {
  svg: string
  contentHash: string
}

/** Strip partial markers as well, so machine data never enters streamed prose. */
export function visibleVisualDiffText(value: string): string {
  const start = value.indexOf(opening)
  if (start >= 0) return value.slice(0, start).trimEnd()
  for (let length = opening.length - 1; length > 0; length--) {
    if (value.endsWith(opening.slice(0, length))) return value.slice(0, -length)
  }
  return value
}

export async function prepareVisualDiffReport(
  output: string,
  enabled: boolean,
  directory: string,
): Promise<{ output: string; visualDiff?: PreparedVisualDiff }> {
  const visible = visibleVisualDiffText(output)
  const start = output.indexOf(opening)
  if (start < 0) return { output: visible }
  if (!enabled) return { output: visible }
  try {
    const end = output.indexOf(closing, start)
    const json = output.slice(start + opening.length, end)
    if (
      end < 0 ||
      json.length > 32_768 ||
      output.slice(end + closing.length).trim()
    )
      throw new Error('Invalid visual diff report envelope')
    const spec = await verifyVisualDiff(JSON.parse(json) as unknown, directory)
    const svg = renderVisualDiff(spec)
    return {
      output: visible,
      visualDiff: {
        svg,
        contentHash: createHash('sha256').update(svg).digest('hex'),
      },
    }
  } catch {
    // Do not echo a Git command error, repository contents, or model JSON.
    return {
      output: `${visible}\n\n> 流程图未生成：结构或 Git 引用校验未通过，文字汇报已保留。`,
    }
  }
}
