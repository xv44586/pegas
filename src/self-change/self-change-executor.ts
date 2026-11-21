import { execFile } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
import {
  buildSelfChangeCandidate,
  type SelfChangeCandidateRequest,
} from './candidate-builder.js'
import { MigrationApprovalRequiredError } from '../supervisor/recovery-server.js'

const execFileAsync = promisify(execFile)

export interface SelfChangeExecutorOptions {
  /** Checkout of the Pegas repository the executor may branch from. */
  repositoryRoot: string
  /** Root directory for isolated worktrees and candidate releases. */
  selfChangeRoot: string
  /** Recovery API base URL of the independent Supervisor. */
  recoveryBaseUrl: string
  recoveryToken?: string
  /** Inner executor that edits code inside the isolated worktree. */
  editor: RunExecutor
  compatibility: { minimumSchema: number; maximumSchema: number }
  reviewer: string
  /** Control Plane URL used to observe the switched release. */
  controlPlaneBaseUrl?: string
  releaseWaitTimeoutMs?: number
  buildCandidate?: (
    request: SelfChangeCandidateRequest,
  ) => Promise<Awaited<ReturnType<typeof buildSelfChangeCandidate>>>
  stageCandidate?: (input: {
    recoveryBaseUrl: string
    recoveryToken?: string
    manifestPath: string
    artifactPath: string
    reviewReportPath: string
    migrationApproval?: { actionId: string; approvalId: string }
  }) => Promise<void>
  /** Test hook: skip waiting for the switched release to become ready. */
  awaitRelease?: (releaseId: string) => Promise<void>
  /** Test hook: dependency install for a fresh isolated worktree. */
  installDependencies?: (worktree: string) => Promise<void>
}

interface ApprovalDecisionContext {
  type: 'approval.decision'
  actionId: string
  decision: string
  action: {
    kind: string
    request: Record<string, unknown>
    approvalId?: string
  }
}

/**
 * Executes a self-change Task without ever mutating the active release.
 * Phase 1 creates an isolated worktree, lets the inner editor commit a change
 * there, builds an immutable candidate and requests a high-risk Approval.
 * Phase 2 (the approval successor Run) stages the candidate through the
 * independent Supervisor, waits for the switched release and records the
 * Action outcome so the Task can complete and report back to the user.
 */
export class SelfChangeExecutor implements RunExecutor {
  readonly name = 'self-change'
  readonly #options: SelfChangeExecutorOptions

  constructor(options: SelfChangeExecutorOptions) {
    this.#options = options
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const decision = approvalDecision(input.prompt)
    if (decision) return await this.#publish(input, decision)
    return await this.#prepare(input)
  }

