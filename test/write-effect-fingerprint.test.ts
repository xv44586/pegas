import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { deriveWriteEffect } from '../src/executor/write-effect.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace(): { workspace: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'pegas-write-effect-'))
  temporaryDirectories.push(base)
  const roots = {
    workspace: join(realpathSync(base), 'workspace'),
    outside: join(realpathSync(base), 'outside'),
  }
  mkdirSync(roots.workspace, { recursive: true })
  mkdirSync(roots.outside, { recursive: true })
  return roots
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function derive(
  name: string,
  arguments_: unknown,
  workspaceRoot: string,
): Record<string, unknown> | undefined {
  return deriveWriteEffect({ name, arguments: arguments_ }, { workspaceRoot })
}

describe('write effect fingerprint derivation', () => {
  it('hashes the full content of a write call', () => {
    const roots = workspace()
    const effect = derive(
      'write',
      { file_path: join(roots.outside, 'a.txt'), content: 'hello' },
      roots.workspace,
    )
    expect(effect).toEqual({ contentHash: sha256('hello') })
  })

  it('derives the final bytes of a unique literal edit on an LF file', () => {
    const roots = workspace()
    const target = join(roots.outside, 'plan.md')
    writeFileSync(target, 'alpha\nbeta\ngamma\n')
    const effect = derive(
      'edit',
      { file_path: target, old_string: 'beta', new_string: 'BETA' },
      roots.workspace,
    )
    expect(effect).toEqual({
      contentHash: sha256('alpha\nBETA\ngamma\n'),
    })
  })

  it('replaces every occurrence only when replace_all is true', () => {
    const roots = workspace()
    const target = join(roots.outside, 'repeat.md')
    writeFileSync(target, 'x\nx\n')
    expect(
      derive(
        'edit',
        { file_path: target, old_string: 'x', new_string: 'y' },
        roots.workspace,
      ),
    ).toBeUndefined()
    expect(
      derive(
        'edit',
        {
          file_path: target,
          old_string: 'x',
          new_string: 'y',
          replace_all: true,
        },
        roots.workspace,
      ),
    ).toEqual({ contentHash: sha256('y\ny\n') })
  })

  it('restores CRLF line endings for the landed bytes', () => {
    const roots = workspace()
    const target = join(roots.outside, 'crlf.txt')
    writeFileSync(target, 'one\r\ntwo\r\nthree\r\n')
    const effect = derive(
      'edit',
      { file_path: target, old_string: 'two', new_string: 'TWO' },
      roots.workspace,
    )
    expect(effect).toEqual({
      contentHash: sha256('one\r\nTWO\r\nthree\r\n'),
    })
  })

  it('returns no fingerprint when the edit cannot apply or the file is unreadable', () => {
    const roots = workspace()
    const target = join(roots.outside, 'binary.bin')
    writeFileSync(target, Buffer.from([0, 1, 2]))
    expect(
      derive(
        'edit',
        { file_path: target, old_string: 'a', new_string: 'b' },
        roots.workspace,
      ),
    ).toBeUndefined()
    expect(
      derive(
        'edit',
        {
          file_path: join(roots.outside, 'missing.txt'),
          old_string: 'a',
          new_string: 'b',
        },
        roots.workspace,
      ),
    ).toBeUndefined()
    const text = join(roots.outside, 'text.txt')
    writeFileSync(text, 'only\n')
    expect(
      derive(
        'edit',
        { file_path: text, old_string: 'absent', new_string: 'b' },
        roots.workspace,
      ),
    ).toBeUndefined()
    expect(
      derive(
        'edit',
        { file_path: text, old_string: '', new_string: 'b' },
        roots.workspace,
      ),
    ).toBeUndefined()
  })

  it('derives per-target final bytes for a single-file update patch', () => {
    const roots = workspace()
    const target = join(roots.outside, 'patched.md')
    writeFileSync(target, 'first\nsecond\nthird\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Update File: ${target}`,
          '@@',
          ' first',
          '-second',
          '+SECOND',
          ' third',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('first\nSECOND\nthird\n') },
    })
  })

  it('derives the added content of a single-file add patch', () => {
    const roots = workspace()
    const target = join(roots.outside, 'added.md')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Add File: ${target}`,
          '+line one',
          '+line two',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('line one\nline two\n') },
    })
  })

  it('anchors an End of File hunk to the file tail', () => {
    const roots = workspace()
    const target = join(roots.outside, 'tail.md')
    writeFileSync(target, 'keep\nkeep\ndrop\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Update File: ${target}`,
          '@@',
          '-drop',
          '+dropped',
          '*** End of File',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('keep\nkeep\ndropped\n') },
    })
  })

  it('refuses unmatched patches honestly', () => {
    const roots = workspace()
    const first = join(roots.outside, 'one.md')
    const second = join(roots.outside, 'two.md')
    writeFileSync(first, 'a\n')
    writeFileSync(second, 'b\n')
    expect(
      derive(
        'apply_patch',
        {
          input: [
            '*** Begin Patch',
            `*** Update File: ${first}`,
            '@@',
            '-absent',
            '+A',
            '*** End Patch',
          ].join('\n'),
        },
        roots.workspace,
      ),
    ).toBeUndefined()
    expect(
      derive('apply_patch', { input: 'not a patch at all' }, roots.workspace),
    ).toBeUndefined()
  })

  it('resolves relative patch paths against the workspace root', () => {
    const roots = workspace()
    const target = join(roots.workspace, 'rel.md')
    writeFileSync(target, 'old\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          '*** Update File: rel.md',
          '@@',
          '-old',
          '+new',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('new\n') },
    })
  })

  it('never derives effects for unrelated tools', () => {
    const roots = workspace()
    expect(
      derive('bash', { command: 'echo x' }, roots.workspace),
    ).toBeUndefined()
    expect(derive('read', {}, roots.workspace)).toBeUndefined()
  })

  it('derives per-file final bytes for a multi-file update patch', () => {
    const roots = workspace()
    const first = join(roots.outside, 'multi-one.md')
    const second = join(roots.outside, 'multi-two.md')
    writeFileSync(first, 'a\n')
    writeFileSync(second, 'b\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Update File: ${first}`,
          '@@',
          '-a',
          '+A',
          `*** Update File: ${second}`,
          '@@',
          '-b',
          '+B',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: {
        [first]: sha256('A\n'),
        [second]: sha256('B\n'),
      },
    })
  })

  it('expects deleted files to be absent', () => {
    const roots = workspace()
    const target = join(roots.outside, 'doomed.md')
    writeFileSync(target, 'gone soon\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Delete File: ${target}`,
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({ absent: [target] })
  })

  it('derives the moved destination bytes and the absent source', () => {
    const roots = workspace()
    const source = join(roots.outside, 'before.md')
    const destination = join(roots.outside, 'after.md')
    writeFileSync(source, 'x\ny\n')
    const effect = derive(
      'apply_patch',
      {
        input: [
          '*** Begin Patch',
          `*** Update File: ${source}`,
          `*** Move to: ${destination}`,
          '@@',
          '-x',
          '+X',
          ' y',
          '*** End Patch',
        ].join('\n'),
      },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [destination]: sha256('X\ny\n') },
      absent: [source],
    })
  })

  it('refuses a patch whose operations touch the same canonical path twice', () => {
    const roots = workspace()
    const target = join(roots.outside, 'twice.md')
    writeFileSync(target, 'a\n')
    expect(
      derive(
        'apply_patch',
        {
          input: [
            '*** Begin Patch',
            `*** Update File: ${target}`,
            '@@',
            '-a',
            '+A',
            `*** Delete File: ${target}`,
            '*** End Patch',
          ].join('\n'),
        },
        roots.workspace,
      ),
    ).toBeUndefined()
  })

  it('derives the appended bytes of a simple bash append redirect', () => {
    const roots = workspace()
    const target = join(roots.outside, 'log.txt')
    writeFileSync(target, 'line one\n')
    const effect = derive(
      'bash',
      { command: `echo "line two" >> ${target}` },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('line one\nline two\n') },
    })
  })

  it('derives a full overwrite from a single-argument echo redirect', () => {
    const roots = workspace()
    const target = join(roots.outside, 'fresh.txt')
    const effect = derive(
      'bash',
      { command: `echo 'hello world' > ${target}` },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('hello world\n') },
    })
  })

  it('derives printf output with escape sequences', () => {
    const roots = workspace()
    const target = join(roots.outside, 'printf.txt')
    const effect = derive(
      'bash',
      { command: `printf 'a\\nb\\n' > ${target}` },
      roots.workspace,
    )
    expect(effect).toEqual({
      targets: { [target]: sha256('a\nb\n') },
    })
  })

  it('refuses bash forms it cannot statically replay', () => {
    const roots = workspace()
    const target = join(roots.outside, 'complex.txt')
    writeFileSync(target, 'base\n')
    for (const command of [
      `cat other.txt >> ${target}`,
      `echo $(date) > ${target}`,
      `echo one > ${target} && echo two > ${target}`,
      `echo x | tee ${target}`,
      `echo "unterminated > ${target}`,
      `echo x >> ${target}; echo y >> ${target}`,
      `echo x > /dev/null`,
    ]) {
      expect(
        derive('bash', { command }, roots.workspace),
        command,
      ).toBeUndefined()
    }
  })
})
