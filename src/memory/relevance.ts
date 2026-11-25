/**
 * MEMORY-001 M4 read-side relevance gate. Deterministic lexical overlap
 * between the task text and a candidate fact — no model call, no embedding.
 * CJK text is compared on character bigrams (trigram FTS already matched
 * substrings; the gate asks whether the fact shares enough vocabulary with
 * the task to be worth injection budget). ASCII text uses lowercase word
 * tokens. A fact with no overlap is filtered as `low_relevance` and never
 * consumes injection budget.
 */

const MINIMUM_ASCII_TOKEN_LENGTH = 3
const MINIMUM_RELEVANCE = 0.08

export function memoryRelevance(query: string, text: string): number {
  const queryTerms = relevanceTerms(query)
  if (queryTerms.size === 0) return 0
  const textTerms = relevanceTerms(text)
  if (textTerms.size === 0) return 0
  let shared = 0
  for (const term of textTerms) {
    if (queryTerms.has(term)) shared += 1
  }
  // Normalize by the fact's own vocabulary so a short focused fact is not
  // penalized against a long task description.
  return shared / textTerms.size
}

export function passesRelevanceGate(query: string, text: string): boolean {
  return memoryRelevance(query, text) >= MINIMUM_RELEVANCE
}

function relevanceTerms(value: string): Set<string> {
  const terms = new Set<string>()
  const ascii = value.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
  for (const token of ascii) {
    if (token.length >= MINIMUM_ASCII_TOKEN_LENGTH) terms.add(token)
  }
  const wide = value.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of wide) {
    const characters = Array.from(run)
    if (characters.length === 1 && characters[0]) terms.add(characters[0])
    for (let index = 0; index + 1 < characters.length; index += 1) {
      terms.add(characters.slice(index, index + 2).join(''))
    }
  }
  return terms
}
