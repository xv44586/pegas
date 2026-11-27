import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  credentialProcessArgv,
  hostCredentialRoots,
  isCredentialPath,
} from '../src/executor/credential-boundary.mjs'
import { apply } from '../src/executor/dsh-credential-boundary.mjs'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pegas-credential-boundary-'))
  directories.push(root)
  const home = join(root, 'home'),
    workspace = join(root, 'work')
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  mkdirSync(workspace)
  const secret = join(home, '.config', 'gh', 'hosts.yml')
  writeFileSync(secret, 'SYNTHETIC_ACCOUNT_SECRET')
  symlinkSync(join(home, '.config'), join(workspace, 'alias'))
  return {
    root,
    home,
    workspace,
    secret,
    roots: hostCredentialRoots({ HOME: home }),
  }
}
function run(argv: string[]) {
  const [command, ...args] = argv
  if (!command) throw new Error('No command')
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
}

describe('host credential runtime boundary', () => {
  it('blocks indirect scripts and symlink reads while allowing workspace writes', () => {
    const f = fixture()
    // Demonstrate the original ambient capability without reading a real account.
    expect(
      execFileSync('/bin/cat', [f.secret], { encoding: 'utf8' }),
    ).toContain('SYNTHETIC_ACCOUNT_SECRET')
    for (const path of [
      f.secret,
      join(f.workspace, 'alias', 'gh', 'hosts.yml'),
    ]) {
      const argv = [
        process.execPath,
        '-e',
        'process.stdout.write(require("fs").readFileSync(process.argv[1]))',
        path,
      ]
      const result = run(credentialProcessArgv(argv, f.roots))
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stdout).not.toContain('SYNTHETIC_ACCOUNT_SECRET')
    }
    const target = join(f.workspace, 'ok')
    const result = run(
      credentialProcessArgv(
        [
          process.execPath,
          '-e',
          'require("fs").writeFileSync(process.argv[1], "ok")',
          target,
        ],
        f.roots,
      ),
    )
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('ok')
  })

  it('preserves the original file-write sandbox when adding credential isolation', () => {
    const f = fixture()
    const inner =
      process.platform === 'darwin'
        ? [
            '/usr/bin/sandbox-exec',
            '-p',
            '(version 1)(allow default)(deny file-write*)',
            '/bin/sh',
            '-c',
            'printf SANDBOX_BODY_STARTED; /usr/bin/touch "$1"',
            'fixture',
            join(f.workspace, 'denied'),
          ]
        : [
            'bwrap',
            '--ro-bind',
            '/',
            '/',
            '--',
            '/bin/sh',
            '-c',
            'printf SANDBOX_BODY_STARTED; /usr/bin/touch "$1"',
            'fixture',
            join(f.workspace, 'denied'),
          ]
    const result = run(credentialProcessArgv(inner, f.roots))
    expect(result.stdout).toContain('SANDBOX_BODY_STARTED')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/permitted|read-only|denied/i)
  })

  it('merges Linux credential masks after the original read-only mounts without nesting namespaces', () => {
    const f = fixture()
    const args = credentialProcessArgv(
      ['bwrap', '--ro-bind', '/', '/', '--', '/bin/true'],
      f.roots,
      'linux',
    )
    expect(
      args.filter(arg => arg === 'bwrap' || arg === '/usr/bin/bwrap'),
    ).toEqual(['/usr/bin/bwrap'])
    expect(args.slice(1, 4)).toEqual(['--ro-bind', '/', '/'])
    expect(args.indexOf('--tmpfs')).toBeGreaterThan(args.indexOf('--ro-bind'))
    expect(args.slice(-2)).toEqual(['--', '/bin/true'])
    expect(() =>
      credentialProcessArgv(['bwrap', '/bin/true'], f.roots, 'linux'),
    ).toThrow('cannot be enforced')
  })

  it('requires a fixed system runner instead of resolving a workspace-controlled PATH', () => {
    expect(credentialProcessArgv(['/bin/true'], [], 'linux')[0]).toBe(
      '/usr/bin/bwrap',
    )
  })

  it('fails closed on unsupported backends and unsupported existing profiles', () => {
    expect(() => credentialProcessArgv(['/bin/true'], [], 'win32')).toThrow(
      'refusing unconfined',
    )
    expect(() =>
      credentialProcessArgv(
        ['/usr/bin/sandbox-exec', '-f', '/tmp/profile'],
        [],
        'darwin',
      ),
    ).toThrow('cannot be enforced')
  })

  it('does not classify the disabled Git config sink as a credential', () => {
    expect(
      isCredentialPath(
        '/dev/null',
        hostCredentialRoots({
          HOME: '/fixture',
          GIT_CONFIG_GLOBAL: '/dev/null',
        }),
      ),
    ).toBe(false)
  })

  it('protects custom credential locations and missing children without matching siblings', () => {
    const f = fixture()
    const roots = hostCredentialRoots({
      HOME: f.home,
      GH_CONFIG_DIR: join(f.root, 'custom'),
      SSH_AUTH_SOCK: join(f.root, 'agent'),
    })
    expect(isCredentialPath(join(f.root, 'custom', 'new'), roots)).toBe(true)
    expect(isCredentialPath(join(f.root, 'custom-other'), roots)).toBe(false)
    expect(isCredentialPath(join(f.root, 'agent'), roots)).toBe(true)
  })

  it('denies every tool until the required providers are mounted', () => {
    let guard: (() => { reason: string } | undefined) | undefined
    apply({
      tools: {
        guard: callback => {
          guard = callback
        },
      },
      inject: () => undefined,
    })
    expect(guard?.()?.reason).toContain('隔离尚未就绪')
  })

  it('guards native file services and both process entry points, including explicit environment overrides', () => {
    const f = fixture()
    const fs: Record<string, (...args: unknown[]) => unknown> = {
      processPath: target => target,
    }
    const reads = [
      'readText',
      'streamText',
      'readBytes',
      'readByteRange',
      'listDir',
      'writeText',
      'editText',
      'patchText',
      'deleteFile',
      'moveFile',
    ]
    for (const key of reads) fs[key] = () => 'executed'
    const subprocess = {
      spawn: (spec: unknown) => spec,
      spawnTerminal: (spec: unknown) => spec,
    }
    const cleanups: (() => void)[] = []
    apply(
      {
        tools: { guard: () => undefined },
        inject: (_deps, callback) =>
          callback({
            fs,
            subprocess,
            effect: effect => {
              cleanups.push(effect())
            },
          }),
      },
      { credentialRoots: f.roots },
    )
    for (const key of reads)
      expect(() => fs[key]?.(f.secret)).toThrow('账号凭据')
    expect(fs.readText?.(join(f.workspace, 'ordinary'))).toBe('executed')
    expect(() =>
      fs.moveFile?.(join(f.workspace, 'ordinary'), f.secret),
    ).toThrow('账号凭据')
    for (const key of ['spawn', 'spawnTerminal'] as const) {
      const spec = subprocess[key]({
        argv: ['/bin/true'],
        env: {
          GH_TOKEN: 'synthetic',
          PEGAS_DSH_MODEL_KEY_MAGPIE: 'synthetic-model',
          SSH_AUTH_SOCK: '/tmp/agent',
          PATH: '/bin',
        },
      }) as { argv: string[]; env: NodeJS.ProcessEnv }
      expect(spec.argv[0]).toBe(
        process.platform === 'darwin'
          ? '/usr/bin/sandbox-exec'
          : '/usr/bin/bwrap',
      )
      expect(spec.env.GH_TOKEN).toBeUndefined()
      expect(spec.env.PEGAS_DSH_MODEL_KEY_MAGPIE).toBeUndefined()
      expect(spec.env.SSH_AUTH_SOCK).toBeUndefined()
      expect(spec.env.PATH).toBe('/bin')
    }
    for (const cleanup of cleanups.reverse()) cleanup()
    expect(fs.readText?.(f.secret)).toBe('executed')
  })
})
