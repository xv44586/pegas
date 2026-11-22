import { describe, expect, it } from 'vitest'

import { tokenizeCodeLine, tokenizeShell } from './activityHighlight'

function joined(tokens: { text: string }[]): string {
  return tokens.map(token => token.text).join('')
}

describe('EXEC-006 P2b shell tokenizer', () => {
  it('reproduces the command verbatim and marks keywords, flags and strings', () => {
    const command = `cd /repo && grep -rn "conflict" src/ | head -3 # note`
    const tokens = tokenizeShell(command)
    expect(joined(tokens)).toBe(command)
    expect(tokens.find(token => token.text === 'cd')?.kind).toBe('keyword')
    expect(tokens.find(token => token.text === '-rn')?.kind).toBe('flag')
    expect(tokens.find(token => token.text === '"conflict"')?.kind).toBe(
      'string',
    )
    expect(tokens.find(token => token.text.startsWith('#'))?.kind).toBe(
      'comment',
    )
    expect(tokens.find(token => token.text === '-3')?.kind).toBe('flag')
    expect(joined(tokenizeShell('head -n 3'))).toBe('head -n 3')
    expect(
      tokenizeShell('head -n 3').find(token => token.text === '3')?.kind,
    ).toBe('number')
  })

  it('marks variables and keeps escaped quotes inside strings', () => {
    const command = "echo \"$HOME/x\" && printf 'a\\'b' $?"
    const tokens = tokenizeShell(command)
    expect(joined(tokens)).toBe(command)
    expect(
      tokens.some(
        token => token.kind === 'string' && token.text.includes('$HOME'),
      ),
    ).toBe(true)
    expect(tokens.find(token => token.text === '$?')?.kind).toBe('variable')
  })

  it('never loses characters on unterminated quotes or lone dollars', () => {
    for (const command of ['echo "open', "printf 'tail", 'echo $', 'a#b']) {
      expect(joined(tokenizeShell(command))).toBe(command)
    }
  })
})

describe('EXEC-006 P2b code-line tokenizer', () => {
  it('reproduces diff lines verbatim with keywords, strings and comments', () => {
    const line = `  const url = 'https://x.dev' // note`
    const tokens = tokenizeCodeLine(line)
    expect(joined(tokens)).toBe(line)
    expect(tokens.find(token => token.text === 'const')?.kind).toBe('keyword')
    expect(tokens.find(token => token.text === "'https://x.dev'")?.kind).toBe(
      'string',
    )
    expect(tokens.find(token => token.text.startsWith('//'))?.kind).toBe(
      'comment',
    )
  })

  it('tolerates unterminated block comments and empty lines', () => {
    expect(joined(tokenizeCodeLine('/* open'))).toBe('/* open')
    expect(tokenizeCodeLine('')).toEqual([])
    const line = 'value = 42'
    const tokens = tokenizeCodeLine(line)
    expect(joined(tokens)).toBe(line)
    expect(tokens.find(token => token.text === '42')?.kind).toBe('number')
  })
})
