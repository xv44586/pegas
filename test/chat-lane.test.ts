import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ConversationExecutor,
  conversationPrompt,
} from '../src/executor/conversation-executor.js'
import { EchoExecutor } from '../src/executor/echo-executor.js'
import { createControlPlane } from '../src/control-plane/server.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import type { ExecutionContext, InboxEvent } from '../src/core/domain.js'
import type { Clock } from '../src/core/clock.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelTaskRouter, RuleBasedTaskRouter } from '../src/router/router.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { loadConfig } from '../src/core/config.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  conversationSuggestion,
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

function initializeSettings(store: PegasStore, chatLaneEnabled: boolean): void {
  store.initializeRuntimeSettings({
    ...runtimeSettingsDefaults(loadConfig({})),
    chatLaneEnabled,
  })
}

function userEvent(text: string): InboxEvent {
  return {
    id: `event-${text}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
  }
}

async function routeText(
  store: PegasStore,
  router: ModelTaskRouter | RuleBasedTaskRouter,
  text: string,
): Promise<void> {
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(router, 'echo-test'),
    'router-1',
  )
}

describe('ROUTE-004 reply decision', () => {
  it('classifies an instant reply without answering the content', async () => {
    const provider = new StubProvider({
      kind: 'reply',
      taskId: '',
      title: '',
      goal: '',
      reason: '一句话能答，无副作用',
    })
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(userEvent('今天星期几'), [])

    expect(decision).toEqual({
      kind: 'reply',
      input: '今天星期几',
      reason: '一句话能答，无副作用',
    })
  })

  it('falls back to create_task when the reply decision is malformed', async () => {
    const provider = new StubProvider({ kind: 'reply', reason: '' })
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(userEvent('帮我整理知识库'), [])

    expect(decision).toMatchObject({ kind: 'create_task' })
  })

  it('creates a lightweight conversation Task when the chat lane is on', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const router = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'reply',
        taskId: '',
        title: '',
        goal: '',
        reason: 'casual',
      }),
    })

    await routeText(store, router, '今天星期几')

    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(1)
    const conversationTask = tasks[0]
    if (!conversationTask) throw new Error('Expected a conversation Task')
    expect(conversationTask).toMatchObject({
      kind: 'conversation',
      status: 'unstarted',
    })
    const runs = store.listRuns(conversationTask.id)
    expect(runs[0]?.executionContext.protocol).toBe('conversation-v1')
    expect(() => store.getWorkerProfile(conversationTask.id, 'owner')).toThrow(
      'has no Worker Profile',
    )
    store.close()
  })

  it('falls back to a full Task when the chat lane is off', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, false)
    const router = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'reply',
        taskId: '',
        title: '',
        goal: '',
        reason: 'casual',
      }),
    })

    await routeText(store, router, '今天星期几')

    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.kind).toBe('work')
    store.close()
  })

  it('never offers conversation Tasks as routing candidates', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const replyRouter = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'reply',
        taskId: '',
        title: '',
        goal: '',
        reason: 'casual',
      }),
    })
    await routeText(store, replyRouter, '你好')
    const capturing = new CapturingProvider({
      kind: 'create_task',
      taskId: '',
      title: '新任务',
      goal: '新任务',
      reason: 'new',
    })

    await routeText(
      store,
      new ModelTaskRouter({ provider: capturing }),
      '帮我研究新方案',
    )

    expect(capturing.input).not.toContain('你好')
    expect(store.listRoutingCandidates('owner')).toHaveLength(1)
    store.close()
  })

  it('rejects reply decisions on handback routing', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '来源任务' },
    }).event
    const claimedEvent = store.claimNextEvent('setup-router')
    if (!claimedEvent) throw new Error('Expected the setup event claim')
    store.applyRoutingDecision(
      claimedEvent,
      {
        kind: 'create_task',
        title: '来源',
        goal: '来源',
        input: '来源',
        reason: 't',
      },
      'echo-test',
    )
    store.completeEvent(event.id, 'setup-router')
    const source = store.claimNextRun('setup-worker')
    if (!source) throw new Error('Expected the source Run claim')
    store.createCollaboration(source.run.id, source.claimToken, {
      commandId: 'handback-1',
      kind: 'handback',
      inputEventId: source.task.originEventId,
      reason: '不属于当前目标',
    })
    const handler = new RoutingEventHandler(
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'reply',
          taskId: '',
          title: '',
          goal: '',
          reason: 'casual',
        }),
      }),
      'echo-test',
    )

    await processNextEvent(store, handler, 'router-handback')

    const handback = store
      .listEvents('owner')
      .find(candidate => candidate.type === 'collaboration.handback')
    expect(handback?.status).not.toBe('processed')
    expect(handback?.lastError).toContain('instant replies')
    store.close()
  })
})

describe('EXEC-005 conversation lane', () => {
  it('answers through the Outbox on a rolling conversation session', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const executor = new ConversationExecutor(new EchoExecutor())
    await routeText(
      store,
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'reply',
          taskId: '',
          title: '',
          goal: '',
          reason: 'casual',
        }),
      }),
      '今天星期几',
    )
    const first = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    if (!first) throw new Error('Expected a conversation Run claim')
    await executeClaimedRun(
      store,
      executor,
      first,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    const task = store.findTask(first.task.id, 'owner')
    expect(task?.status).toBe('completed')
    const outbox = store.listOutbox('owner')
    expect(outbox).toHaveLength(2)
    expect(outbox[0]?.payload).toMatchObject({
      type: 'agent.message',
    })
    expect((outbox[0]?.payload as { text: string }).text).toContain(
      '今天星期几',
    )
    expect(outbox[1]?.payload).toMatchObject({ type: 'run.completed' })
    expect(outbox[1]?.projection).toMatchObject({ weight: 'silent' })
    const sessionRef = store.conversationSessionRef('owner')
    expect(sessionRef).toBeTruthy()

    await routeText(
      store,
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'reply',
          taskId: '',
          title: '',
          goal: '',
          reason: 'casual',
        }),
      }),
      '那明天呢',
    )
    const second = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    if (!second) throw new Error('Expected the second conversation Run claim')
    expect(second.run.taskId).not.toBe(first.task.id)
    const capturing = new CapturingExecutor()
    await executeClaimedRun(
      store,
      new ConversationExecutor(capturing),
      second,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(capturing.input?.resumeSessionId).toBe(sessionRef)
    store.close()
  })

  it('routes an owned reply reference to its original session and ignores the rolling session', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const router = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'reply',
        taskId: '',
        title: '',
        goal: '',
        reason: 'casual',
      }),
    })
    await routeText(store, router, 'First conversation')
    const original = store.claimNextRun(
      'chat-original',
      30_000,
      undefined,
      'conversation',
    )
    if (!original) throw new Error('Expected the original conversation Run')
    store.streamSayFromRun(
      original.run.id,
      'chat-original',
      'Selected answer about budget',
      { streaming: false },
    )
    store.completeRun(original.run.id, 'chat-original', {
      executorRef: 'original-chat-session',
      output: 'Selected answer about budget',
    })
    const reply = store
      .listOutbox('owner')
      .find(message => message.projection?.lane === 'say')
    if (!reply) throw new Error('Expected the original answer')
    store.recordConversationSessionRef('owner', 'later-rolling-session')

    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const post = (userId: string, payload: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${String(port)}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            userId,
            type: 'user.message',
            source: 'web',
            dedupeKey: 'follow-up',
            payload,
          }),
        })
      expect(
        (
          await post('another-owner', {
            text: 'Explain',
            replyToMessageId: reply.id,
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await post('owner', {
            text: 'Explain',
            replyToMessageId: reply.id,
            taskId: original.task.id,
          })
        ).status,
      ).toBe(400)
      const accepted = await post('owner', {
        text: 'Explain the second figure',
        replyToMessageId: reply.id,
      })
      expect(accepted.status).toBe(202)
      expect(
        (
          await post('owner', {
            text: 'Explain the second figure',
            replyToMessageId: reply.id,
          })
        ).status,
      ).toBe(200)

      const unrelated = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: 'An unrelated message' },
      }).event
      expect(store.claimNextEvent('legacy-worker', 30_000, 2)?.payload).toEqual(
        { text: 'An unrelated message' },
      )
      store.releaseEventClaim(unrelated.id, 'legacy-worker')
      const handler = new RoutingEventHandler(
        new RuleBasedTaskRouter(),
        'echo-test',
      )
      await processNextEvent(store, handler, 'router', undefined, {
        collectWindowMs: 40,
      })
      const followUp = store.claimNextRun(
        'chat-follow-up',
        30_000,
        undefined,
        'conversation',
      )
      if (!followUp) throw new Error('Expected the follow-up conversation Run')
      expect(followUp.task.id).toBe(original.task.id)
      expect(followUp.run.input).toContain('Selected answer about budget')
      expect(followUp.run.input).toContain('Explain the second figure')
      expect(followUp.run.input).not.toContain('An unrelated message')

      const executor = new CapturingExecutor()
      await executeClaimedRun(
        store,
        executor,
        followUp,
        'chat-follow-up',
        process.cwd(),
        new AbortController().signal,
        'http://127.0.0.1:4317',
      )
      expect(executor.input?.resumeSessionId).toBe('original-chat-session')
      expect(store.conversationSessionRef('owner')).toBe(
        'later-rolling-session',
      )
      expect(store.listRuns(original.task.id)).toHaveLength(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('replays a quoted follow-up merged into a queued work Run only once', async () => {
    const store = new PegasStore(':memory:')
    try {
      const handler = new RoutingEventHandler(
        new RuleBasedTaskRouter(),
        'echo-test',
      )
      await routeText(store, new RuleBasedTaskRouter(), 'Review the budget')
      const task = store.listTasks('owner')[0]
      if (!task) throw new Error('Expected a work Task')
      const first = store.claimNextRun('work-first')
      if (!first) throw new Error('Expected the first work Run')
      store.completeRun(first.run.id, 'work-first', {
        executorRef: 'budget-session',
        output: 'The selected work result',
      })
      const reply = store
        .listOutbox('owner')
        .find(message => message.taskId === task.id)
      if (!reply) throw new Error('Expected the work result')
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: 'Update the chart', taskId: task.id },
      })
      await processNextEvent(store, handler, 'router')

      const quote = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: {
          text: 'Explain the source of that number',
          replyToMessageId: reply.id,
        },
      }).event
      const claimed = store.claimNextEvent('router')
      if (claimed?.id !== quote.id)
        throw new Error('Expected the follow-up claim')
      await handler.handle(claimed, store)
      // Simulate a worker restart between committing the routing decision and
      // completing the durable event.
      store.releaseEventClaim(claimed.id, 'router')
      await processNextEvent(store, handler, 'router-retry')

      const runs = store.listRuns(task.id)
      expect(runs).toHaveLength(2)
      expect(runs[1]?.input).toContain('The selected work result')
      expect(
        runs[1]?.input.match(/Explain the source of that number/g),
      ).toHaveLength(1)
      expect(
        store.listEvents('owner').find(event => event.id === quote.id)?.status,
      ).toBe('processed')
    } finally {
      store.close()
    }
  })

  it('keeps chat and heavy Run claims in separate lanes', () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const workEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '整理知识库' },
    }).event
    store.applyRoutingDecision(
      workEvent,
      {
        kind: 'create_task',
        title: '整理',
        goal: '整理',
        input: '整理',
        reason: 't',
      },
      'echo-test',
    )
    const chatEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '你好' },
    }).event
    store.applyRoutingDecision(
      chatEvent,
      { kind: 'reply', input: '你好', reason: 'casual' },
      'echo-test',
      {
        executor: 'echo-test',
        protocol: 'conversation-v1',
        permissions: JSON.stringify({
          mode: 'read-only',
          approvalPolicy: 'never',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      },
    )

    const work = store.claimNextRun('heavy-worker', 30_000, undefined, 'work')
    const chat = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    const moreWork = store.claimNextRun(
      'heavy-worker-2',
      30_000,
      undefined,
      'work',
    )
    const moreChat = store.claimNextRun(
      'chat-worker-2',
      30_000,
      undefined,
      'conversation',
    )

    expect(work?.task.kind).toBe('work')
    expect(chat?.task.kind).toBe('conversation')
    expect(moreWork).toBeUndefined()
    expect(moreChat).toBeUndefined()
    store.close()
  })

  it('upgrades suggest_task into a full Task through the Durable Inbox', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    await routeText(
      store,
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'reply',
          taskId: '',
          title: '',
          goal: '',
          reason: 'casual',
        }),
      }),
      '帮我改一下登录代码',
    )
    const claimed = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    if (!claimed) throw new Error('Expected a conversation Run claim')
    const suggesting: RunExecutor = {
      name: 'echo-test',
      execute: input =>
        Promise.resolve({
          executorRef: `chat-${input.runId}`,
          output:
            '这需要修改代码，我把它作为正式任务处理。\nPEGAS_SUGGEST_TASK_BEGIN\n修改登录代码并补充回归测试\nPEGAS_SUGGEST_TASK_END',
        }),
    }
    await executeClaimedRun(
      store,
      suggesting,
      claimed,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    const chatTask = store.findTask(claimed.task.id, 'owner')
    expect(chatTask?.status).toBe('completed')
    const outbox = store.listOutbox('owner')
    expect(outbox[0]?.payload).toMatchObject({
      type: 'agent.message',
      text: '这需要修改代码，我把它作为正式任务处理。',
    })

    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'router-2',
    )
    const tasks = store.listTasks('owner')
    const work = tasks.find(task => task.kind === 'work')
    expect(work?.goal).toBe('修改登录代码并补充回归测试')
    if (!work) throw new Error('Expected the upgraded work Task')
    expect(store.listRuns(work.id)[0]?.status).toBe('queued')
    store.close()
  })

  it('parses suggest_task markers strictly', () => {
    expect(conversationSuggestion('普通回答')).toBeUndefined()
    expect(
      conversationSuggestion(
        'PEGAS_SUGGEST_TASK_BEGIN\n目标\nPEGAS_SUGGEST_TASK_END',
      ),
    ).toEqual({ goal: '目标' })
    expect(
      conversationSuggestion(
        '说明\nPEGAS_SUGGEST_TASK_BEGIN\n目标\nPEGAS_SUGGEST_TASK_END',
      ),
    ).toEqual({ goal: '目标', reply: '说明' })
    expect(
      conversationSuggestion(
        'PEGAS_SUGGEST_TASK_BEGIN\n\nPEGAS_SUGGEST_TASK_END',
      ),
    ).toBeUndefined()
    expect(
      conversationSuggestion('PEGAS_SUGGEST_TASK_BEGIN\n未闭合'),
    ).toBeUndefined()
    expect(
      conversationSuggestion(
        'PEGAS_SUGGEST_TASK_BEGIN 单行目标 PEGAS_SUGGEST_TASK_END',
      ),
    ).toBeUndefined()
  })

  it('keeps the conversation prompt zero-acknowledgement and read-only', () => {
    const prompt = conversationPrompt({ prompt: '今天星期几' })
    expect(prompt).toContain('pegas_conversation_contract')
    expect(prompt).toContain('零确认')
    expect(prompt).toContain('PEGAS_SUGGEST_TASK_BEGIN')
    expect(prompt).toContain('只读')
  })

  it('suppresses acknowledgement progress events in the conversation lane', async () => {
    const inner: RunExecutor = {
      name: 'echo-test',
      execute: input => {
        input.onProgress?.({ type: 'acknowledgement', text: '收到，我来查' })
        return Promise.resolve({ executorRef: 's', output: '星期六' })
      },
    }
    const executor = new ConversationExecutor(inner)
    let progressCalls = 0
    const result = await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: '今天星期几',
      workingDirectory: process.cwd(),
      onProgress: () => {
        progressCalls += 1
      },
    })
    expect(result.output).toBe('星期六')
    expect(progressCalls).toBe(0)
  })

  it('resumes the conversation session after a Worker crash', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-chat-crash-'))
    const path = join(directory, 'pegas.sqlite')
    const clock = new SteppingClock('2026-11-22T00:00:00.000Z')
    const store = new PegasStore(path, { clock })
    initializeSettings(store, true)
    const replyRouter = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'reply',
        taskId: '',
        title: '',
        goal: '',
        reason: 'casual',
      }),
    })
    await routeText(store, replyRouter, '今天星期几')
    const first = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    if (!first) throw new Error('Expected a conversation Run claim')
    const sessionExecutor = new ConversationExecutor(
      new CapturingExecutor('chat-session-1'),
    )
    await executeClaimedRun(
      store,
      sessionExecutor,
      first,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(store.conversationSessionRef('owner')).toBe('chat-session-1')

    await routeText(store, replyRouter, '那明天呢')
    const crashed = store.claimNextRun(
      'chat-worker',
      30_000,
      undefined,
      'conversation',
    )
    if (!crashed) throw new Error('Expected the second conversation Run claim')
    store.close()

    clock.advance(60_000)
    const recovered = new PegasStore(path, { clock })
    const reclaimed = recovered.claimNextRun(
      'chat-worker-2',
      30_000,
      undefined,
      'conversation',
    )
    expect(reclaimed?.run.retryOfRunId).toBe(crashed.run.id)
    expect(reclaimed?.task.id).toBe(crashed.task.id)
    if (!reclaimed) throw new Error('Expected the reclaimed conversation Run')
    const capturing = new CapturingExecutor('chat-session-1')
    await executeClaimedRun(
      recovered,
      new ConversationExecutor(capturing),
      reclaimed,
      'chat-worker-2',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(capturing.input?.resumeSessionId).toBe('chat-session-1')
    expect(recovered.findTask(crashed.task.id, 'owner')?.status).toBe(
      'completed',
    )
    expect(recovered.listOutbox('owner')).toHaveLength(4)
    recovered.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('never mints a Worker Profile row for conversation Tasks', () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '你好' },
    }).event
    const claimedEvent = store.claimNextEvent('setup-router')
    if (!claimedEvent) throw new Error('Expected the setup event claim')
    const { task } = store.applyRoutingDecision(
      claimedEvent,
      { kind: 'reply', input: '你好', reason: 'casual' },
      'echo-test',
      conversationContext(),
    )
    store.completeEvent(event.id, 'setup-router')
    expect(task.kind).toBe('conversation')
    expect(() => store.getWorkerProfile(task.id, 'owner')).toThrow(
      'has no Worker Profile',
    )
    store.close()
  })

  it('continues a conversation Task on the read-only lane without requiring a Worker Profile', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '你好' },
    }).event
    const claimedEvent = store.claimNextEvent('setup-router')
    if (!claimedEvent) throw new Error('Expected the setup event claim')
    const { task } = store.applyRoutingDecision(
      claimedEvent,
      { kind: 'reply', input: '你好', reason: 'casual' },
      'echo-test',
      conversationContext(),
    )
    store.completeEvent(event.id, 'setup-router')
    const initialRun = store.listRuns(task.id)[0]
    if (!initialRun) throw new Error('Expected the setup Run')
    const claimedRun = store.claimNextRun('setup-executor')
    if (!claimedRun) throw new Error('Expected the setup Run claim')
    store.completeRun(claimedRun.run.id, 'setup-executor', {
      executorRef: 'session-setup',
      output: '你好！',
    })

    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { taskId: task.id, text: '再讲讲' },
    })
    const handler = new RoutingEventHandler(
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'continue_task',
          taskId: task.id,
          title: '',
          goal: '',
          reason: 'explicit reference',
        }),
      }),
      'echo-test',
      profileTask =>
        store.resolveWorkerExecutionContext(profileTask.id, 'owner', {
          executor: 'echo-test',
          workspace: '/workspace',
          protocol: 'dsh-headless-v1',
        }),
    )
    await processNextEvent(store, handler, 'router-continue')

    const runs = store.listRuns(task.id)
    const continuation = runs.find(run => run.originEventId !== event.id)
    if (!continuation) throw new Error('Expected the continuation Run')
    expect(continuation.executionContext).toMatchObject({
      protocol: 'conversation-v1',
    })
    expect(continuation.executionContext.permissions).toContain('read-only')
    expect(() => store.getWorkerProfile(task.id, 'owner')).toThrow(
      'has no Worker Profile',
    )
    store.close()
  })

  it('hides conversation Tasks from Channel search and the Channel list', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    await routeText(
      store,
      new ModelTaskRouter({
        provider: new StubProvider({
          kind: 'reply',
          taskId: '',
          title: '',
          goal: '',
          reason: 'casual',
        }),
      }),
      '今天星期几',
    )
    const search = store.searchChannels('owner', { limit: 50 })
    expect(search.channels).toHaveLength(0)
    expect(
      store.searchChannels('owner', { query: '星期', limit: 50 }).channels,
    ).toHaveLength(0)

    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/channels?userId=owner`,
        { headers: { authorization: 'Bearer secret' } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ channels: [] })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('preserves the chat lane switch across settings saves that omit it', () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store, true)
    const current = store.getRuntimeSettings()
    const updated = store.updateRuntimeSettings(current.revision, {
      ...current,
      modelName: 'gpt-updated',
      chatLaneEnabled: undefined,
    })
    expect(updated.chatLaneEnabled).toBe(true)
    const disabled = store.updateRuntimeSettings(updated.revision, {
      ...updated,
      chatLaneEnabled: false,
    })
    expect(disabled.chatLaneEnabled).toBe(false)
    const preserved = store.updateRuntimeSettingsAndProvider(
      disabled.revision,
      { ...disabled, chatLaneEnabled: undefined },
      {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        clearApiKey: false,
      },
    )
    expect(preserved.chatLaneEnabled).toBe(false)
    store.close()
  })
})

