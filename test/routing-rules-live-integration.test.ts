import { describe, expect, it } from 'vitest'

import { OpenAiCompatibleProvider } from '../src/model/openai-compatible-provider.js'
import { ModelTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const gatewayReachable = await localGatewayReachable()

async function localGatewayReachable(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:3425/v1/models', {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

describe.skipIf(!gatewayReachable)(
  'ROUTE-005 real router model with user routing rules',
  () => {
    it('honors a matching rule with evidence and stays conservative without a hit', async () => {
      const store = new PegasStore(':memory:')
      try {
        const rule = store.createRoutingRule({
          userId: 'owner',
          commandId: 'live-rule',
          rule: {
            title: '星际咖啡馆项目归类',
            content:
              '消息提到「星际咖啡馆」时，如果候选中存在标题含「星际咖啡馆」的开放事情，优先 continue_task 该事情；没有候选时 create_task 且标题以「星际咖啡馆」开头。',
            enabled: true,
          },
        })
        const router = new ModelTaskRouter({
          provider: new OpenAiCompatibleProvider({
            baseUrl: 'http://127.0.0.1:3425/v1',
            model: 'qwen-cn-2/qwen4-max',
            apiKey: 'placeholder-key',
            timeoutMs: 60_000,
          }),
          routingRules: store.routingRuleContextForUser('owner'),
        })
        const hit = await router.route(
          {
            id: 'live-event-1',
            userId: 'owner',
            type: 'user.message',
            source: 'web',
            payload: { text: '星际咖啡馆的菜单再加一款冷萃' },
            status: 'pending',
            attempts: 0,
            createdAt: new Date().toISOString(),
          },
          [],
        )
        expect(hit).toMatchObject({ kind: 'create_task' })
        if (hit?.kind !== 'create_task') throw new Error('expected create_task')
        expect(hit.title).toContain('星际咖啡馆')
        expect(hit.matchedRuleId).toBe(rule.id)

        const miss = await router.route(
          {
            id: 'live-event-2',
            userId: 'owner',
            type: 'user.message',
            source: 'web',
            payload: { text: '帮我调研一下家用 NAS 的选购要点' },
            status: 'pending',
            attempts: 0,
            createdAt: new Date().toISOString(),
          },
          [],
        )
        expect(miss).toMatchObject({ kind: 'create_task' })
        expect(miss?.matchedRuleId ?? '').not.toBe(rule.id)
      } finally {
        store.close()
      }
    }, 180_000)
  },
)
