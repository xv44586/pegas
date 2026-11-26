import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commandAuthorization,
  commandFingerprint,
  isGitFetchCommand,
} from '../src/executor/command-policy.mjs'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture value')
  return value
}

const roots: string[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('GIT_CONFIG_')) vi.stubEnv(key, undefined)
})
afterEach(() => vi.unstubAllEnvs())
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pegas-command-')))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'a'), 'a')
  git('add', 'a')
  git('commit', '-qm', 'initial')
  git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
  return { root, repo, git }
}
describe('APPROVAL-001 command identity', () => {
  it('uses the same credential-free identity in the server and executor', () => {
    const f = fixture()
    const base = { PATH: process.env.PATH, HOME: process.env.HOME }
    const clean = required(
      commandAuthorization('git fetch origin main', f.repo, [], base).selector,
    )
    const ambient = required(
      commandAuthorization('git fetch origin main', f.repo, [], {
        ...base,
        SSH_AUTH_SOCK: '/tmp/personal-agent',
        GH_CONFIG_DIR: '/tmp/personal-gh',
        GIT_ASKPASS: '/tmp/personal-helper',
      }).selector,
    )
    expect(commandFingerprint(ambient, 'exact')).toBe(
      commandFingerprint(clean, 'exact'),
    )
  })

  it.each([
    "rg 'git fetch' docs",
    'git log --grep=fetch -1',
    "echo 'git fetch'",
  ])('does not infer execution from search text: %s', command => {
    expect(isGitFetchCommand(command)).toBe(false)
  })
  it.each([
    'git fetch origin main',
    'env -u GIT_CONFIG_COUNT git fetch origin main',
    'git -c core.sshCommand=override fetch origin',
  ])('recognizes actual fetch invocation: %s', command => {
    expect(isGitFetchCommand(command)).toBe(true)
  })
  it.each([
    ['fetch.prune', 'true'],
    ['fetch.pruneTags', 'true'],
    ['remote.origin.prune', 'yes'],
    ['remote.origin.pruneTags', '1'],
    ['remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
  ])('rejects destructive configured fetch behavior %s', (key, value) => {
    const f = fixture()
    f.git('config', key, value)
    expect(
      commandAuthorization('git fetch origin', f.repo).selector,
    ).toBeUndefined()
  })
  it.each([
    '[fetch]\n prune',
    '[fetch]\n pruneTags',
    '[remote "origin"]\n prune',
  ])('rejects valueless Git boolean %s', line => {
    const f = fixture()
    writeFileSync(join(f.repo, '.git', 'config'), '\n' + line + '\n', {
      flag: 'a',
    })
    expect(
      commandAuthorization('git fetch origin', f.repo).selector,
    ).toBeUndefined()
  })
  it('rejects bare gh helper because Git executes git-credential-gh instead', () => {
    const f = fixture()
    f.git('config', 'credential.helper', 'gh auth git-credential')
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeUndefined()
  })
  it.each(['credential.helper', 'credential.https://example.invalid.helper'])(
    'rejects arbitrary executable helper %s before any helper runs',
    key => {
      const f = fixture()
      f.git('config', key, '!touch ' + join(f.repo, 'should-not-run'))
      expect(
        commandAuthorization('git fetch origin main', f.repo).reason,
      ).toContain('helper')
      expect(
        commandAuthorization('git fetch origin main', f.repo).selector,
      ).toBeUndefined()
    },
  )
  it.each(['GIT_ASKPASS', 'SSH_ASKPASS'])(
    'removes ambient interactive executable override %s',
    key => {
      expect(
        commandAuthorization('git fetch origin main', fixture().repo, [], {
          ...process.env,
          [key]: '/tmp/custom-script',
        }).selector,
      ).toBeDefined()
    },
  )
  it('does not persist SSH transport with unbound execution configuration', () => {
    const f = fixture()
    f.git('remote', 'set-url', 'origin', 'git@example.invalid:repo.git')
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeUndefined()
  })
  it('recognizes fetch with actual cwd and the reported env wrapper', () => {
    const f = fixture()
    const result = commandAuthorization(
      'env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git fetch origin main',
      f.repo,
    )
    expect(result.selector, result.reason).toMatchObject({
      family: 'git-fetch',
      repository: f.repo,
      remote: 'origin',
      remoteUrl: 'https://example.invalid/repo.git',
    })
    expect(result.selector?.environmentHash).toBeTruthy()
  })
  it('shares family identity across branches and worktrees but not remotes', () => {
    const f = fixture()
    const worktree = join(f.root, 'wt')
    f.git('worktree', 'add', '-qb', 'other', worktree)
    const a = required(
      commandAuthorization('git fetch origin main', f.repo).selector,
    )
    const b = required(
      commandAuthorization('git fetch origin other', worktree).selector,
    )
    expect(commandFingerprint(a, 'family')).toBe(
      commandFingerprint(b, 'family'),
    )
    expect(commandFingerprint(a, 'exact')).not.toBe(
      commandFingerprint(b, 'exact'),
    )
    f.git('remote', 'set-url', 'origin', 'https://elsewhere.invalid/repo.git')
    expect(
      commandFingerprint(
        required(
          commandAuthorization('git fetch origin main', f.repo).selector,
        ),
        'family',
      ),
    ).not.toBe(commandFingerprint(a, 'family'))
  })
  it.each([
    'git fetch origin main && git push',
    'git fetch --upload-pack=evil origin',
    'git -c core.sshCommand=evil fetch origin',
    'git fetch --force origin main',
    'git fetch --prune origin',
    'env GIT_SSH_COMMAND=evil git fetch origin',
    'git fetch origin $(whoami)',
    'git fetch origin main:refs/heads/main',
  ])('rejects unsupported form %s', command => {
    expect(
      commandAuthorization(command, fixture().repo).selector,
    ).toBeUndefined()
  })
  it('rejects executable configuration and protected roots', () => {
    const f = fixture()
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeDefined()
    f.git('config', 'core.sshCommand', 'echo unsafe')
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeUndefined()
    expect(
      commandAuthorization('git fetch origin main', f.repo, [f.repo]).selector,
    ).toBeUndefined()
  })
  it('rechecks relative PATH and empty entries against the actual cwd', () => {
    const f = fixture()
    writeFileSync(join(f.repo, 'git'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(f.repo, 'git'), 0o755)
    for (const prefix of ['.', ''])
      expect(
        commandAuthorization('git fetch origin main', f.repo, [], {
          ...process.env,
          PATH: prefix + ':/usr/bin:/bin',
        }).selector,
      ).toBeUndefined()
  })
  it.each(['BASH_ENV', 'ENV', 'BASH_FUNC_git%%', 'SHELLOPTS', 'BASHOPTS'])(
    'removes ambient shell startup override %s',
    key => {
      expect(
        commandAuthorization('git fetch origin main', fixture().repo, [], {
          ...process.env,
          [key]: 'injected',
        }).selector,
      ).toBeDefined()
    },
  )
  it('rechecks hooks and submodule topology after a grant was created', () => {
    const f = fixture()
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeDefined()
    const hook = join(f.repo, '.git', 'hooks', 'reference-transaction')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    chmodSync(hook, 0o755)
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeUndefined()
    rmSync(hook)
    writeFileSync(
      join(f.repo, '.gitmodules'),
      '[submodule "other"]\npath = other\nurl = https://elsewhere.invalid/other.git\n',
    )
    expect(
      commandAuthorization('git fetch origin main', f.repo).selector,
    ).toBeUndefined()
  })
})
