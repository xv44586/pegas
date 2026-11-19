import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface CssBlock {
  body: string
  selector: string
}

type Declarations = Map<string, string>

function extractTopLevelBlocks(source: string): CssBlock[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: CssBlock[] = []
  let blockStart = 0
  let bodyStart = 0
  let depth = 0
  let selector = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '{') {
      if (depth === 0) {
        selector = withoutComments.slice(blockStart, index).trim()
        bodyStart = index + 1
      }
      depth += 1
      continue
    }

    if (character !== '}' || depth === 0) {
      continue
    }

    depth -= 1
    if (depth === 0) {
      if (selector && !selector.startsWith('@')) {
        blocks.push({
          body: withoutComments.slice(bodyStart, index),
          selector: selector.replace(/\s+/g, ' '),
        })
      }
      blockStart = index + 1
    }
  }

  return blocks
}

function parseDeclarations(body: string): Declarations {
  const declarations: Declarations = new Map()
  const declarationPattern = /(?:^|;)\s*([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|$)/gi

  for (const match of body.matchAll(declarationPattern)) {
    const property = match[1]?.toLowerCase()
    const value = match[2]
      ?.replace(/\s*!important\s*$/i, '')
      .trim()
      .toLowerCase()
    if (property && value) {
      declarations.set(property, value)
    }
  }

  return declarations
}

export function findImplicitFlexAxisLeaks(
  source: string,
  file: string,
): string[] {
  const selectorState = new Map<string, Declarations>()
  const findings: string[] = []

  for (const block of extractTopLevelBlocks(source)) {
    const previous =
      selectorState.get(block.selector) ?? new Map<string, string>()
    const current = parseDeclarations(block.body)
    const changesToColumnFlex =
      current.get('display') === 'flex' &&
      current.get('flex-direction') === 'column'
    const inheritedAlignment = previous.get('align-items')

    if (
      changesToColumnFlex &&
      inheritedAlignment &&
      !current.has('align-items')
    ) {
      findings.push(
        `${file}: ${block.selector} changes to column flex without resetting align-items (currently ${inheritedAlignment})`,
      )
    }

    selectorState.set(block.selector, new Map([...previous, ...current]))
  }

  return findings
}

async function collectCssFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return collectCssFiles(path)
      }
      return entry.isFile() && entry.name.endsWith('.css') ? [path] : []
    }),
  )
  return files.flat()
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const cssRoot = join(repositoryRoot, 'web', 'src')
  const files = await collectCssFiles(cssRoot)
  const findings: string[] = []

  for (const file of files) {
    const displayPath = relative(repositoryRoot, file)
    findings.push(
      ...findImplicitFlexAxisLeaks(await readFile(file, 'utf8'), displayPath),
    )
  }

  if (findings.length > 0) {
    console.error('CSS cascade lint failed:')
    for (const finding of findings) {
      console.error(`- ${finding}`)
    }
    console.error(
      'Explicitly reset align-items in the later column-flex override.',
    )
    process.exitCode = 1
    return
  }

  console.log(
    `CSS cascade lint passed: ${String(files.length)} file(s) checked.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main()
}
