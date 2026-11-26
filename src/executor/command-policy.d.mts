export interface CommandSelector {
  version: 1
  executable: string
  executableHash: string
  argv: string[]
  cwd: string
  environmentHash: string
  family: 'git-fetch'
  repository: string
  repositoryId: string
  remote: string
  remoteUrl: string
  configurationHash: string
}
export function commandAuthorization(
  command: string,
  directory: string,
  protectedRoots?: readonly string[],
  environment?: Record<string, string | undefined>,
): { selector?: CommandSelector; reason?: string }
export function commandFingerprint(
  selector: CommandSelector,
  precision: 'exact' | 'family',
): string
export function isCommandSelector(value: unknown): value is CommandSelector
export function isGitFetchCommand(command: string): boolean
