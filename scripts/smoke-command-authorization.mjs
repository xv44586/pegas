import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { PegasStore } from '../dist/storage/sqlite-store.js'
import { createControlPlane } from '../dist/control-plane/server.js'
import { loadConfig } from '../dist/core/config.js'
import {
  runtimeSettingsDefaults,
  settingsCapabilities,
} from '../dist/settings/runtime-settings.js'
import { DshCliExecutor } from '../dist/executor/dsh-cli-executor.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../dist/executor/dsh-home.js'
import { ModelCredentialVault } from '../dist/model/model-credential-vault.js'
import { loadDshModelCatalog } from '../dist/executor/dsh-model-catalog.js'
import { executeClaimedRun } from '../dist/worker/processor.js'

const root = resolve(import.meta.dirname, '..')
const fixture = realpathSync(
  // Linux bwrap mounts a private /tmp; a sibling remote there is invisible.
  // Keep the real remote outside the workspace and visible read-only, without
  // adding writable directories or weakening the executor sandbox.
  mkdtempSync(
    join(
      process.platform === 'linux' ? homedir() : tmpdir(),
      '.pegas-command-desktop-',
    ),
  ),
)
const output = join(root, 'output', 'command-grants')
mkdirSync(output, { recursive: true })
const repo = join(fixture, 'repo'),
  remote = join(fixture, 'remote.git'),
  home = join(fixture, 'dsh')
for (const key of Object.keys(process.env))
  if (/^GIT_CONFIG_|proxy/i.test(key)) Reflect.deleteProperty(process.env, key)
const git = (cwd, ...args) =>
  execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
mkdirSync(repo)
git(repo, 'init', '-qb', 'main')
git(repo, 'config', 'user.name', 'Fixture')
git(repo, 'config', 'user.email', 'fixture@example.invalid')
writeFileSync(join(repo, 'marker'), '1')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'initial')
git(fixture, 'clone', '--bare', repo, remote)
git(repo, 'remote', 'add', 'origin', remote)
const command = 'env -u GIT_CONFIG_COUNT git fetch origin main'
let repeatWithinRun = false,
  commandDirectory = repo
let toolResults = 0,
  requests = 0,
  application,
  server,
  configuration,
  window,
  store