  async #prepare(input: ExecutorInput): Promise<ExecutorResult> {
    const capability = this.#capability(input)
    const worktree = join(
      resolve(this.#options.selfChangeRoot),
      'worktrees',
      input.taskId,
    )
    const branch = `self-change/${input.taskId}`
    if (!existsSync(worktree)) {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branch, worktree, 'HEAD'],
        { cwd: this.#options.repositoryRoot },
      )
    }
    const base = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: this.#options.repositoryRoot,
      })
    ).stdout.trim()
    input.onProgress?.({
      type: 'acknowledgement',
      text: '我会在隔离 worktree 中修改并验证候选版本，发布前请求你的批准。',
    })
    const edited = await this.#options.editor.execute({
      ...input,
      workingDirectory: worktree,
    })
    const dirty = (
      await execFileAsync('git', ['status', '--porcelain'], { cwd: worktree })
    ).stdout.trim()
    if (dirty) {
      throw new Error(
        'Self-change editor left uncommitted changes; the candidate requires an exact commit',
      )
    }
    const head = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    ).stdout.trim()
    if (head === base) {
      // No code change was necessary; answer directly without a release.
      return { executorRef: edited.executorRef, output: edited.output }
    }
    if (!existsSync(join(worktree, 'node_modules'))) {
      // A fresh worktree needs its own dependency install before the gate.
      await (this.#options.installDependencies ?? installWorktreeDependencies)(
        worktree,
      )
    }
    if (!lstatSync(join(worktree, 'node_modules')).isDirectory()) {
      throw new Error(
        'Self-change worktree node_modules must be a real installed directory',
      )
    }
    const releaseId = `self-${input.taskId.slice(0, 8)}-${head.slice(0, 12)}`
    const built = await (
      this.#options.buildCandidate ?? buildSelfChangeCandidate
    )({
      worktree,
      baseCommit: base,
      outputRoot: join(resolve(this.#options.selfChangeRoot), 'candidates'),
      releaseId,
      featureIds: ['SELF-001'],
      compatibility: this.#options.compatibility,
      reviewer: this.#options.reviewer,
    })
    const requested = await fetch(
      `${capability.baseUrl}/v1/runs/${input.runId}/approvals`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': capability.claimToken,
        },
        body: JSON.stringify({
          action: {
            kind: 'self_change.publish',
            risk: 'high',
            idempotencyKey: `self-change:${input.taskId}:${head}`,
            request: {
              releaseId,
              commit: head,
              manifestPath: built.manifestPath,
              artifactPath: built.artifactPath,
              reviewReportPath: built.reviewReportPath,
            },
            recoveryPoint: {
              step: 'before_candidate_switch',
              previousReleaseRetained: true,
            },
            approval: {
              summary: `发布 Pegas 候选版本 ${releaseId}`,
              impact:
                '切换正在运行的 Pegas 服务；失败时 Supervisor 自动回滚上一版本。',
              recommendedOptionId: 'approve',
              options: [
                { id: 'approve', label: '批准发布', kind: 'approve' },
                { id: 'reject', label: '不发布', kind: 'reject' },
              ],
            },
          },
        }),
      },
    )
    if (!requested.ok) {
      throw new Error(
        `Self-change approval request failed with ${String(requested.status)}`,
      )
    }
    return {
      executorRef: edited.executorRef,
      output: `候选版本 ${releaseId} 已在隔离环境构建并通过门禁，等待发布批准。`,
    }
  }

  async #publish(
    input: ExecutorInput,
    decision: ApprovalDecisionContext,
  ): Promise<ExecutorResult> {
    const capability = this.#capability(input)
    const executorRef = input.resumeSessionId ?? `self-change-${input.runId}`
    if (
      decision.action.kind !== 'self_change.publish' &&
      decision.action.kind !== 'self_change.migration'
    ) {
      throw new Error('Self-change executor received an unrelated Action')
    }
    if (decision.decision !== 'approve') {
      await this.#recordOutcome(capability, input, decision.actionId, {
        commandId: `self-change-outcome:${decision.actionId}`,
        status: 'failed',
        result: { reason: 'user_rejected_release' },
      })
      return { executorRef, output: '用户未批准发布，候选版本保留但未切换。' }
    }
    const request = decision.action.request
    const releaseId = requiredString(request.releaseId, 'releaseId')
    const migrationGrant =
      decision.action.kind === 'self_change.migration'
        ? {
            actionId: decision.actionId,
            approvalId: requiredString(
              decision.action.approvalId,
              'approvalId',
            ),
          }
        : undefined
    try {
      const stageInput = {
        recoveryBaseUrl: this.#options.recoveryBaseUrl,
        ...(this.#options.recoveryToken
          ? { recoveryToken: this.#options.recoveryToken }
          : {}),
        manifestPath: requiredString(request.manifestPath, 'manifestPath'),
        artifactPath: requiredString(request.artifactPath, 'artifactPath'),
        reviewReportPath: requiredString(
          request.reviewReportPath,
          'reviewReportPath',
        ),
        ...(migrationGrant ? { migrationApproval: migrationGrant } : {}),
      }
      try {
        await (this.#options.stageCandidate ?? stageViaRecoveryApi)(stageInput)
      } catch (error) {
        if (
          !(error instanceof MigrationApprovalRequiredError) ||
          migrationGrant
        )
          throw error
        // The publish approval never covers destructive migrations. Record
        // the publish outcome, then park the Run behind a dedicated
        // migration Approval bound to this exact release and migration set.
        await this.#recordOutcome(capability, input, decision.actionId, {
          commandId: `self-change-outcome:${decision.actionId}`,
          status: 'succeeded',
          result: {
            releaseId,
            summary:
              'Candidate verified; destructive migration approval required',
            stagingDeferred: 'migration_approval_required',
          },
        })
        await this.#requestMigrationApproval(
          capability,
          input,
          releaseId,
          request,
          error.versions,
        )
        return {
          executorRef,
          output: `候选版本 ${releaseId} 包含破坏性数据迁移（schema ${error.versions.join('、')}），需要你单独批准后才会切换。`,
        }
      }
      if (this.#options.awaitRelease) {
        await this.#options.awaitRelease(releaseId)
      } else if (this.#options.controlPlaneBaseUrl) {
        await waitForRelease(
          this.#options.controlPlaneBaseUrl,
          releaseId,
          this.#options.releaseWaitTimeoutMs ?? 120_000,
        )
      }
      await this.#recordOutcome(capability, input, decision.actionId, {
        commandId: `self-change-outcome:${decision.actionId}`,
        status: 'succeeded',
        result: { releaseId, summary: 'Candidate staged and verified' },
      })
      return {
        executorRef,
        output: `候选版本 ${releaseId} 已提交 Supervisor 验证并接管服务；失败会自动回滚。`,
      }
    } catch (error) {
      if (decision.action.kind === 'self_change.migration') {
        // The migration itself was rejected or failed before any switch;
        // record a definite failure so the Task is not left blocked.
        await this.#recordOutcome(capability, input, decision.actionId, {
          commandId: `self-change-outcome:${decision.actionId}`,
          status: 'failed',
          result: {
            reason: 'migration_staging_failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
      await this.#recordOutcome(capability, input, decision.actionId, {
        commandId: `self-change-outcome:${decision.actionId}`,
        status: 'unknown',
        result: {
          reason: 'staging_failed_after_request',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  async #recordOutcome(
    capability: { baseUrl: string; claimToken: string },
    input: ExecutorInput,
    actionId: string,
    body: {
      commandId: string
      status: 'succeeded' | 'failed' | 'unknown'
      result: Record<string, unknown>
    },
  ): Promise<void> {
    const response = await fetch(
      `${capability.baseUrl}/v1/actions/${actionId}/outcomes`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': capability.claimToken,
        },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      throw new Error(
        `Self-change outcome write failed with ${String(response.status)}`,
      )
    }
  }

  async #requestMigrationApproval(
    capability: { baseUrl: string; claimToken: string },
    input: ExecutorInput,
    releaseId: string,
    publishRequest: Record<string, unknown>,
    versions: number[],
  ): Promise<void> {
    const requested = await fetch(
      `${capability.baseUrl}/v1/runs/${input.runId}/approvals`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': capability.claimToken,
        },
        body: JSON.stringify({
          action: {
            kind: 'self_change.migration',
            risk: 'critical',
            idempotencyKey: `self-change-migration:${input.taskId}:${releaseId}`,
            request: {
              releaseId,
              destructiveMigrations: versions,
              manifestPath: publishRequest.manifestPath,
              artifactPath: publishRequest.artifactPath,
              reviewReportPath: publishRequest.reviewReportPath,
            },
            recoveryPoint: {
              step: 'before_destructive_migration',
              previousReleaseRetained: true,
              backupVerifiedBeforeSwitch: true,
            },
            approval: {
              summary: `批准破坏性数据迁移（schema ${versions.join('、')}）`,
              impact:
                '候选版本会重建持久数据表结构。Supervisor 切换前会先完成已验证备份并在副本上演练迁移；失败自动回滚上一版本。',
              recommendedOptionId: 'approve',
              options: [
                { id: 'approve', label: '批准迁移并切换', kind: 'approve' },
                { id: 'reject', label: '不迁移', kind: 'reject' },
              ],
            },
          },
        }),
      },
    )
    if (!requested.ok) {
      throw new Error(
        `Self-change migration approval request failed with ${String(requested.status)}`,
      )
    }
  }

  #capability(input: ExecutorInput): { baseUrl: string; claimToken: string } {
    if (!input.actionCapability) {
      throw new Error('Self-change execution requires its Run claim capability')
    }
    return input.actionCapability
  }
}

