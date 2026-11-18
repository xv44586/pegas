import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const outputDirectory = path.join(repositoryRoot, 'web/public/icons/agents')
const checkOnly = process.argv.includes('--check')

const iconDefinitions = [
  {
    name: 'bot',
    title: 'Pegas Agent',
    description: 'A minimal white robot face on a blue rounded square.',
    content: `  <g fill="none" stroke="var(--pegas-icon-foreground)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M32 18V11"/>
    <path d="M28 10V7h8v3"/>
    <path d="M17 30h-4m38 0h-4"/>
    <rect x="17" y="18" width="30" height="27" rx="6"/>
  </g>
  <circle cx="27" cy="31.5" r="2.25" fill="var(--pegas-icon-foreground)"/>
  <circle cx="37" cy="31.5" r="2.25" fill="var(--pegas-icon-foreground)"/>`,
  },
  {
    name: 'car',
    title: 'Car Agent',
    description: 'A minimal white car symbol on a blue rounded square.',
    content: `  <g fill="none" stroke="var(--pegas-icon-foreground)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="m16 39 5-12c1-2 3-3 6-3h10c3 0 5 1 6 3l5 12"/>
    <rect x="10" y="37" width="44" height="16" rx="5"/>
    <path d="M23 37l3-8h12l3 8"/>
  </g>
  <circle cx="19" cy="48" r="2.5" fill="var(--pegas-icon-foreground)"/>
  <circle cx="45" cy="48" r="2.5" fill="var(--pegas-icon-foreground)"/>`,
  },
  {
    name: 'camera',
    title: 'Camera Agent',
    description: 'A minimal white camera symbol on a blue rounded square.',
    content: `  <g fill="none" stroke="var(--pegas-icon-foreground)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="m23 21 4-6h10l4 6"/>
    <rect x="10" y="20" width="44" height="32" rx="6"/>
    <circle cx="32" cy="36" r="9"/>
  </g>
  <circle cx="46" cy="27" r="2.25" fill="var(--pegas-icon-foreground)"/>`,
  },
  {
    name: 'computer',
    title: 'Computer Agent',
    description:
      'A minimal white desktop monitor symbol on a blue rounded square.',
    content: `  <g fill="none" stroke="var(--pegas-icon-foreground)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="12" width="46" height="34" rx="6"/>
    <path d="M32 46v8M23 55h18"/>
  </g>`,
  },
  {
    name: 'phone',
    title: 'Phone Agent',
    description: 'A minimal white smartphone symbol on a blue rounded square.',
    content: `  <g fill="none" stroke="var(--pegas-icon-foreground)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="20" y="7" width="24" height="50" rx="7"/>
    <path d="M28 14h8M29 50h6"/>
  </g>`,
  },
]

function renderIcon(definition) {
  const titleId = `pegas-${definition.name}-title`
  const descriptionId = `pegas-${definition.name}-desc`

  return `<svg class="pegas-agent-icon pegas-agent-icon--${definition.name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="${titleId} ${descriptionId}">
  <title id="${titleId}">${definition.title}</title>
  <desc id="${descriptionId}">${definition.description}</desc>
  <style>
    .pegas-agent-icon {
      --pegas-icon-background: #5b6ff5;
      --pegas-icon-foreground: #ffffff;
    }
  </style>
  <rect width="64" height="64" rx="14" fill="var(--pegas-icon-background)"/>
${definition.content}
</svg>
`
}

async function checkGeneratedIcons() {
  const failures = []

  for (const definition of iconDefinitions) {
    const fileName = `pegas-${definition.name}.svg`
    const outputPath = path.join(outputDirectory, fileName)
    const expected = renderIcon(definition)

    try {
      const actual = await readFile(outputPath, 'utf8')
      if (actual !== expected)
        failures.push(`${fileName} differs from the generator output`)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        failures.push(`${fileName} is missing`)
      } else {
        throw error
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures)
      console.error(`Agent icon check failed: ${failure}`)
    console.error('Run `pnpm icons:generate` to restore the committed assets.')
    process.exitCode = 1
    return
  }

  console.log(
    `Agent icon check passed: ${iconDefinitions.length} generated SVG files are current.`,
  )
}

async function generateIcons() {
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all(
    iconDefinitions.map(definition =>
      writeFile(
        path.join(outputDirectory, `pegas-${definition.name}.svg`),
        renderIcon(definition),
      ),
    ),
  )
  console.log(
    `Generated ${iconDefinitions.length} Agent icons in ${path.relative(repositoryRoot, outputDirectory)}.`,
  )
}

if (checkOnly) await checkGeneratedIcons()
else await generateIcons()
