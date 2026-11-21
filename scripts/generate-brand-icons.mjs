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

const tileSize = 1024
const tileRadius = 224
const mascotBox = { x: 132, y: 150, width: 760, height: 700 }
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

function renderTileScript(sourcePath, outputPath) {
  return `
from PIL import Image, ImageDraw
source = Image.open(${JSON.stringify(sourcePath)}).convert('RGBA')
box = source.getchannel('A').getbbox()
if box:
    source = source.crop(box)
tile = Image.new('RGBA', (${tileSize}, ${tileSize}), (0, 0, 0, 0))
mask = Image.new('L', (${tileSize}, ${tileSize}), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [0, 0, ${tileSize - 1}, ${tileSize - 1}],
    radius=${tileRadius},
    fill=255,
)
tile.paste((82, 103, 248, 255), (0, 0), mask)
scale = min(${mascotBox.width} / source.width, ${mascotBox.height} / source.height)
resized = source.resize(
    (round(source.width * scale), round(source.height * scale)),
    Image.LANCZOS,
)
offset = (
    ${mascotBox.x} + (${mascotBox.width} - resized.width) // 2,
    ${mascotBox.y} + (${mascotBox.height} - resized.height) // 2,
)
tile.alpha_composite(resized, offset)
tile.save(${JSON.stringify(outputPath)})
`
}

function renderAgentAssetScript(sourcePath, outputPath) {
  return `
from PIL import Image
source = Image.open(${JSON.stringify(sourcePath)}).convert('RGBA')
box = source.getchannel('A').getbbox()
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
  const mascotPath = path.join(
    repositoryRoot,
    'web/public/brand/pegas-mascot.png',
  )
  const tilePath = path.join(temporaryDirectory, 'tile-1024.png')
  runPython(renderTileScript(mascotPath, tilePath))

  const tileBase64 = (await readFile(tilePath)).toString('base64')
  const faviconPath = path.join(temporaryDirectory, 'favicon.svg')
  runPython(renderFaviconScript(tilePath, faviconPath))
  const artifacts = [
    {
      outputPath: path.join(repositoryRoot, 'desktop/icon.svg'),
      content: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <image href="data:image/png;base64,${tileBase64}" width="1024" height="1024"/>
</svg>
`,
        'utf8',
      ),
    },
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
    runPython(renderAgentAssetScript(sourcePath, outputPath))
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
      console.error('Run `pnpm brand:generate` to restore the assets.')
      process.exitCode = 1
      return
    }
    console.log(
      `Brand icon check passed: ${Object.keys(manifest).length} artifacts match the manifest.`,
    )
    return
  }
  const artifacts = await buildArtifacts()
  for (const artifact of artifacts)
    await writeFile(artifact.outputPath, artifact.content)
  const manifest = {}
  for (const artifact of artifacts) {
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
