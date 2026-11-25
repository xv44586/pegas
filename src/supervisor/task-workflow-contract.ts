import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readTaskWorkflowContract(
  root: string,
  tree: 'dist' | 'src' = 'dist',
): { version: number; maximumSchema: number } | undefined {
  const path = join(root, tree, 'supervisor', 'task-workflow-contract.json')
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !('maximumSchema' in value) ||
    typeof value.maximumSchema !== 'number' ||
    !Number.isSafeInteger(value.maximumSchema) ||
    value.maximumSchema < 1
  )
    throw new Error('Invalid release Task workflow contract')
  return { version: value.version, maximumSchema: value.maximumSchema }
}
