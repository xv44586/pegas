import { describe, expect, it } from 'vitest'

import {
  HINDSIGHT_ARM64_IMAGE,
  PGVECTOR_ARM64_IMAGE,
  hindsightRuntimePlan,
} from '../scripts/hindsight-ops.mjs'

describe('Hindsight supervised runtime', () => {
  it('uses persistent PostgreSQL, loopback API, restart supervision and pinned Hindsight', () => {
    const plan = hindsightRuntimePlan({
      PEGAS_HINDSIGHT_DB_PASSWORD: 'database-secret',
      PEGAS_HINDSIGHT_API_KEY: 'tenant-api-secret',
      PEGAS_HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:3425/v1',
      PEGAS_HINDSIGHT_LLM_MODEL: 'discovery-api/deepseek-v4.1-flash-1017',
      PEGAS_HINDSIGHT_BACKUP_DIR: '/tmp/pegas-memory-backups',
    })

    expect(plan.hindsightImage).toBe(HINDSIGHT_ARM64_IMAGE)
    expect(plan.databaseImage).toBe(PGVECTOR_ARM64_IMAGE)
    expect(plan.databaseArgs).toEqual(
      expect.arrayContaining([
        '--restart',
        'unless-stopped',
        '--mount',
        'type=volume,source=pegas-hindsight-pg,target=/var/lib/postgresql/18/docker',
      ]),
    )
    expect(plan.hindsightArgs).toEqual(
      expect.arrayContaining([
        '--restart',
        'unless-stopped',
        '--add-host',
        'host.docker.internal:host-gateway',
        '--publish',
        '127.0.0.1:8888:8888',
        '--mount',
        'type=bind,source=/tmp/pegas-memory-backups,target=/backups',
      ]),
    )
    expect(plan.hindsightEnvironment.HINDSIGHT_API_DATABASE_URL).toContain(
      '@pegas-hindsight-db:5432/hindsight',
    )
    expect(plan.hindsightEnvironment.HINDSIGHT_API_TENANT_EXTENSION).toBe(
      'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
    )
    expect(plan.hindsightEnvironment.HINDSIGHT_API_TENANT_API_KEY).toBe(
      'tenant-api-secret',
    )
    expect(plan.hindsightArgs.join(' ')).not.toContain('database-secret')
    expect(plan.hindsightArgs.join(' ')).not.toContain('tenant-api-secret')
  })

  it('refuses to start an unauthenticated Hindsight API', () => {
    expect(() =>
      hindsightRuntimePlan({
        PEGAS_HINDSIGHT_DB_PASSWORD: 'database-secret',
        PEGAS_HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:3425/v1',
        PEGAS_HINDSIGHT_LLM_MODEL: 'discovery-api/deepseek-v4.1-flash-1017',
      }),
    ).toThrow(/PEGAS_HINDSIGHT_API_KEY/)
  })
})
