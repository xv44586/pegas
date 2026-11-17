import { createHmac } from 'node:crypto'

export type PrivacyKind =
  | 'API_KEY'
  | 'EMAIL'
  | 'PASSWORD'
  | 'PHONE'
  | 'PRIVATE_KEY'
  | 'SECRET'
  | 'TOKEN'

interface PrivacyHit {
  kind: PrivacyKind
  placeholder: string
  length: number
}

export interface MaskedText {
  text: string
  hits: PrivacyHit[]
}

export interface TextPrivacyMasker {
  mask(text: string): MaskedText
  restore(text: string): string
}

export interface DeterministicPrivacyMaskerOptions {
  hmacKey: string
}

interface Candidate {
  start: number
  end: number
  value: string
  kind: PrivacyKind
  priority: number
}

interface KnownValue {
  kind: PrivacyKind
  placeholder: string
}

interface Rule {
  kind: PrivacyKind
  pattern: RegExp
  capture?: number
  accept?: (value: string) => boolean
}

const rules: Rule[] = [
  {
    kind: 'PRIVATE_KEY',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: 'API_KEY',
    pattern:
      /\b(?:sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[0-9A-Za-z-]{10,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{30,})\b/g,
  },
  {
    kind: 'TOKEN',
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    capture: 1,
  },
  {
    kind: 'PASSWORD',
    pattern:
      /(?:password|passwd|pwd)\s*["']?\s*[:=]\s*["']?([^\s"',;}\]]{4,})/gi,
    capture: 1,
  },
  {
    kind: 'SECRET',
    pattern:
      /(?:secret|token|api[_ -]?key|access[_ -]?key)\s*["']?\s*[:=]\s*["']?([^\s"',;}\]]{8,})/gi,
    capture: 1,
  },
  {
    kind: 'EMAIL',
    pattern:
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    accept: value => !isExampleEmail(value),
  },
  {
    kind: 'PHONE',
    pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,
  },
]

/** Masks deterministic high-confidence values and retains reverse mappings in memory. */
export class DeterministicPrivacyMasker implements TextPrivacyMasker {
  readonly #hmacKey: string
  readonly #valuesByPlaceholder = new Map<string, string>()
  readonly #knownValues = new Map<string, KnownValue>()

  constructor(options: DeterministicPrivacyMaskerOptions) {
    if (options.hmacKey.length < 16) {
      throw new Error('Privacy HMAC key must contain at least 16 characters')
    }
    this.#hmacKey = options.hmacKey
  }

  mask(text: string): MaskedText {
    const candidates = selectCandidates([
      ...this.#knownCandidates(text),
      ...rules.flatMap((rule, priority) =>
        candidatesForRule(text, rule, priority),
      ),
    ])

    if (candidates.length === 0) return { text, hits: [] }

    const chunks: string[] = []
    const hits: PrivacyHit[] = []
    let cursor = 0
    for (const candidate of candidates) {
      chunks.push(text.slice(cursor, candidate.start))
      const placeholder = this.#placeholderFor(candidate.kind, candidate.value)
      chunks.push(placeholder)
      hits.push({
        kind: candidate.kind,
        placeholder,
        length: candidate.value.length,
      })
      cursor = candidate.end
    }
    chunks.push(text.slice(cursor))
    return { text: chunks.join(''), hits }
  }

  restore(text: string): string {
    return text.replaceAll(
      /\{\{[A-Z_]+_[A-Za-z0-9_-]{12,32}\}\}/g,
      value => this.#valuesByPlaceholder.get(value) ?? value,
    )
  }

  #knownCandidates(text: string): Candidate[] {
    const candidates: Candidate[] = []
    for (const [value, known] of this.#knownValues) {
      let start = text.indexOf(value)
      while (start >= 0) {
        candidates.push({
          start,
          end: start + value.length,
          value,
          kind: known.kind,
          priority: -1,
        })
        start = text.indexOf(value, start + value.length)
      }
    }
    return candidates
  }

  #placeholderFor(kind: PrivacyKind, value: string): string {
    const known = this.#knownValues.get(value)
    if (known?.kind === kind) return known.placeholder

    const digest = createHmac('sha256', this.#hmacKey)
      .update(kind)
      .update('\0')
      .update(value)
      .digest('base64url')
    for (let length = 12; length <= 32; length += 4) {
      const placeholder = `{{${kind}_${digest.slice(0, length)}}}`
      const existing = this.#valuesByPlaceholder.get(placeholder)
      if (existing === undefined || existing === value) {
        this.#valuesByPlaceholder.set(placeholder, value)
        this.#knownValues.set(value, { kind, placeholder })
        return placeholder
      }
    }
    throw new Error('Privacy placeholder collision could not be resolved')
  }
}

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const ordered = candidates.toSorted(
    (left, right) =>
      left.start - right.start ||
      right.end - left.end ||
      left.priority - right.priority,
  )
  const selected: Candidate[] = []
  for (const candidate of ordered) {
    if (
      selected.every(
        accepted =>
          candidate.start >= accepted.end || candidate.end <= accepted.start,
      )
    ) {
      selected.push(candidate)
    }
  }
  return selected
}

function candidatesForRule(
  text: string,
  rule: Rule,
  priority: number,
): Candidate[] {
  const candidates: Candidate[] = []
  rule.pattern.lastIndex = 0
  for (const match of text.matchAll(rule.pattern)) {
    const value = rule.capture === undefined ? match[0] : match[rule.capture]
    if (!value || rule.accept?.(value) === false) continue
    const relativeStart =
      rule.capture === undefined ? 0 : match[0].lastIndexOf(value)
    const start = match.index + relativeStart
    candidates.push({
      start,
      end: start + value.length,
      value,
      kind: rule.kind,
      priority,
    })
  }
  return candidates
}

function isExampleEmail(value: string): boolean {
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase()
  return (
    domain === 'example.com' ||
    domain.endsWith('.test') ||
    domain.endsWith('.invalid')
  )
}
