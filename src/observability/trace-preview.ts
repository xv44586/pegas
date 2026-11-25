import { randomUUID } from 'node:crypto'
import { DeterministicPrivacyMasker } from '../privacy/masker.js'
import type { TraceText } from './message-trace.js'

const previewLimit = 2_000
const maskLimit = 32_768

export function tracePreview(value: string): TraceText
export function tracePreview(value: unknown): TraceText | undefined
export function tracePreview(value: unknown): TraceText | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length > maskLimit)
    return { characters: value.length, truncated: true }

  // A fresh masker avoids retaining mappings from observed requests.
  const text = new DeterministicPrivacyMasker({ hmacKey: randomUUID() })
    .mask(value)
    .text.replaceAll(/\{\{[A-Z_]+_[A-Za-z0-9_-]{12,32}\}\}/gu, '[已脱敏]')
    .replaceAll(
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/giu,
      '$1[已脱敏]',
    )
  return {
    text: text.slice(0, previewLimit),
    characters: value.length,
    truncated: text.length > previewLimit,
  }
}

export function traceFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