async function stageViaRecoveryApi(input: {
  recoveryBaseUrl: string
  recoveryToken?: string
  manifestPath: string
  artifactPath: string
  reviewReportPath: string
  migrationApproval?: { actionId: string; approvalId: string }
}): Promise<void> {
  const response = await fetch(
    `${input.recoveryBaseUrl}/v1/recovery/candidates`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.recoveryToken
          ? { authorization: `Bearer ${input.recoveryToken}` }
          : {}),
      },
      body: JSON.stringify({
        manifestPath: input.manifestPath,
        artifactPath: input.artifactPath,
        reviewReportPath: input.reviewReportPath,
        ...(input.migrationApproval
          ? { migrationApproval: input.migrationApproval }
          : {}),
      }),
    },
  )
  if (response.status !== 202) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string
      error?: string
      versions?: number[]
    }
    if (
      response.status === 409 &&
      body.error === 'migration_approval_required' &&
      Array.isArray(body.versions)
    ) {
      throw new MigrationApprovalRequiredError(
        body.versions.filter(
          (version): version is number => typeof version === 'number',
        ),
      )
    }
    throw new Error(
      `Supervisor rejected the candidate (${String(response.status)}): ${body.message ?? 'unknown'}`,
    )
  }
}

async function waitForRelease(
  controlPlaneBaseUrl: string,
  releaseId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${controlPlaneBaseUrl}/readyz`, {
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = (await response.json()) as { releaseId?: string }
        if (body.releaseId === releaseId) return
      }
    } catch {
      // The candidate is still starting or the old release is stopping.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error(`Release ${releaseId} did not become ready before timeout`)
}

async function installWorktreeDependencies(worktree: string): Promise<void> {
  await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: worktree,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function approvalDecision(prompt: string): ApprovalDecisionContext | undefined {
  const trimmed = prompt.trimStart()
  if (!trimmed.startsWith('{"type":"approval.decision"')) return undefined
  const parsed = JSON.parse(
    trimmed.split('\n\n<pegas_execution_contract>')[0] ?? trimmed,
  ) as Partial<ApprovalDecisionContext>
  if (
    parsed.type !== 'approval.decision' ||
    typeof parsed.actionId !== 'string' ||
    typeof parsed.decision !== 'string' ||
    !parsed.action ||
    typeof parsed.action.kind !== 'string'
  )
    return undefined
  return parsed as ApprovalDecisionContext
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Self-change Action request requires ${name}`)
  return value
}
