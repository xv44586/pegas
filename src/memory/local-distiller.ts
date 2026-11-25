import type { JsonModelProvider } from '../model/provider.js'
import type {
  LocalMemoryCandidate,
  LocalMemoryDistiller,
} from './local-provider.js'

const SYSTEM_PROMPT = `You distill durable memory from one finished agent task.
Return strict JSON: {"memories":[{"text":"...","type":"world|experience|observation","scope":"global|context"}]}

Rules:
- Save only facts worth recalling in a FUTURE task: verified outcomes, proven
  procedures, decisions with reasons, environment facts, failure lessons with
  the recovery that worked.
- Do NOT save: task progress, one-off details (file paths of transient
  artifacts, current status), generic advice, secrets, guesses, or anything
  already obvious from the task title.
- type: world = stable fact; experience = proven method or failure lesson;
  observation = weaker single-run signal.
- scope: global only for user-wide preferences or cross-project facts;
  context for anything specific to this project or workspace.
- Each text is one self-contained sentence or two, in the language of the
  evidence. At most 5 memories. Return {"memories":[]} when nothing durable
  was learned.`

/**
 * MEMORY-001 M2: one bounded model call per retain job, through the same
 * configured control-plane channel as EXEC-006 summaries. Malformed model
 * output degrades to "nothing learned" instead of failing the job; transport
 * errors propagate so the job retry/backoff path (MODEL-001) applies.
 */
export function createLocalMemoryDistiller(
  provider: JsonModelProvider,
): LocalMemoryDistiller {
  return async ({ evidence, context }) => {
    const result = await provider.generateJson({
      system: SYSTEM_PROMPT,
      input: `Context: ${context}\n\nEvidence:\n${evidence}`,
    })
    return parseCandidates(result)
  }
}

function parseCandidates(value: unknown): LocalMemoryCandidate[] {
  if (typeof value !== 'object' || value === null) return []
  const memories = (value as { memories?: unknown }).memories
  if (!Array.isArray(memories)) return []
  const candidates: LocalMemoryCandidate[] = []
  for (const item of memories) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const type = record.type
    const scope = record.scope
    if (!text) continue
    if (type !== 'world' && type !== 'experience' && type !== 'observation')
      continue
    candidates.push({
      text,
      type,
      scope: scope === 'global' ? 'global' : 'context',
    })
  }
  return candidates
}
