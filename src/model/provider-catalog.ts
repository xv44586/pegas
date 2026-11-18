export type ModelProviderProtocol = 'openai-chat' | 'anthropic-messages'
export type ModelProviderCategory = 'vendor' | 'gateway' | 'local' | 'custom'

export interface ModelProviderPreset {
  id: string
  name: string
  category: ModelProviderCategory
  protocol: ModelProviderProtocol
  baseUrl: string
  defaultModel: string
  requiresApiKey: boolean
  description: string
}

export const modelProviderPresets = [
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    requiresApiKey: true,
    description: 'GPT 系列模型与 OpenAI Chat Completions API。',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'vendor',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    requiresApiKey: true,
    description: 'Claude 系列模型与原生 Messages API。',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    requiresApiKey: true,
    description: 'Gemini Developer API 的 OpenAI-compatible 入口。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    description: 'DeepSeek 官方 API。',
  },
  {
    id: 'xai',
    name: 'xAI',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-fast',
    requiresApiKey: true,
    description: 'Grok 系列模型的官方 API。',
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    requiresApiKey: true,
    description: 'Moonshot AI / Kimi 官方 API。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7',
    requiresApiKey: true,
    description: '智谱开放平台 GLM 系列模型。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.1',
    requiresApiKey: true,
    description: 'MiniMax 开放平台。',
  },
  {
    id: 'qwen',
    name: '阿里云百炼',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-max',
    requiresApiKey: true,
    description: '通义千问与百炼 OpenAI-compatible API。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'gateway',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5-mini',
    requiresApiKey: true,
    description: '一个密钥访问多个模型供应商。',
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'gateway',
    protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresApiKey: true,
    description: 'GroqCloud 高速推理 API。',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    category: 'vendor',
    protocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    requiresApiKey: true,
    description: 'Mistral 官方 API。',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    category: 'gateway',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3-32B',
    requiresApiKey: true,
    description: '硅基流动的多模型推理平台。',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'local',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3:8b',
    requiresApiKey: false,
    description: '运行在本机的 Ollama 模型。',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    category: 'local',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    requiresApiKey: false,
    description: 'LM Studio 本地 OpenAI-compatible 服务。',
  },
  {
    id: 'custom',
    name: '自定义',
    category: 'custom',
    protocol: 'openai-chat',
    baseUrl: '',
    defaultModel: '',
    requiresApiKey: false,
    description: '连接任意兼容的模型服务。',
  },
] as const satisfies readonly ModelProviderPreset[]

export type ModelProviderId = (typeof modelProviderPresets)[number]['id']

export function modelProviderPreset(
  id: string,
): (typeof modelProviderPresets)[number] | undefined {
  return modelProviderPresets.find(provider => provider.id === id)
}
