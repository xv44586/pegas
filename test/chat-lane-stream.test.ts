import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import {
  ConversationExecutor,
  conversationProgressText,
} from '../src/executor/conversation-executor.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { ModelTaskRouter } from '../src/router/router.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fakeDsh(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-chat-stream-dsh-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'dsh')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

class ReplyProvider implements JsonModelProvider {
  readonly name = 'reply-stub'

  generateJson(): Promise<unknown> {
    return Promise.resolve({
      kind: 'reply',
      taskId: '',
      title: '',
      goal: '',
      reason: 'casual',
    })
  }
}

async function seedConversationClaim(store: PegasStore, text: string) {
  store.initializeRuntimeSettings({
    ...runtimeSettingsDefaults(loadConfig({})),
    chatLaneEnabled: true,
  })
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(
      new ModelTaskRouter({ provider: new ReplyProvider() }),
      'echo-test',
    ),
    'chat-worker',
  )
  const claimed = store.claimNextRun(
    'chat-worker',
    30_000,
    undefined,
    'conversation',
  )
  if (!claimed) throw new Error('Expected a conversation Run claim')
  return claimed
}

function streamingExecutor(options: {
  chunks: readonly string[]
  output: string
  crashAfter?: number
}): RunExecutor {
  return {
    name: 'stream-test',
    execute: async (input: ExecutorInput): Promise<ExecutorResult> => {
      input.onExecutorRef?.('session-stream')
      let emitted = 0
      for (const chunk of options.chunks) {
        if (options.crashAfter !== undefined && emitted >= options.crashAfter)
          break
        input.onProgress?.({ type: 'message', text: chunk })
        emitted += 1
        await Promise.resolve()
      }
      if (options.crashAfter !== undefined)
        throw new Error('executor crashed mid-stream')
      return { executorRef: 'session-stream', output: options.output }
    },
  }
}

