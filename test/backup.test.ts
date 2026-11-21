import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  BackupVerificationError,
  createDatabaseBackup,
  latestVerifiedBackup,
  listVerifiedBackups,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from '../src/storage/backup.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace(): { root: string; database: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), 'pegas-backup-'))
  directories.push(root)
  return {
    root,
    database: join(root, 'pegas.sqlite'),
    backups: join(root, 'backups'),
  }
}

describe('database backup and restore', () => {
  it('creates a verified online backup while writers hold the database', async () => {
    const { database, backups } = workspace()
    const store = new PegasStore(database)
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '在线备份期间保持写入' },
    })
    const created = await createDatabaseBackup(database, backups)
    expect(created.schemaVersion).toBeGreaterThanOrEqual(21)
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyDatabaseBackup(created.path).schemaVersion).toBe(
      created.schemaVersion,
    )
    const restored = new PegasStore(created.path)
    expect(restored.listEvents('owner')).toHaveLength(1)
    restored.close()
    store.close()
  })

  it('prunes to retention and skips corrupted or tampered backups', async () => {
    const { database, backups } = workspace()
    const store = new PegasStore(database)
    store.close()
    let tick = 0
    const now = () => new Date(Date.UTC(2026, 10, 21, 0, 0, (tick += 1)))
    const first = await createDatabaseBackup(database, backups, {
      retention: 2,
      now,
    })
    const second = await createDatabaseBackup(database, backups, {
      retention: 2,
      now,
    })
    const third = await createDatabaseBackup(database, backups, {
      retention: 2,
      now,
    })
    const listed = listVerifiedBackups(backups)
    expect(listed.map(item => item.path)).toEqual([third.path, second.path])
    expect(latestVerifiedBackup(backups)?.path).toBe(third.path)
    expect(() => verifyDatabaseBackup(first.path)).toThrow(
      BackupVerificationError,
    )

    writeFileSync(second.path, Buffer.concat([Buffer.from('corrupt')]))
    expect(listVerifiedBackups(backups).map(item => item.path)).toEqual([
      third.path,
    ])
  })

  it('restores into an empty environment and continues unfinished Tasks', async () => {
    const { root, database, backups } = workspace()
    const store = new PegasStore(database)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '恢复后必须继续这项工作' },
    }).event
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test', () => ({
        executor: 'echo-test',
      })),
      'backup-router',
    )
    expect(event.id).toBeDefined()
    const created = await createDatabaseBackup(database, backups)
    store.close()

    const restoredPath = join(root, 'restored', 'pegas.sqlite')
    const restoredInfo = restoreDatabaseBackup(created, restoredPath)
    expect(restoredInfo.schemaVersion).toBe(created.schemaVersion)
    expect(() => restoreDatabaseBackup(created, restoredPath)).toThrow(
      /already exists/,
    )

    const restored = new PegasStore(restoredPath)
    const tasks = restored.listTasks('owner')
    expect(tasks).toHaveLength(1)
    const claimed = restored.claimNextRun('restored-worker')
    expect(claimed?.task.id).toBe(tasks[0]?.id)
    expect(claimed?.run.input).toBe('恢复后必须继续这项工作')
    restored.close()
  })

  it('refuses to restore a checksum-mismatched backup', async () => {
    const { root, database, backups } = workspace()
    const store = new PegasStore(database)
    store.close()
    const created = await createDatabaseBackup(database, backups)
    writeFileSync(created.path, Buffer.concat([Buffer.from('tampered')]))
    expect(() =>
      restoreDatabaseBackup(created, join(root, 'target.sqlite')),
    ).toThrow(BackupVerificationError)
  })
})
