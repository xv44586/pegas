import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

interface DatabaseBackupManifest {
  version: 1
  createdAt: string
  sourceDatabase: string
  backupFile: string
  sha256: string
  sizeBytes: number
  schemaVersion: number
}

export interface VerifiedDatabaseBackup extends DatabaseBackupManifest {
  path: string
}

export class BackupVerificationError extends Error {}

export async function createDatabaseBackup(
  databasePath: string,
  backupDirectory: string,
  options: { retention?: number; now?: () => Date } = {},
): Promise<VerifiedDatabaseBackup> {
  const retention = options.retention ?? 7
  if (!Number.isSafeInteger(retention) || retention <= 0 || retention > 100)
    throw new Error('Backup retention must be between 1 and 100')
  if (!existsSync(databasePath))
    throw new Error(`Database ${databasePath} does not exist`)
  mkdirSync(backupDirectory, { recursive: true })
  const createdAt = (options.now?.() ?? new Date()).toISOString()
  const stamp = createdAt.replaceAll(':', '').replaceAll('.', '-')
  const backupName = `pegas-${stamp}.sqlite`
  const temporaryPath = join(backupDirectory, `${backupName}.partial`)
  rmSync(temporaryPath, { force: true })
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try {
    await backup(source, temporaryPath)
    const verified = verifyDatabaseBackup(temporaryPath)
    const finalPath = join(backupDirectory, backupName)
    renameSync(temporaryPath, finalPath)
    const manifest: DatabaseBackupManifest = {
      version: 1,
      createdAt,
      sourceDatabase: databasePath,
      backupFile: backupName,
      sha256: fileSha256(finalPath),
      sizeBytes: statSync(finalPath).size,
      schemaVersion: verified.schemaVersion,
    }
    writeManifest(
      join(backupDirectory, `${backupName}.manifest.json`),
      manifest,
    )
    pruneBackups(backupDirectory, retention)
    return { ...manifest, path: finalPath }
  } finally {
    source.close()
    rmSync(temporaryPath, { force: true })
  }
}

export function listVerifiedBackups(
  backupDirectory: string,
): VerifiedDatabaseBackup[] {
  if (!existsSync(backupDirectory)) return []
  const names = readdirSync(backupDirectory)
    .filter(name => name.endsWith('.manifest.json'))
    .sort()
    .reverse()
  const verified: VerifiedDatabaseBackup[] = []
  for (const name of names) {
    const manifestPath = join(backupDirectory, name)
    try {
      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf8'),
      ) as DatabaseBackupManifest
      if (typeof manifest.backupFile !== 'string') continue
      const path = join(backupDirectory, manifest.backupFile)
      const check = verifyDatabaseBackup(path)
      if (
        fileSha256(path) !== manifest.sha256 ||
        check.schemaVersion !== manifest.schemaVersion
      )
        continue
      verified.push({ ...manifest, path })
    } catch {
      continue
    }
  }
  return verified
}

export function latestVerifiedBackup(
  backupDirectory: string,
): VerifiedDatabaseBackup | undefined {
  return listVerifiedBackups(backupDirectory)[0]
}

export function verifyDatabaseBackup(path: string): { schemaVersion: number } {
  if (!existsSync(path))
    throw new BackupVerificationError('Backup file does not exist')
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as
      Record<string, string> | undefined
    if (!integrity || Object.values(integrity)[0] !== 'ok')
      throw new BackupVerificationError('Backup failed integrity_check')
    const version = database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    if (version.version === null || version.version < 1)
      throw new BackupVerificationError('Backup has no schema migrations')
    return { schemaVersion: version.version }
  } catch (error) {
    if (error instanceof BackupVerificationError) throw error
    throw new BackupVerificationError(
      `Backup is not a readable Pegas database: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    database.close()
  }
}

export function restoreDatabaseBackup(
  backup: VerifiedDatabaseBackup,
  targetDatabasePath: string,
  options: { allowReplace?: boolean } = {},
): { schemaVersion: number } {
  verifyDatabaseBackup(backup.path)
  if (fileSha256(backup.path) !== backup.sha256)
    throw new BackupVerificationError('Backup checksum does not match manifest')
  if (existsSync(targetDatabasePath) && !options.allowReplace)
    throw new Error(
      'Target database already exists; restore into an empty path or pass allowReplace',
    )
  mkdirSync(dirname(targetDatabasePath), { recursive: true })
  if (options.allowReplace) {
    const displaced = `${targetDatabasePath}.pre-restore-${String(Date.now())}`
    if (existsSync(targetDatabasePath))
      renameSync(targetDatabasePath, displaced)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${targetDatabasePath}${suffix}`
      if (existsSync(sidecar)) renameSync(sidecar, `${displaced}${suffix}`)
    }
  }
  copyFileSync(backup.path, targetDatabasePath)
  return verifyDatabaseBackup(targetDatabasePath)
}

function writeManifest(path: string, manifest: DatabaseBackupManifest): void {
  const temporary = `${path}.partial`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temporary, path)
}

function pruneBackups(backupDirectory: string, retention: number): void {
  const manifests = readdirSync(backupDirectory)
    .filter(name => name.endsWith('.manifest.json'))
    .sort()
    .reverse()
  for (const name of manifests.slice(retention)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(backupDirectory, name), 'utf8'),
      ) as DatabaseBackupManifest
      rmSync(join(backupDirectory, manifest.backupFile), { force: true })
      rmSync(join(backupDirectory, name), { force: true })
    } catch {
      rmSync(join(backupDirectory, name), { force: true })
    }
  }
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
