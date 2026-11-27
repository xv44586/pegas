import type { PolicyRoots } from './policy-gate.mjs'
export declare const credentialDenial: string
export declare function isCredentialEnvironment(key: string): boolean
export declare function hostCredentialRoots(
  environment?: NodeJS.ProcessEnv,
): string[]
export declare function isCredentialPath(
  path: string,
  roots: readonly string[],
): boolean
export declare function credentialAccess(
  execution: { name: string; arguments?: unknown },
  roots: PolicyRoots,
): boolean
export declare function credentialProcessArgv(
  argv: readonly string[],
  roots: readonly string[],
  platform?: NodeJS.Platform,
): string[]

export declare function credentialFreeEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv
