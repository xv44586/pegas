import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import {
  createReviewReport,
  parseFeatureIds,
  renderReviewSummary,
  writeReviewReport,
  type ReviewReport,
} from '../src/quality/review-evidence.js'

interface Arguments {
  changedFrom: string
  output: string
  summary: string
  title: string
  featureText: string
  artifactDirectory?: string
  commands: ReviewReport['commands']
  notTried: ReviewReport['notTried']
}

const repositoryRoot = resolve(import.meta.dirname, '..')
const arguments_ = parseArguments(process.argv.slice(2))
const changedFiles = gitLines([
  'diff',
  '--name-only',
  '--diff-filter=ACMRT',
  `${arguments_.changedFrom}...HEAD`,
])
const headCommit = gitLines(['rev-parse', 'HEAD'])[0]
if (!headCommit) throw new Error('Unable to resolve the review commit')
const artifactPaths = arguments_.artifactDirectory
  ? listFiles(resolve(repositoryRoot, arguments_.artifactDirectory)).filter(
      path =>
        basename(path) !== basename(arguments_.output) &&
        basename(path) !== basename(arguments_.summary),
    )
  : []
const notTried = [...arguments_.notTried]
if (
  changedFiles.some(path => path.startsWith('web/')) &&
  !artifactPaths.some(path => /\.(?:png|jpe?g|webp|mp4|webm)$/iu.test(path))
) {
  notTried.push({
    item: 'UI review media',
    reason:
      'Web files changed but the browser collector produced no screenshot or recording.',
    critical: true,
  })
}
if (
  changedFiles.some(path =>
    /^(?:src\/(?:model|speech|notification)|services)\//u.test(path),
  ) &&
  !artifactPaths.some(path => /(?:canary|real-service)/iu.test(basename(path)))
) {
  notTried.push({
    item: 'Real dependency canary',
    reason:
      'External-service code changed but no redacted canary artifact was collected.',
    critical: true,
  })
}

const report = createReviewReport(
  {
    featureIds: parseFeatureIds(arguments_.featureText),
    title: arguments_.title,
    acceptanceRefs: parseFeatureIds(arguments_.featureText).map(
      id => `docs/feature-map.md#${id.toLowerCase()}`,
    ),
    baseRef: arguments_.changedFrom,
    headCommit,
    changedFiles,
    commands: arguments_.commands,
    notTried,
  },
  artifactPaths,
)
const outputPath = resolve(repositoryRoot, arguments_.output)
const summaryPath = resolve(repositoryRoot, arguments_.summary)
writeReviewReport(outputPath, report)
writeFileSync(summaryPath, renderReviewSummary(report), { mode: 0o600 })
console.log(
  `Generated ${report.status} review evidence for ${report.featureIds.join(', ')} at ${arguments_.output}`,
)
if (report.status === 'incomplete') process.exitCode = 1

function parseArguments(values: string[]): Arguments {
  const args = values.filter(value => value !== '--')
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const repeated = (name: string): string[] =>
    args.reduce<string[]>((found, value, index) => {
      const next = args[index + 1]
      if (value === name && next) found.push(next)
      return found
    }, [])
  const changedFrom = option('--changed-from')
  if (!changedFrom) throw new Error('--changed-from requires a Git reference')
  const commands = repeated('--passed').map(value => {
    const [command, ...summary] = value.split('|')
    if (!command?.trim() || !summary.join('|').trim()) {
      throw new Error('--passed expects command|summary')
    }
    return {
      command: command.trim(),
      status: 'passed' as const,
      summary: summary.join('|').trim(),
    }
  })
  if (commands.length === 0) {
    throw new Error('At least one --passed command result is required')
  }
  const notTried = repeated('--not-tried').map(value => {
    const [item, reason, critical] = value.split('|')
    if (!item?.trim() || !reason?.trim()) {
      throw new Error('--not-tried expects item|reason|critical|noncritical')
    }
    if (critical !== 'critical' && critical !== 'noncritical') {
      throw new Error('--not-tried criticality must be critical or noncritical')
    }
    return {
      item: item.trim(),
      reason: reason.trim(),
      critical: critical === 'critical',
    }
  })
  const featureText =
    option('--feature') ?? process.env.REVIEW_FEATURE_IDS ?? ''
  const title = option('--title') ?? process.env.REVIEW_TITLE ?? featureText
  return {
    changedFrom,
    output: option('--output') ?? 'output/feature-review/report.json',
    summary: option('--summary') ?? 'output/feature-review/summary.md',
    title,
    featureText,
    ...(option('--artifacts-dir')
      ? { artifactDirectory: option('--artifacts-dir') }
      : {}),
    commands,
    notTried,
  }
}

function gitLines(arguments_: string[]): string[] {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .map(value => value.split(sep).join('/').trim())
    .filter(Boolean)
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory()
        ? listFiles(path)
        : entry.isFile()
          ? [path]
          : []
    })
    .sort()
}
