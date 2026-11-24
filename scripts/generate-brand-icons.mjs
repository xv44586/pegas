import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const checkOnly = process.argv.includes('--check')
const temporaryDirectory = path.join(repositoryRoot, 'output/brand-icons-tmp')
const manifestPath = path.join(
  repositoryRoot,
  'scripts/brand-icons-manifest.json',
)

const tilePath = path.join(repositoryRoot, 'desktop/icon.png')
const approvedSources = [
  'desktop/icon.png',
  'desktop/icon.svg',
  'web/public/brand/pegas-mascot.png',
  'web/public/brand/pegas-home.svg',
  'web/public/brand/pegas-flight.svg',
  'web/public/brand/pegas-speaking.svg',
]
const agentTileSize = 256
const agentIconIds = ['bot', 'car', 'camera', 'computer', 'phone']
const agentSourceNames = {
  bot: 'pegas-mascot.png',
  car: 'worker-car.png',
  camera: 'worker-camera.png',
  computer: 'worker-computer.png',
  phone: 'worker-phone.png',
}

const icnsEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]

function runPython(script) {
  return execFileSync('python3', ['-c', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function renderAgentAssetScript(sourcePath, outputPath, alphaThreshold) {
  return `
from PIL import Image
source = Image.open(${JSON.stringify(sourcePath)}).convert('RGBA')
alpha = source.getchannel('A').point(lambda value: 255 if value > ${alphaThreshold} else 0)
box = alpha.getbbox()
if box:
    source = source.crop(box)
scale = min(${agentTileSize} / source.width, ${agentTileSize} / source.height)
resized = source.resize(
    (round(source.width * scale), round(source.height * scale)),
    Image.LANCZOS,
)
canvas = Image.new('RGBA', (${agentTileSize}, ${agentTileSize}), (0, 0, 0, 0))
canvas.alpha_composite(
    resized,
    ((${agentTileSize} - resized.width) // 2, (${agentTileSize} - resized.height) // 2),
)
canvas.save(${JSON.stringify(outputPath)}, format='WEBP', lossless=True, quality=100, method=6)
`
}

function resizeScript(sourcePath, outputPath, size) {
  return `
from PIL import Image
image = Image.open(${JSON.stringify(sourcePath)}).convert('RGBA')
image.resize((${size}, ${size}), Image.LANCZOS).save(${JSON.stringify(outputPath)})
`
}

function renderFaviconScript(tilePath, outputPath) {
  return `
import base64, io
from PIL import Image
image = Image.open(${JSON.stringify(tilePath)}).convert('RGBA')
image = image.resize((128, 128), Image.LANCZOS)
buffer = io.BytesIO()
image.save(buffer, format='PNG', optimize=True)
encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\\n'
    '  <image href="data:image/png;base64,' + encoded + '" width="64" height="64"/>\\n'
    '</svg>\\n'
)
with open(${JSON.stringify(outputPath)}, 'w', encoding='utf-8') as handle:
    handle.write(svg)
`
}

async function buildArtifacts() {
  await mkdir(temporaryDirectory, { recursive: true })
  const faviconPath = path.join(temporaryDirectory, 'favicon.svg')
  runPython(renderFaviconScript(tilePath, faviconPath))
  const artifacts = [
    {
      outputPath: path.join(repositoryRoot, 'web/public/favicon.svg'),
      content: await readFile(faviconPath),
    },
  ]

  for (const iconId of agentIconIds) {
    const sourcePath = path.join(
      repositoryRoot,
      'web/public/brand',
      agentSourceNames[iconId],
    )
    const outputPath = path.join(
      repositoryRoot,
      'web/public/brand',
      `agent-${iconId}.webp`,
    )
    // Ignore near-transparent edge artifacts in the generated mascot master.
    runPython(
      renderAgentAssetScript(sourcePath, outputPath, iconId === 'bot' ? 4 : 0),
    )
    artifacts.push({ outputPath, content: await readFile(outputPath) })
  }

  const pngSizes = [
    ['favicon-32.png', 32],
    ['apple-touch-icon.png', 180],
  ]
  for (const [fileName, size] of pngSizes) {
    const outputPath = path.join(temporaryDirectory, fileName)
    runPython(resizeScript(tilePath, outputPath, size))
    artifacts.push({
      outputPath: path.join(repositoryRoot, 'web/public', fileName),
      content: await readFile(outputPath),
    })
  }

  const chunks = []
  for (const [type, size] of icnsEntries) {
    const entryPath = path.join(temporaryDirectory, `icns-${size}.png`)
    runPython(resizeScript(tilePath, entryPath, size))
    const payload = await readFile(entryPath)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'latin1')
    header.writeUInt32BE(payload.length + 8, 4)
    chunks.push(Buffer.concat([header, payload]))
  }
  const body = Buffer.concat(chunks)
  const icns = Buffer.alloc(8)
  icns.write('icns', 0, 'latin1')
  icns.writeUInt32BE(body.length + 8, 4)
  artifacts.push({
    outputPath: path.join(repositoryRoot, 'desktop/Pegas.icns'),
    content: Buffer.concat([icns, body]),
  })

  return artifacts
}

async function main() {
  if (checkOnly) {
    // Hash comparison keeps the gate runnable on CI without Python/Pillow;
    // regeneration (brand:generate) is the only step that needs Pillow.
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const failures = []
    for (const [relativePath, expectedHash] of Object.entries(manifest)) {
      const outputPath = path.join(repositoryRoot, relativePath)
      try {
        const actual = await readFile(outputPath)
        const hash = createHash('sha256').update(actual).digest('hex')
        if (hash !== expectedHash)
          failures.push(`${relativePath} differs from the manifest`)
      } catch {
        failures.push(`${relativePath} is missing`)
      }
    }
    if (failures.length) {
      for (const failure of failures)
        console.error(`Brand icon check failed: ${failure}`)
      console.error(
        'Restore the approved sources or run `pnpm brand:generate` after an intentional asset change.',
      )
      process.exitCode = 1
      return
    }
    console.log(
      `Brand icon check passed: ${Object.keys(manifest).length} artifacts match the manifest.`,
    )
    return
  }
  const artifacts = await buildArtifacts()
  const manifest = {}
  for (const relativePath of approvedSources) {
    const content = await readFile(path.join(repositoryRoot, relativePath))
    manifest[relativePath] = createHash('sha256').update(content).digest('hex')
  }
  for (const artifact of artifacts) {
    await writeFile(artifact.outputPath, artifact.content)
    const relativePath = path.relative(repositoryRoot, artifact.outputPath)
    manifest[relativePath] = createHash('sha256')
      .update(artifact.content)
      .digest('hex')
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, Object.keys(manifest).sort(), 2)}\n`,
  )
  console.log(`Generated ${artifacts.length} brand icon artifacts.`)
}

await main()