const gateway = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => (body += chunk))
  request.on('end', () => {
    try {
      const input = JSON.parse(body)
      requests++
      const latestUser = input.messages.findLastIndex(
        message => message.role === 'user',
      )
      const completedTools = input.messages
        .slice(latestUser + 1)
        .filter(message => message.role === 'tool').length
      const result = completedTools >= (repeatWithinRun ? 2 : 1)
      if (repeatWithinRun && completedTools === 1) advanceRemote()
      if (result) toolResults++
      const delta = result
        ? { content: 'FETCH_FIXTURE_DONE' }
        : {
            tool_calls: [
              {
                index: 0,
                id: `fetch-fixture-${requests}`,
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command,
                    workdir: commandDirectory,
                    description: 'Fetch the local fixture remote',
                  }),
                },
              },
            ],
          }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        {
          index: 0,
          delta: { role: 'assistant', ...delta },
          finish_reason: null,
        },
        { index: 0, delta: {}, finish_reason: result ? 'stop' : 'tool_calls' },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`,
        )
      response.end('data: [DONE]\n\n')
    } catch {
      response.writeHead(500).end('Fixture gateway error')
    }
  })
})
let baseUrl
async function openServer() {
  store = new PegasStore(join(fixture, 'pegas.db'))
  if (!store.hasRuntimeSettings())
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  server = createControlPlane({
    store,
    settingsCapabilities: settingsCapabilities(loadConfig({})),
    modelCredentialVault: new ModelCredentialVault(Buffer.alloc(32, 7)),
    agentModelCatalog: () =>
      loadDshModelCatalog({
        home,
        patchPath: configuration.patchPath,
        environment: configuration.environment,
      }),
    apiToken: 'fixture-token',
    webRoot: join(root, 'dist', 'web'),
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
}
async function desktop() {
  application = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      PEGAS_DESKTOP_SERVER_URL: baseUrl,
      PEGAS_API_TOKEN: 'fixture-token',
      PEGAS_DESKTOP_DATA_DIR: join(fixture, 'desktop'),
    },
    timeout: 30000,
  })
  window = await application.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const skip = window.getByRole('button', { name: '稍后设置' })
  await window
    .getByRole('textbox', { name: '给 Pegas 发消息' })
    .or(skip)
    .first()
    .waitFor()
  if (await skip.isVisible()) await skip.click()
}
function claim(taskId) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '命令授权桌面验收', ...(taskId ? { taskId } : {}) },
  }).event
  let e = store.claimNextEvent('fixture-router')
  while (e && e.id !== event.id) {
    if (e.type === 'approval.decided') store.applyApprovalDecision(e)
    store.completeEvent(e.id, 'fixture-router')
    e = store.claimNextEvent('fixture-router')
  }
  assert(e)
  store.applyRoutingDecision(
    e,
    taskId
      ? {
          kind: 'continue_task',
          taskId,
          input: '命令授权桌面验收',
          reason: 'fixture',
        }
      : {
          kind: 'create_task',
          title: '命令授权桌面验收',
          goal: '验证真实 fetch',
          input: '执行指定 fetch',
          reason: 'fixture',
        },
    'dsh-headless',
    task =>
      store.resolveWorkerExecutionContext(task.id, 'owner', {
        executor: 'dsh-headless',
        protocol: 'dsh-headless-v1',
        executorProfile: 'headless',
        workspace: repo,
        permissions: JSON.stringify({
          mode: 'workspace-write',
          approvalPolicy: 'ask',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      }),
  )
  store.completeEvent(e.id, 'fixture-router')
  const run = store.claimNextRun('fixture-worker', 300000)
  assert(run)
  return run
}
async function execute(claimed) {
  const events = []
  const executor = new DshCliExecutor({
    home,
    modelConfiguration: configuration,
    permissionMode: 'workspace-write',
    approvalPolicy: 'ask',
    timeoutMs: 45000,
  })
  let result
  await executeClaimedRun(
    store,
    {
      execute: async input => {
        try {
          result = await executor.execute({
            ...input,
            onProgress: event => {
              events.push(event)
              input.onProgress?.(event)
            },
          })
        } catch (error) {
          console.error('REAL_EXECUTOR_ERROR', error.message)
          throw error
        }
        return result
      },
    },
    claimed,
    'fixture-worker',
    repo,
    new AbortController().signal,
    baseUrl,
  )
  assert(result, JSON.stringify(store.listRuns(claimed.task.id)))
  writeFileSync(
    join(output, 'last-executor.json'),
    JSON.stringify({ result, events }, null, 2),
  )
  for (const event of events) {
    if (event.type === 'tool_result')
      assert(
        !/\[exit code: [1-9]\d*\]/.test(event.result ?? ''),
        `The real Git command failed: ${event.result}`,
      )
  }
  return { result, events }
}
async function openApproval(approvalId) {
  const message = store
    .listOutbox('owner')
    .find(
      item =>
        item.payload.type === 'approval.required' &&
        item.payload.approvalId === approvalId,
    )
  assert(message)
  await window.goto(`${baseUrl}/?view=outbox&outbox=${message.id}`)
  await window.getByRole('radiogroup', { name: '你的决定' }).waitFor()
  assert((await window.locator('body').innerText()).includes('git fetch'))
  return store.getApproval(approvalId, 'owner')
}
function fetched() {
  return (
    git(commandDirectory, 'rev-parse', 'FETCH_HEAD') ===
    git(remote, 'rev-parse', 'main')
  )
}
let remoteRevision = 0
function advanceRemote() {
  remoteRevision++
  const tree = git(remote, 'rev-parse', 'main^{tree}')
  const commit = git(
    remote,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    tree,
    '-p',
    'main',
    '-m',
    'stage ' + remoteRevision,
  )
  git(remote, 'update-ref', 'refs/heads/main', commit)
  return commit
}
try {
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  ensureDshProfileHome(home, 'headless')
  configuration = createDshModelConfiguration({
    vault: new ModelCredentialVault(Buffer.alloc(32, 7)),
    connections: [
      {
        id: 'magpie',
        name: 'Fixture',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
        updatedAt: new Date().toISOString(),
      },
    ],
    agentModel: { provider: 'magpie', model: 'fixture' },
  })
  await openServer()
  let taskProbe = claim()
  const taskPending = await execute(taskProbe)
  assert(taskPending.result.approvalPending)
  await desktop()
  await openApproval(taskPending.result.approvalPending.approvalId)
  await window
    .getByRole('radio', { name: '本事情内允许 git fetch', exact: true })
    .click()
  await window.getByRole('button', { name: '提交决定', exact: true }).click()
  await window.getByRole('region', { name: '审批结果' }).waitFor()
  const taskRule = store
    .listUserApprovalRules('owner')
    .find(rule => rule.status === 'active')
  assert(taskRule)
  taskProbe = store.claimNextRun('fixture-worker', 300000)
  assert(taskProbe)
  repeatWithinRun = true
  const taskExecuted = await execute(taskProbe)
  repeatWithinRun = false
  assert(taskExecuted.events.some(e => e.ruleId === taskRule.id))
  assert.equal(
    taskExecuted.events.filter(
      e => e.type === 'tool_result' && e.status === 'completed',
    ).length,
    2,
  )
  assert(
    fetched(),
    'Task rule must execute the second real fetch after the first one-time grant',
  )
  assert.equal(
    store.listUserApprovalRules('owner').find(rule => rule.id === taskRule.id)
      ?.status,
    'revoked',
    'Ended task rules cannot revive',
  )
  let current = claim()
  const first = await execute(current)
  assert(first.result.approvalPending, 'First fetch must require approval')
  const approval = await openApproval(first.result.approvalPending.approvalId)
  await window
    .getByRole('radio', { name: '始终允许 git fetch', exact: true })
    .click()
  await window.waitForTimeout(200)
  await window.screenshot({ path: join(output, 'desktop-command-scope.png') })
  await window.getByRole('button', { name: '提交决定', exact: true }).click()
  await window
    .getByRole('region', { name: '审批结果' })
    .waitFor({ timeout: 10000 })
  assert.equal(
    await window.getByRole('radiogroup', { name: '你的决定' }).count(),
    0,
  )
  const rule = store
    .listUserApprovalRules('owner')
    .find(rule => rule.status === 'active')
  assert(rule)
  assert.equal(rule.lifetime, 'user')
  current = store.claimNextRun('fixture-worker', 300000)
  assert(current)
  assert.equal(
    store.approvalRuleIdForAction(approval.actionId, 'owner'),
    rule.id,
  )
  const initial = await execute(current)
  assert(!initial.result.approvalPending)
  assert(fetched(), 'Approved fetch must actually update FETCH_HEAD')
  advanceRemote()
  current = claim(current.task.id)
  const reuse = await execute(current)
  assert(!reuse.result.approvalPending)
  assert(reuse.events.some(e => e.ruleId === rule.id && e.decision === 'allow'))
  assert(fetched(), 'Reuse must fetch the newly advanced remote commit')
  await application.close()
  application = undefined
  await new Promise(resolve => server.close(resolve))
  store.close()
  await openServer()
  await desktop()
  advanceRemote()
  current = claim()
  const restarted = await execute(current)
  assert(!restarted.result.approvalPending)
  assert(restarted.events.some(e => e.ruleId === rule.id))
  assert(
    fetched(),
    'Restarted new task must fetch the newly advanced remote commit',
  )
  const worktree = join(fixture, 'worktree')
  git(repo, 'worktree', 'add', '-qb', 'verification', worktree)
  commandDirectory = worktree
  advanceRemote()
  current = claim()
  const worktreeResult = await execute(current)
  assert(!worktreeResult.result.approvalPending)
  assert(worktreeResult.events.some(e => e.ruleId === rule.id))
  assert(fetched(), 'Worktree fetch must update its FETCH_HEAD')
  commandDirectory = repo
  await window.goto(baseUrl + '/?task=' + current.task.id)
  await window.getByRole('tab', { name: '执行记录', exact: true }).click()
  await window.getByText('授权执行记录', { exact: true }).first().click()
  await window
    .getByText(/已按长期命令授权执行/)
    .first()
    .waitFor()
  await window
    .getByRole('button', { name: '查看此授权', exact: true })
    .first()
    .click()
  await window.getByRole('heading', { name: '授权管理', exact: true }).waitFor()
  const tracePanel = window
    .getByText('授权执行记录', { exact: true })
    .first()
    .locator('..')
  await tracePanel
    .locator('.approval-rule-item')
    .filter({ hasText: repo })
    .waitFor()
  assert(
    await tracePanel.evaluate(
      element => element.scrollWidth <= element.clientWidth,
    ),
    'Authorization trace must wrap long paths',
  )
  const revokeBounds = await tracePanel
    .getByRole('button', { name: '撤销规则', exact: true })
    .boundingBox()
  assert(
    revokeBounds && revokeBounds.width > revokeBounds.height,
    'Revoke action must remain a readable single-line button',
  )
  const traceBounds = await tracePanel.boundingBox()
  assert(
    traceBounds &&
      traceBounds.x + traceBounds.width <=
        (await window.evaluate(() => globalThis.innerWidth)),
    'Authorization trace must fit the task inspector',
  )
  await window.screenshot({ path: join(output, 'desktop-command-trace.png') })
  await window.goto(baseUrl)
  await window.getByRole('button', { name: '设置', exact: true }).click()
  await window.getByRole('button', { name: /隐私/ }).click()
  await window.getByRole('heading', { name: '授权管理', exact: true }).waitFor()
  await window.getByRole('button', { name: '撤销规则', exact: true }).click()
  await window
    .getByText(/已撤销/)
    .first()
    .waitFor()
  await window.screenshot({ path: join(output, 'desktop-command-revoked.png') })
  assert.equal(
    store.listUserApprovalRules('owner').find(item => item.id === rule.id)
      ?.status,
    'revoked',
  )
  const beforeRevocation = git(repo, 'rev-parse', 'FETCH_HEAD')
  advanceRemote()
  current = claim(current.task.id)
  const revoked = await execute(current)
  assert(revoked.result.approvalPending, 'Revoked fetch must ask again')
  assert.equal(
    git(repo, 'rev-parse', 'FETCH_HEAD'),
    beforeRevocation,
    'Revoked call must not execute',
  )
  await window.reload()
  await openApproval(revoked.result.approvalPending.approvalId)
  await window.getByText(/对应命令授权已撤销/).waitFor()
  await window.screenshot({ path: join(output, 'desktop-command-reasked.png') })
  await application.evaluate(({ BrowserWindow }) => {
    const active = BrowserWindow.getAllWindows()[0]
    active.setMinimumSize(320, 480)
    active.setSize(420, 800)
  })
  await window.waitForFunction(() => globalThis.innerWidth <= 420)
  assert(
    await window
      .getByRole('button', { name: '提交决定', exact: true })
      .isVisible(),
  )
  assert(
    await window.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    'Narrow approval must not overflow horizontally',
  )
  await window.screenshot({ path: join(output, 'desktop-command-narrow.png') })
  writeFileSync(
    join(output, 'desktop-command-result.json'),
    JSON.stringify(
      {
        desktop: 'actual Electron main',
        executor: 'real DSH bash',
        firstApproval: true,
        taskRuleReuseAndEndExpiry: true,
        actualFetch: true,
        sameTaskReuse: true,
        databaseAndDesktopRestart: true,
        newTaskReuse: true,
        worktreeReuse: true,
        desktopRevocation: true,
        reasked: true,
        requests,
        toolResults,
      },
      null,
      2,
    ),
  )
  console.log('COMMAND_DESKTOP_GATE_PASSED')
} catch (error) {
  if (window) {
    await window
      .screenshot({ path: join(output, 'desktop-command-failure.png') })
      .catch(() => undefined)
    console.error(
      await window
        .locator('body')
        .innerText()
        .catch(() => ''),
    )
  }
  throw error
} finally {
  await application?.close()
  await new Promise(resolve => (server ? server.close(resolve) : resolve()))
  store?.close()
  configuration?.remove()
  await new Promise(resolve => gateway.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
