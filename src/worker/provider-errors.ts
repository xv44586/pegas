/**
 * PLAN-001 P3 failure classification. Provider terminal errors (bad
 * credentials, missing model, forbidden access) will not heal through the
 * retry chain; the first occurrence parks the Task for a human condition
 * change instead of burning retry budget. Everything else stays transient
 * and keeps the existing lease/retry recovery semantics.
 */
export function isTerminalProviderError(message: string): boolean {
  return (
    /Model provider returned (401|403|404)\b/.test(message) ||
    /\b(401|403)\b.*(unauthorized|forbidden|invalid.*api.?key|authentication)/i.test(
      message,
    ) ||
    /model.*(not found|does not exist|unknown model)/i.test(message) ||
    /Missing API key for|No API key for provider:|no credential for provider route/i.test(
      message,
    ) ||
    /invalid_api_key|authentication_error|permission_error|model_not_found/i.test(
      message,
    )
  )
}
