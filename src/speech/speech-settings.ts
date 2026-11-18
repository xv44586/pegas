type SpeechProviderId = 'disabled' | 'openai-compatible'

export interface SpeechConnection {
  provider: SpeechProviderId
  baseUrl: string
  model: string
  apiKeyCiphertext?: string
}

export interface SpeechSettingsSummary {
  provider: SpeechProviderId
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface SpeechConnectionUpdate {
  provider: SpeechProviderId
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey: boolean
}

export const defaultSpeechConnection: SpeechConnection = {
  provider: 'disabled',
  baseUrl: '',
  model: 'Qwen/Qwen3-ASR-0.6B',
}

export const initialSpeechConnection: SpeechConnection = {
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:18081/v1',
  model: defaultSpeechConnection.model,
}

export function parseSpeechConnectionUpdate(
  value: unknown,
): SpeechConnectionUpdate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be an object')
  }
  const speech = (value as Record<string, unknown>).speech
  if (speech === undefined) return undefined
  if (typeof speech !== 'object' || speech === null || Array.isArray(speech)) {
    throw new Error('speech must be an object')
  }
  const input = speech as Record<string, unknown>
  const provider = input.provider
  if (provider !== 'disabled' && provider !== 'openai-compatible') {
    throw new Error('speech.provider is invalid')
  }
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (baseUrl.length > 2048 || model.length > 240 || apiKey.length > 16_384) {
    throw new Error('speech configuration is too long')
  }
  if (provider === 'openai-compatible') {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new Error('语音服务地址不是有效 URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error('语音服务地址必须是 HTTP 或 HTTPS URL，且不能包含凭证')
    }
    if (!model) throw new Error('请填写语音识别模型')
  }
  return {
    provider,
    baseUrl,
    model: model || defaultSpeechConnection.model,
    ...(apiKey ? { apiKey } : {}),
    clearApiKey: input.clearApiKey === true,
  }
}