describe('EXEC-005 say streaming', () => {
  it('streams conversation body deltas into one coalesced say fact and settles without a duplicate bubble', async () => {
    const store = new PegasStore(':memory:')
    const claimed = await seedConversationClaim(store, '今天星期几')
    const observed: string[] = []
    const inner = streamingExecutor({
      chunks: ['今天', '是星期六。'],
      output: '今天是星期六。',
    })
    const executor: RunExecutor = {
      name: inner.name,
      execute: async input => {
        return inner.execute({
          ...input,
          onProgress: event => {
            input.onProgress?.(event)
            observed.push(
              ...store
                .listOutbox('owner')
                .filter(
                  message =>
                    (message.payload as { type?: string }).type ===
                    'agent.message',
                )
                .map(message => (message.payload as { text: string }).text),
            )
          },
        })
      },
    }
    await executeClaimedRun(
      store,
      new ConversationExecutor(executor),
      claimed,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(observed).toContain('今天')
    const outbox = store.listOutbox('owner')
    const say = outbox.filter(
      message =>
        (message.payload as { type?: string }).type === 'agent.message',
    )
    expect(say).toHaveLength(1)
    expect(say[0]?.payload).toMatchObject({
      type: 'agent.message',
      runId: claimed.run.id,
      text: '今天是星期六。',
    })
    expect(say[0]?.projection).toMatchObject({ lane: 'say', weight: 'inline' })
    expect((say[0]?.payload as { streaming?: boolean }).streaming).not.toBe(
      true,
    )
    const completed = outbox.filter(
      message =>
        (message.payload as { type?: string }).type === 'run.completed',
    )
    expect(completed).toHaveLength(1)
    expect((completed[0]?.payload as { text?: string }).text).toBeUndefined()
    expect(completed[0]?.projection).toMatchObject({
      lane: 'work',
      weight: 'silent',
    })
    expect(store.findTask(claimed.task.id, 'owner')?.status).toBe('completed')
    store.close()
  })

  it('keeps streamed text visible when the executor crashes mid-stream', async () => {
    const store = new PegasStore(':memory:')
    const claimed = await seedConversationClaim(store, '今天星期几')
    await executeClaimedRun(
      store,
      new ConversationExecutor(
        streamingExecutor({
          chunks: ['今天', '是星期六。'],
          output: '今天是星期六。',
          crashAfter: 1,
        }),
      ),
      claimed,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const outbox = store.listOutbox('owner')
    const say = outbox.filter(
      message =>
        (message.payload as { type?: string }).type === 'agent.message',
    )
    expect(say).toHaveLength(1)
    expect(say[0]?.payload).toMatchObject({ text: '今天', streaming: true })
    const failed = outbox.filter(
      message => (message.payload as { type?: string }).type === 'run.failed',
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.projection).toMatchObject({ lane: 'work' })
    store.close()
  })

  it('never streams the suggest_task marker block and keeps the upgrade path', async () => {
    const store = new PegasStore(':memory:')
    const claimed = await seedConversationClaim(store, '帮我改文件')
    const goal = '把报告导出为 PDF'
    await executeClaimedRun(
      store,
      new ConversationExecutor(
        streamingExecutor({
          chunks: [
            '这需要正式任务处理。',
            `\nPEGAS_SUGGEST_TASK_BEGIN\n${goal}\nPEGAS_SUGGEST_TASK_END`,
          ],
          output: `这需要正式任务处理。\nPEGAS_SUGGEST_TASK_BEGIN\n${goal}\nPEGAS_SUGGEST_TASK_END`,
        }),
      ),
      claimed,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const outbox = store.listOutbox('owner')
    const say = outbox.filter(
      message =>
        (message.payload as { type?: string }).type === 'agent.message',
    )
    expect(say).toHaveLength(1)
    const text = (say[0]?.payload as { text: string }).text
    expect(text).toBe('这需要正式任务处理。')
    expect(text).not.toContain('PEGAS_SUGGEST_TASK')
    const suggestion = store
      .listEvents('owner')
      .find(event => event.type === 'conversation.suggest_task')
    expect(suggestion?.payload).toMatchObject({ text: goal })
    store.close()
  })

  it('strips markers from streamed text conservatively', () => {
    expect(conversationProgressText('答案正文')).toBe('答案正文')
    expect(
      conversationProgressText('说明\nPEGAS_SUGGEST_TASK_BEGIN\n目标'),
    ).toBe('说明')
    expect(conversationProgressText('说明\nPEGAS_SUG')).toBe('说明')
    expect(
      conversationProgressText(
        'PEGAS_SUGGEST_TASK_BEGIN\n目标\nPEGAS_SUGGEST_TASK_END',
      ),
    ).toBe('')
  })

  it('still suppresses acknowledgement progress in the conversation lane', async () => {
    const inner: RunExecutor = {
      name: 'ack-test',
      execute: input => {
        input.onProgress?.({ type: 'acknowledgement', text: '收到，我来查' })
        input.onProgress?.({ type: 'message', text: '正文' })
        return Promise.resolve({ executorRef: 's', output: '正文' })
      },
    }
    const seen: string[] = []
    const result = await new ConversationExecutor(inner).execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: '今天星期几',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'message') seen.push(event.text)
        else throw new Error(`unexpected progress ${event.type}`)
      },
    })
    expect(result.output).toBe('正文')
    expect(seen).toEqual(['正文'])
  })

  it('closes the executor runtime when the Run settles and resumes the persisted session on the next message', async () => {
    const store = new PegasStore(':memory:')
    const first = await seedConversationClaim(store, '今天星期几')
    const pidFile = join(
      mkdtempSync(join(tmpdir(), 'pegas-chat-stream-pid-')),
      'pid',
    )
    temporaryDirectories.push(join(pidFile, '..'))
    const firstCommand = fakeDsh(`
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
console.log(JSON.stringify({ type: 'text', text: '今天是' }))
console.log(JSON.stringify({ type: 'text', text: '星期六。' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'chat-session-live',
  text: '今天是星期六。',
  reason: { kind: 'completed' }
}))
setTimeout(() => undefined, 60_000)
`)
    await executeClaimedRun(
      store,
      new ConversationExecutor(new DshCliExecutor({ command: firstCommand })),
      first,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(store.findTask(first.task.id, 'owner')?.status).toBe('completed')
    expect(store.conversationSessionRef('owner')).toBe('chat-session-live')
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(processAlive(childPid)).toBe(false)
    const say = store
      .listOutbox('owner')
      .find(
        message =>
          (message.payload as { type?: string }).type === 'agent.message',
      )
    expect(say?.payload).toMatchObject({ text: '今天是星期六。' })
    expect((say?.payload as { streaming?: boolean }).streaming).not.toBe(true)

    const second = await seedConversationClaim(store, '那明天呢')
    const secondCommand = fakeDsh(`
const args = process.argv.join(' ')
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'chat-session-live',
  text: args.includes('chat-session-live') ? 'resumed' : 'fresh',
  reason: { kind: 'completed' }
}))
`)
    await executeClaimedRun(
      store,
      new ConversationExecutor(new DshCliExecutor({ command: secondCommand })),
      second,
      'chat-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const answers = store
      .listOutbox('owner')
      .filter(
        message =>
          (message.payload as { type?: string }).type === 'agent.message',
      )
      .map(message => (message.payload as { text: string }).text)
    expect(answers).toEqual(['今天是星期六。', 'resumed'])
    store.close()
  }, 20_000)
})
