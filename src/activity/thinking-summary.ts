import type { JsonModelProvider } from '../model/provider.js'

export interface ThinkingSummarizer {
  summarize(text: string): Promise<string>
}

const MAX_SUMMARY_CHARACTERS = 64

/** One-line Chinese headline candidates; raw thinking stays untouched. */
export function needsChineseSummary(entry: {
  summary?: string
  label: string
  detail?: string
}): boolean {
  if (entry.summary) return false
  const source = `${entry.label}\n${entry.detail ?? ''}`
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(source)) return false
  const letters = source.match(/[A-Za-z]/gu)
  return letters !== null && letters.length >= 8
}

export function normalizeThinkingSummary(value: unknown): string {
  if (typeof value !== 'string') throw new Error('摘要模型返回无效结果')
  const flattened = value.replaceAll(/\s+/gu, ' ').trim()
  if (!flattened || flattened.length > MAX_SUMMARY_CHARACTERS)
    throw new Error('摘要模型返回无效结果')
  if (!/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(flattened))
    throw new Error('摘要模型返回无效结果')
  return flattened
}

/**
 * EXEC-006: settled English reasoning gets a bounded Chinese headline through
 * the control-plane model boundary. Failures fall back to the original text;
 * this never fabricates a translation locally.
 */
export class ModelThinkingSummarizer implements ThinkingSummarizer {
  readonly #provider: JsonModelProvider

  constructor(provider: JsonModelProvider) {
    this.#provider = provider
  }

  async summarize(text: string): Promise<string> {
    const value = await this.#provider.generateJson({
      system: summarySystemPrompt,
      input: text.slice(0, 4_000),
      schema: summarySchema,
    })
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('摘要模型返回无效结果')
    return normalizeThinkingSummary((value as Record<string, unknown>).summary)
  }
}

const summarySystemPrompt = [
  'Summarize one agent reasoning excerpt as a single Simplified Chinese headline for a work-activity timeline.',
  'Stay faithful to the excerpt: state the intent, decision, or next action; do not answer the task, invent facts, or add outcomes absent from the text.',
  'Keep file names, paths, commands, identifiers, and numbers verbatim.',
  'At most 30 Chinese characters, one line, no quotes and no trailing punctuation.',
  'Return one JSON object only: {"summary":"中文摘要"}.',
].join('\n')

const summarySchema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
}
