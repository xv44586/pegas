import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parse } from 'yaml'

import { dshLaunch } from './dsh-launch.js'

const execFileAsync = promisify(execFile)

interface DshModelCatalogItem {
  provider: string
  id: string
  name: string
}

export interface DshModelCatalog {
  defaultProvider: string
  defaultModel: string
  models: DshModelCatalogItem[]
}

export async function loadDshModelCatalog(
  options: {
    command?: string
    profile?: string
    home?: string
    patchPath?: string
    environment?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<DshModelCatalog> {
  const environment = {
    ...process.env,
    ...(options.home ? { DSH_HOME: options.home } : {}),
    ...options.environment,
  }
  const launch = dshLaunch(
    options.command ?? 'dsh',
    [
      '--profile',
      options.profile ?? 'headless',
      ...(options.patchPath ? ['--patch', options.patchPath] : []),
      '--dump-config',
    ],
    environment,
  )
  const { stdout } = await execFileAsync(launch.command, launch.args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeoutMs ?? 15_000,
    env: environment,
  })
  return parseDshModelCatalog(stdout)
}

function parseDshModelCatalog(source: string): DshModelCatalog {
  const entries: unknown = parse(source, { logLevel: 'silent' })
  if (!Array.isArray(entries)) throw new Error('DSH profile config is invalid')
  const entryList = entries as unknown[]
  const defaultEntry: unknown = entryList.find(
    entry => isRecord(entry) && entry.id === 'agent-default-model',
  )
  const llmEntry: unknown = entryList.find(
    entry => isRecord(entry) && entry.id === 'llm-pi-ai',
  )
  if (!isRecord(defaultEntry) || !isRecord(defaultEntry.config)) {
    throw new Error('DSH profile does not expose agent-default-model')
  }
  const defaultProvider = stringValue(defaultEntry.config.provider)
  const defaultModel = stringValue(defaultEntry.config.model)
  if (!defaultProvider || !defaultModel) {
    throw new Error('DSH profile default model is incomplete')
  }
  const providers =
    isRecord(llmEntry) &&
    isRecord(llmEntry.config) &&
    isRecord(llmEntry.config.providers)
      ? llmEntry.config.providers
      : {}
  const models: DshModelCatalogItem[] = []
  for (const [provider, value] of Object.entries(providers)) {
    if (!isRecord(value) || !Array.isArray(value.models)) continue
    for (const candidate of value.models) {
      if (!isRecord(candidate)) continue
      const id = stringValue(candidate.id)
      if (!id) continue
      models.push({
        provider,
        id,
        name: stringValue(candidate.name) ?? id,
      })
    }
  }
  models.sort((a, b) =>
    `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`),
  )
  return { defaultProvider, defaultModel, models }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
