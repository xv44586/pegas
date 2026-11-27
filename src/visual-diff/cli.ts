import { readFile, writeFile } from 'node:fs/promises'
import { verifyVisualDiff } from './git.js'
import { renderVisualDiff } from './render.js'

const [input, output, directory, ...extra] = process.argv.slice(2)
if (!input || !output || !directory || extra.length) {
  process.stderr.write(
    'Usage: node cli.js input.json output.svg repository-directory\n',
  )
  process.exitCode = 1
} else {
  try {
    const source = await readFile(input, 'utf8')
    if (source.length > 32_768)
      throw new Error('Visual diff input exceeds 32 KiB')
    const spec = await verifyVisualDiff(
      JSON.parse(source) as unknown,
      directory,
    )
    // Exclusive creation: a failed/repeated invocation cannot clobber good output.
    await writeFile(output, renderVisualDiff(spec), { flag: 'wx', mode: 0o600 })
    process.stdout.write(`${output}\n`)
  } catch {
    process.stderr.write(
      'Visual diff generation failed: check schema, Git references and output path.\n',
    )
    process.exitCode = 1
  }
}
