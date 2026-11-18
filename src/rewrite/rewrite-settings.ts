import type { ModelProviderProtocol } from '../model/provider-catalog.js'

export interface RewriteConnection {
  mode: 'router' | 'custom'
  protocol: ModelProviderProtocol
  baseUrl: string
  model: string
  apiKeyCiphertext?: string
}

export interface RewriteConnectionUpdate extends Omit<
  RewriteConnection,
  'apiKeyCiphertext'
> {
  apiKey?: string
  clearApiKey: boolean
}

export interface RewriteSettingsSummary extends Omit<
  RewriteConnection,
  'apiKeyCiphertext'
> {
  hasApiKey: boolean
}

export const defaultRewriteConnection: RewriteConnection = {
  mode: 'router',
  protocol: 'openai-chat',
  baseUrl: '',
  model: '',
}

export function parseRewriteConnectionUpdate(
  value: unknown,
): RewriteConnectionUpdate | undefined {
  if (!isRecord(value) || value.rewrite === undefined) return undefined
  const draft = value.rewrite
  if (!isRecord(draft)) throw new Error('rewrite must be an object')
  const mode = draft.mode
  if (mode !== 'router' && mode !== 'custom')
    throw new Error('选择有效的改写模型来源')
  const protocol = draft.protocol
  if (protocol !== 'openai-chat' && protocol !== 'anthropic-messages') {
    throw new Error('选择有效的改写接口协议')
  }
  const baseUrl = stringValue(draft.baseUrl, '改写服务地址', 2048)
  const model = stringValue(draft.model, '改写模型', 240)
  const apiKey = stringValue(draft.apiKey, '改写 API key', 16_384)
  if (mode === 'custom') {
    if (!baseUrl || !model) throw new Error('填写改写服务地址和模型')
  }
  if (baseUrl) {
    const url = new URL(baseUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('改写服务地址必须是无凭证和查询参数的 HTTP(S) 根地址')
    }
  }
  return {
    mode,
    protocol,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(apiKey ? { apiKey } : {}),
    clearApiKey: draft.clearApiKey === true,
  }
}

function stringValue(value: unknown, name: string, limit: number): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${name}无效`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
