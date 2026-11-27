import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = resolve(
  process.argv[2] ?? resolve(root, 'output/visual-diff'),
)
// Exclusive directory creation protects existing exports and arbitrary paths.
await mkdir(dirname(destination), { recursive: true })
await mkdir(destination, { recursive: false })
await mkdir(resolve(destination, 'scripts'))
await mkdir(resolve(destination, 'references'))
for (const name of ['cli', 'model', 'git', 'render']) {
  await cp(
    resolve(root, `dist/visual-diff/${name}.js`),
    resolve(destination, `scripts/${name}.js`),
  )
  await cp(
    resolve(root, `dist/visual-diff/${name}.d.ts`),
    resolve(destination, `scripts/${name}.d.ts`),
  )
}
const { visualDiffContract } = await import(
  pathToFileURL(resolve(root, 'dist/visual-diff/contract.js')).href
)
await writeFile(
  resolve(destination, 'references/authoring.md'),
  visualDiffContract.trim() + '\n',
)
await cp(
  resolve(root, 'skills/visual-diff/SKILL.md'),
  resolve(destination, 'SKILL.md'),
)
const { version } = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
)
await writeFile(
  resolve(destination, 'package.json'),
  JSON.stringify(
    {
      name: '@pegas/visual-diff',
      version,
      private: true,
      type: 'module',
      engines: { node: '>=24.9.0' },
    },
    null,
    2,
  ) + '\n',
)
process.stdout.write(`Portable skill and renderer: ${destination}\n`)
