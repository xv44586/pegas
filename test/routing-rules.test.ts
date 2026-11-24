import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  parseRoutingRuleCreate,
  parseRoutingRuleDraft,
  type RoutingRuleDraft,
} from '../src/rules/routing-rules.js'
import {
  PegasStore,
  RoutingRuleCommandConflictError,
  RoutingRuleLimitError,
  RoutingRuleNotFoundError,
  RoutingRuleRevisionConflictError,
} from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('routing rules', () => {
  it('validates routing rule contracts', () => {
    expect(
      parseRoutingRuleDraft({
        title: '提到 X 项目优先进 X 事情',
        content: '消息提到 X 项目时，优先归入标题含 X 的开放事情。',
        enabled: true,
      }),
    ).toEqual({
      title: '提到 X 项目优先进 X 事情',
      content: '消息提到 X 项目时，优先归入标题含 X 的开放事情。',
      enabled: true,
    })
    expect(() =>
      parseRoutingRuleDraft({ title: 'x', content: 'y', enabled: 'yes' }),
    ).toThrow('rule.enabled must be a boolean')
    expect(() =>
      parseRoutingRuleDraft({ title: ' ', content: 'y', enabled: true }),
    ).toThrow('rule.title is required')
    expect(() =>
      parseRoutingRuleDraft({
        title: 'x'.repeat(121),
        content: 'y',
        enabled: true,
      }),
    ).toThrow('rule.title is too long')
    expect(() =>
      parseRoutingRuleDraft({
        title: 'x',
        content: 'y'.repeat(2001),
        enabled: true,
      }),
    ).toThrow('rule.content is too long')
    expect(() =>
      parseRoutingRuleCreate({
        userId: 'owner',
        commandId: 'cmd',
        rule: ruleDraft(),
        extra: true,
      }),
    ).toThrow('Unexpected field: extra')
  })

  it('persists idempotent commands, revisions, and owner isolation across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-routing-rules-store-'))
    const databasePath = join(directory, 'pegas.sqlite')
    let store = new PegasStore(databasePath)
    const command = {
      userId: 'owner',
      commandId: 'routing-rule-create-1',
      rule: ruleDraft(),
    }
    const created = store.createRoutingRule(command)
    expect(created).toMatchObject({ ...ruleDraft(), revision: 1 })
    expect(store.createRoutingRule(command)).toEqual(created)
    expect(() =>
      store.createRoutingRule({
        ...command,
        rule: { ...command.rule, content: '另一个内容' },
      }),
    ).toThrow(RoutingRuleCommandConflictError)
    expect(store.listRoutingRules('owner').items).toEqual([created])
    expect(store.listRoutingRules('other').items).toEqual([])
    expect(store.findRoutingRule(created.id, 'other')).toBeUndefined()

    const updated = store.updateRoutingRule(created.id, {
      userId: 'owner',
      commandId: 'routing-rule-update-1',
      expectedRevision: 1,
      rule: ruleDraft({ content: '更新后的归类规则', enabled: false }),
    })
    expect(updated).toMatchObject({
      content: '更新后的归类规则',
      enabled: false,
      revision: 2,
    })
    expect(() =>
      store.updateRoutingRule(created.id, {
        userId: 'owner',
        commandId: 'routing-rule-update-stale',
        expectedRevision: 1,
        rule: ruleDraft(),
      }),
    ).toThrow(RoutingRuleRevisionConflictError)
    expect(() =>
      store.deleteRoutingRule(created.id, {
        userId: 'other',
        commandId: 'routing-rule-delete-cross',
        expectedRevision: 2,
      }),
    ).toThrow(RoutingRuleNotFoundError)
    const deletion = store.deleteRoutingRule(created.id, {
      userId: 'owner',
      commandId: 'routing-rule-delete-1',
      expectedRevision: 2,
    })
    expect(deletion).toMatchObject({ id: created.id, deleted: true })
    expect(store.listRoutingRules('owner').items).toEqual([])
    expect(() =>
      store.updateRoutingRule(created.id, {
        userId: 'owner',
        commandId: 'routing-rule-update-1',
        expectedRevision: 1,
        rule: ruleDraft({ content: '更新后的归类规则', enabled: false }),
      }),
    ).toThrow(RoutingRuleNotFoundError)
    expect(
      store.deleteRoutingRule(created.id, {
        userId: 'owner',
        commandId: 'routing-rule-delete-1',
        expectedRevision: 2,
      }),
    ).toEqual(deletion)
    store.close()

    store = new PegasStore(databasePath)
    expect(store.findRoutingRule(created.id, 'owner')).toBeUndefined()
    store.close()
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  })

  it('caps stored routing rules per user at 50', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    for (let index = 0; index < 50; index += 1)
      store.createRoutingRule({
        userId: 'owner',
        commandId: `routing-rule-cap-${String(index)}`,
        rule: ruleDraft({ title: `归类规则 ${String(index)}` }),
      })
    expect(() =>
      store.createRoutingRule({
        userId: 'owner',
        commandId: 'routing-rule-cap-overflow',
        rule: ruleDraft(),
      }),
    ).toThrow(RoutingRuleLimitError)
    expect(
      store.createRoutingRule({
        userId: 'other',
        commandId: 'routing-rule-cap-other',
        rule: ruleDraft(),
      }),
    ).toMatchObject({ userId: 'other' })
    store.deleteRoutingRule(
      store.listRoutingRules('owner').items[0]?.id ?? '',
      {
        userId: 'owner',
        commandId: 'routing-rule-cap-release',
        expectedRevision: 1,
      },
    )
    expect(
      store.createRoutingRule({
        userId: 'owner',
        commandId: 'routing-rule-cap-after-release',
        rule: ruleDraft(),
      }),
    ).toMatchObject({ revision: 1 })
  })

  it('lists rules newest-first with cursor pagination and owner isolation', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const created = [0, 1, 2].map(index =>
      store.createRoutingRule({
        userId: 'owner',
        commandId: `routing-rule-page-${String(index)}`,
        rule: ruleDraft({ title: `规则 ${String(index)}` }),
      }),
    )
    store.createRoutingRule({
      userId: 'other',
      commandId: 'routing-rule-page-other',
      rule: ruleDraft({ title: '他人规则' }),
    })
    const firstPage = store.listRoutingRules('owner', 2)
    expect(firstPage.items.map(rule => rule.id)).toEqual([
      created[2]?.id,
      created[1]?.id,
    ])
    expect(firstPage.nextCursor).toBe(created[1]?.id)
    const secondPage = store.listRoutingRules('owner', 2, firstPage.nextCursor)
    expect(secondPage.items.map(rule => rule.id)).toEqual([created[0]?.id])
    expect(secondPage.nextCursor).toBeUndefined()
    expect(() => store.listRoutingRules('owner', 0)).toThrow()
    expect(() => store.listRoutingRules('owner', 2, 'missing-cursor')).toThrow(
      'Routing rule cursor is invalid',
    )
  })

  it('exposes owner-scoped HTTP CRUD with stable errors', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const create = await fetch(`${base}/v1/routing-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'http-routing-rule-create',
        rule: ruleDraft(),
      }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as {
      rule: { id: string; revision: number }
    }
    expect(
      await (await fetch(`${base}/v1/routing-rules?userId=other`)).json(),
    ).toEqual({ rules: [] })
    const crossOwner = await fetch(
      `${base}/v1/routing-rules/${created.rule.id}?userId=other`,
    )
    expect(crossOwner.status).toBe(404)
    expect(await crossOwner.json()).toEqual({ error: 'not_found' })

    const update = await fetch(`${base}/v1/routing-rules/${created.rule.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'http-routing-rule-update',
        expectedRevision: created.rule.revision,
        rule: ruleDraft({ enabled: false }),
      }),
    })
    expect(update.status).toBe(200)
    const conflict = await fetch(
      `${base}/v1/routing-rules/${created.rule.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-routing-rule-update-stale',
          expectedRevision: created.rule.revision,
          rule: ruleDraft(),
        }),
      },
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'routing_rule_conflict' })
    const commandConflict = await fetch(
      `${base}/v1/routing-rules/${created.rule.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-routing-rule-update',
          expectedRevision: created.rule.revision,
          rule: ruleDraft(),
        }),
      },
    )
    expect(commandConflict.status).toBe(409)
    expect(await commandConflict.json()).toEqual({
      error: 'routing_rule_command_conflict',
    })

    const deletion = await fetch(
      `${base}/v1/routing-rules/${created.rule.id}/delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-routing-rule-delete',
          expectedRevision: 2,
        }),
      },
    )
    expect(deletion.status).toBe(200)
    expect(await deletion.json()).toMatchObject({
      deletion: { id: created.rule.id, deleted: true },
    })
    const invalidLimit = await fetch(
      `${base}/v1/routing-rules?userId=owner&limit=0`,
    )
    expect(invalidLimit.status).toBe(400)
    for (let index = 0; index < 50; index += 1)
      store.createRoutingRule({
        userId: 'owner',
        commandId: `http-routing-rule-cap-${String(index)}`,
        rule: ruleDraft({ title: `规则 ${String(index)}` }),
      })
    const overflow = await fetch(`${base}/v1/routing-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'http-routing-rule-cap-overflow',
        rule: ruleDraft(),
      }),
    })
    expect(overflow.status).toBe(409)
    expect(await overflow.json()).toEqual({ error: 'routing_rule_limit' })
  })

  it('requires the instance bearer for routing rule endpoints', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_r9k2m4x7}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const anonymous = await fetch(`${base}/v1/routing-rules?userId=owner`)
    expect(anonymous.status).toBe(401)
    const authorized = await fetch(`${base}/v1/routing-rules?userId=owner`, {
      headers: { authorization: 'Bearer {{SECRET_r9k2m4x7}}' },
    })
    expect(authorized.status).toBe(200)
  })
})

function ruleDraft(
  overrides: Partial<RoutingRuleDraft> = {},
): RoutingRuleDraft {
  return {
    title: '提到 X 项目优先进 X 事情',
    content: '消息提到 X 项目时，优先归入标题含 X 的开放事情。',
    enabled: true,
    ...overrides,
  }
}