function conversationContext(): ExecutionContext {
  return {
    executor: 'echo-test',
    protocol: 'conversation-v1',
    permissions: JSON.stringify({
      mode: 'read-only',
      approvalPolicy: 'never',
      additionalDirectories: [],
      privacyMode: 'disabled',
    }),
  }
}

class SteppingClock implements Clock {
  #now: Date

  constructor(value: string) {
    this.#now = new Date(value)
  }

  now(): Date {
    return new Date(this.#now)
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds)
  }
}

class StubProvider implements JsonModelProvider {
  readonly name = 'stub'
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(): Promise<unknown> {
    return Promise.resolve(this.#answer)
  }
}

class CapturingProvider implements JsonModelProvider {
  readonly name = 'capturing-stub'
  input = ''
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(request: { input: string }): Promise<unknown> {
    this.input = request.input
    return Promise.resolve(this.#answer)
  }
}

class CapturingExecutor implements RunExecutor {
  readonly name = 'echo-test'
  input?: ExecutorInput
  readonly #sessionRef?: string

  constructor(sessionRef?: string) {
    this.#sessionRef = sessionRef
  }

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    this.input = input
    return Promise.resolve({
      executorRef:
        this.#sessionRef ?? input.resumeSessionId ?? `echo-${input.runId}`,
      output: '星期六',
    })
  }
}
