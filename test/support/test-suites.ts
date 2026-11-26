// Paid model acceptance is a separate, explicit test lane.
export const liveTestInclude = [
  'test/policy-gate-integration.test.ts',
  'test/dsh-readonly-surface-integration.test.ts',
  'test/routing-rules-live-integration.test.ts',
  'test/chat-lane-live-integration.test.ts',
] as const
