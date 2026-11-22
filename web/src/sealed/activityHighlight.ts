export interface HighlightToken {
  text: string
  kind?: 'keyword' | 'string' | 'comment' | 'number' | 'flag' | 'variable'
}

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'time',
  'return',
  'exit',
  'local',
  'export',
  'readonly',
  'set',
  'unset',
  'shift',
  'cd',
  'echo',
  'printf',
  'read',
  'source',
  'eval',
  'exec',
  'trap',
])

/**
 * EXEC-006 P2b: a bounded, dependency-free shell tokenizer for display only.
 * It never rewrites the command text — concatenating the tokens always
 * reproduces the input verbatim, so copying and screen readers stay faithful.
 */
export function tokenizeShell(command: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let index = 0
  const push = (text: string, kind?: HighlightToken['kind']) => {
    if (!text) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push(kind ? { text, kind } : { text })
  }
  while (index < command.length) {
    const character = command[index] ?? ''
    if (
      character === '#' &&
      (index === 0 || /\s/u.test(command[index - 1] ?? ''))
    ) {
      const end = command.indexOf('\n', index)
      const stop = end === -1 ? command.length : end
      push(command.slice(index, stop), 'comment')
      index = stop
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      let stop = index + 1
      while (stop < command.length) {
        if (command[stop] === '\\') {
          stop += 2
          continue
        }
        if (command[stop] === character) {
          stop += 1
          break
        }
        stop += 1
      }
      push(command.slice(index, Math.min(stop, command.length)), 'string')
      index = Math.min(stop, command.length)
      continue
    }
    if (character === '$') {
      const match = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!])/u.exec(
        command.slice(index),
      )
      if (match) {
        push(match[0], 'variable')
        index += match[0].length
        continue
      }
    }
    if (character === '-' && /[\s=]/u.test(command[index - 1] ?? ' ')) {
      const match = /^--?[A-Za-z0-9][A-Za-z0-9-]*/u.exec(command.slice(index))
      if (match) {
        push(match[0], 'flag')
        index += match[0].length
        continue
      }
    }
    if (/[A-Za-z_]/u.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/u.exec(command.slice(index))
      const word = match?.[0] ?? character
      const before = command.slice(0, index)
      const atWordStart =
        index === 0 || /[\s;|&(`]/u.test(command[index - 1] ?? '')
      if (atWordStart && SHELL_KEYWORDS.has(word) && !before.endsWith('=')) {
        push(word, 'keyword')
      } else {
        push(word)
      }
      index += word.length
      continue
    }
    if (/[0-9]/u.test(character)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/u.exec(command.slice(index))
      const word = match?.[0] ?? character
      const boundary = index === 0 || /[\s=:,(]/u.test(command[index - 1] ?? '')
      push(word, boundary ? 'number' : undefined)
      index += word.length
      continue
    }
    push(character)
    index += 1
  }
  return tokens
}

const CODE_KEYWORDS =
  /^(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield|interface|type|enum|implements|readonly|public|private|protected|abstract|as|satisfies|keyof|namespace|declare|def|elif|except|lambda|pass|raise|with|None|True|False|nil|end|fn|mut|pub|use|match|struct|impl|trait|package|func|defer|go|range|select|var)$/u

/**
 * Bounded tokenizer for one diff line (JS/TS-flavoured, tolerant of other
 * languages). Display-only: token concatenation reproduces the line exactly.
 */
export function tokenizeCodeLine(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let index = 0
  const push = (text: string, kind?: HighlightToken['kind']) => {
    if (!text) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push(kind ? { text, kind } : { text })
  }
  while (index < line.length) {
    const rest = line.slice(index)
    if (rest.startsWith('//') || rest.startsWith('#')) {
      push(rest, 'comment')
      break
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/')
      const stop = end === -1 ? rest.length : end + 2
      push(rest.slice(0, stop), 'comment')
      index += stop
      continue
    }
    const character = line[index] ?? ''
    if (character === '"' || character === "'" || character === '`') {
      let stop = index + 1
      while (stop < line.length) {
        if (line[stop] === '\\') {
          stop += 2
          continue
        }
        if (line[stop] === character) {
          stop += 1
          break
        }
        stop += 1
      }
      push(line.slice(index, Math.min(stop, line.length)), 'string')
      index = Math.min(stop, line.length)
      continue
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(rest)
      const word = match?.[0] ?? character
      push(word, CODE_KEYWORDS.test(word) ? 'keyword' : undefined)
      index += word.length
      continue
    }
    if (/[0-9]/u.test(character)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/u.exec(rest)
      const word = match?.[0] ?? character
      const boundary =
        index === 0 || !/[A-Za-z0-9_$]/u.test(line[index - 1] ?? '')
      push(word, boundary ? 'number' : undefined)
      index += word.length
      continue
    }
    push(character)
    index += 1
  }
  return tokens
}
