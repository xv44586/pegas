import { resolve } from 'node:path'

import {
  createDatabaseBackup,
  latestVerifiedBackup,
  listVerifiedBackups,
  restoreDatabaseBackup,
} from '../storage/backup.js'

const command = process.argv[2]
const databasePath = resolve(
  process.env.PEGAS_DATA_DIR
    ? resolve(process.env.PEGAS_DATA_DIR, 'pegas.sqlite')
    : './data/pegas.sqlite',
)
const backupDirectory = resolve(
  process.env.PEGAS_BACKUP_DIR ??
    resolve(process.env.PEGAS_DATA_DIR ?? './data', 'backups'),
)

switch (command) {
  case 'create': {
    const created = await createDatabaseBackup(databasePath, backupDirectory)
    console.log(
      `Backup created: ${created.path} (schema v${String(created.schemaVersion)}, sha256 ${created.sha256})`,
    )
    break
  }
  case 'list': {
    const backups = listVerifiedBackups(backupDirectory)
    if (backups.length === 0) {
      console.log('No verified backups found')
    }
    for (const item of backups) {
      console.log(
        `${item.createdAt}  schema v${String(item.schemaVersion)}  ${item.path}`,
      )
    }
    break
  }
  case 'verify': {
    const latest = latestVerifiedBackup(backupDirectory)
    if (!latest) {
      console.error('No verified backup available')
      process.exitCode = 1
      break
    }
    console.log(`Latest verified backup: ${latest.path}`)
    break
  }
  case 'restore': {
    const target = process.argv[3]
    if (!target) {
      console.error('Usage: backup restore <target-database-path>')
      process.exitCode = 1
      break
    }
    const latest = latestVerifiedBackup(backupDirectory)
    if (!latest) {
      console.error('No verified backup available')
      process.exitCode = 1
      break
    }
    const restored = restoreDatabaseBackup(latest, resolve(target), {
      allowReplace: process.argv.includes('--replace'),
    })
    console.log(
      `Restored ${latest.path} into ${resolve(target)} (schema v${String(restored.schemaVersion)})`,
    )
    break
  }
  default:
    console.error('Usage: backup <create|list|verify|restore <path>>')
    process.exitCode = 1
}
