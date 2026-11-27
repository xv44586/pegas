import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
  'continue-on-error'?: boolean
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<
    string,
    {
      'runs-on': string[]
      'timeout-minutes': number
      strategy: { 'fail-fast': boolean; matrix: { suite: string[] } }
      defaults: { run: { shell: string } }
      steps: Step[]
    }
  >
}
const source = readFileSync(
  new URL('../.github/workflows/nightly.yml', import.meta.url),
  'utf8',
)
const workflow = parse(source) as Workflow
const job = workflow.jobs.nightly
if (!job) throw new Error('Missing nightly job')
const step = (id: string) => {
  const found = job.steps.find(value => value.id === id)
  if (!found) throw new Error(`Missing nightly step ${id}`)
  return found
}

describe('QUALITY-001 nightly execution and hot-update boundary', () => {
  it('schedules 03:17 Shanghai and supports manual runs without adding PR gates', () => {
    expect(workflow.on).toEqual({
      schedule: [{ cron: '17 19 * * *' }],
      workflow_dispatch: null,
    })
    expect(workflow.concurrency.group).toBe('nightly-${{ github.ref }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    const ci = parse(
      readFileSync(
        new URL('../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
    ) as Workflow
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push'])
  })

  it('uses self-hosted runners, one exact SHA and read-only credentials without deployment', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job['runs-on']).toEqual(['self-hosted', 'Linux', 'X64', 'pegas-ci'])
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30)
    const checkout = job.steps.find(value =>
      value.uses?.startsWith('actions/checkout@'),
    )
    expect(checkout?.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    })
    expect(source).not.toMatch(
      /secrets\.|release:hot|release-hot\.mjs|gh pr merge|test:live|smoke:memory/,
    )
    expect(job.steps.every(value => !value['continue-on-error'])).toBe(true)
  })

  it('runs all lanes and keeps later recovery checks after an earlier failure', () => {
    expect(job.strategy.matrix.suite).toEqual([
      'baseline',
      'recovery',
      'browser',
      'stability',
    ])
    expect(job.strategy['fail-fast']).toBe(false)
    expect(step('check').run).toContain('pnpm check')
    expect(step('smoke').run).toContain('pnpm smoke')
    for (const id of ['crash', 'self_change', 'healthcheck', 'browser']) {
      expect(step(id).if).toContain('!cancelled()')
      expect(step(id).if).toContain("steps.build.outcome == 'success'")
      expect(step(id).env).toMatchObject({
        PEGAS_MEMORY_PROVIDER: 'disabled',
        PEGAS_REWRITE_MODE: 'disabled',
        PEGAS_MODEL_RECONCILE: 'disabled',
        PEGAS_LIVE_TESTS: '0',
      })
    }
    expect(step('browser').run).toContain('--force')
    expect(job.defaults.run.shell).toBe('bash') // Actions bash enables pipefail for tee.
  })

  it('preserves each failed round and uploads evidence even when checks fail', () => {
    expect(step('stability').run).toContain('for round in {1..10}')
    expect(step('stability').run).toContain('failed=1')
    expect(step('stability').run).toContain('exit "$failed"')
    expect(step('stability').run).toContain('stability-$round.json')
    const archive = job.steps.find(
      value => value.run === 'node scripts/archive-ci-evidence.ts',
    )
    expect(archive?.if).toBe('always()')
    expect(archive?.env?.PEGAS_CI_SUITE).toBe('${{ matrix.suite }}')
    expect(source).not.toContain('actions/upload-artifact')
    expect(source).not.toContain('cache: pnpm')
    const summary = job.steps.find(value => value.name === 'Write job summary')
    expect(summary?.if).toBe('always()')
    expect(summary?.run).toContain('step.outcome')
  })
})

describe('nightly stability failure aggregation', () => {
  it.each([0, 3])(
    'retains all ten rounds when round %i fails (zero means none)',
    failure => {
      const directory = mkdtempSync(join(tmpdir(), 'pegas-nightly-loop-'))
      try {
        mkdirSync(join(directory, 'output/nightly'), { recursive: true })
        const executable = join(directory, 'pnpm')
        writeFileSync(
          executable,
          `#!/bin/bash
round=0
if [ -f round ]; then read -r round < round; fi
round=$((round + 1))
echo "$round" > round
echo "fixture round $round"
if [ "$round" = "$FAIL_ROUND" ]; then exit 1; fi
`,
          { mode: 0o755 },
        )
        const result = spawnSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-eo',
            'pipefail',
            '-c',
            step('stability').run ?? '',
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH ?? ''}`,
              FAIL_ROUND: String(failure),
            },
            encoding: 'utf8',
            timeout: 10_000,
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(failure === 0 ? 0 : 1)
        expect(readFileSync(join(directory, 'round'), 'utf8').trim()).toBe('10')
        expect(readdirSync(join(directory, 'output/nightly'))).toHaveLength(10)
        if (failure)
          expect(
            readFileSync(
              join(
                directory,
                `output/nightly/stability-${String(failure)}.log`,
              ),
              'utf8',
            ),
          ).toContain('fixture round 3')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})

describe('nightly evidence on failure', () => {
  it('writes readable Markdown and exact failed/skipped outcomes after a failed step', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-nightly-report-'))
    try {
      const summaryPath = join(directory, 'job-summary.md')
      const summary = job.steps.find(
        value => value.name === 'Write job summary',
      )
      if (!summary?.run) throw new Error('Missing summary command')
      const outcomes = {
        install: { outcome: 'failure', conclusion: 'failure' },
        check: { outcome: 'skipped', conclusion: 'skipped' },
      }
      const result = spawnSync(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', summary.run],
        {
          cwd: directory,
          env: {
            ...process.env,
            NIGHTLY_STEPS: JSON.stringify(outcomes),
            NIGHTLY_SUITE: 'baseline',
            GITHUB_SHA: 'exact-tested-sha',
            GITHUB_SERVER_URL: 'https://github.com',
            GITHUB_REPOSITORY: 'example/fixture',
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_STEP_SUMMARY: summaryPath,
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(
        readFileSync(join(directory, 'output/nightly/result.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(report).toMatchObject({
        sha: 'exact-tested-sha',
        attempt: '2',
        steps: outcomes,
      })
      const markdown = readFileSync(summaryPath, 'utf8')
      expect(markdown.split('\n')).toContain('| install | failure |')
      expect(markdown.split('\n')).toContain('| check | skipped |')
      expect(markdown).not.toContain('\\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
