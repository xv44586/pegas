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

  it('supervises both containers with injection-safe health checks', () => {
    const plan = hindsightRuntimePlan({
      PEGAS_HINDSIGHT_DB_PASSWORD: 'database-secret',
      PEGAS_HINDSIGHT_API_KEY: 'tenant-api-secret',
      PEGAS_HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:3425/v1',
      PEGAS_HINDSIGHT_LLM_MODEL: 'discovery-api/deepseek-v4.1-flash-1017',
    })
    const databaseHealthIndex = plan.databaseArgs.indexOf('--health-cmd')
    expect(databaseHealthIndex).toBeGreaterThan(-1)
    const databaseHealth = plan.databaseArgs[databaseHealthIndex + 1] ?? ''
    expect(databaseHealth).toBe(
      "'pg_isready' '-U' 'hindsight' '-d' 'hindsight'",
    )
    const apiHealthIndex = plan.hindsightArgs.indexOf('--health-cmd')
    expect(apiHealthIndex).toBeGreaterThan(-1)
    const apiHealth = plan.hindsightArgs[apiHealthIndex + 1] ?? ''
    expect(apiHealth).toContain('/app/api/.venv/bin/python3')
    expect(apiHealth).toContain('http://127.0.0.1:8888/health')
    expect(plan.hindsightArgs).toEqual(
      expect.arrayContaining(['--health-start-period', '30s']),
    )
  })

  it('quotes health check identifiers so they cannot inject shell syntax', () => {
    const plan = hindsightRuntimePlan({
      PEGAS_HINDSIGHT_DB_PASSWORD: 'database-secret',
      PEGAS_HINDSIGHT_API_KEY: 'tenant-api-secret',
      PEGAS_HINDSIGHT_DB_USER: "hindsight; rm -rf /; echo '",
      PEGAS_HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:3425/v1',
      PEGAS_HINDSIGHT_LLM_MODEL: 'discovery-api/deepseek-v4.1-flash-1017',
    })
    const databaseHealth =
      plan.databaseArgs[plan.databaseArgs.indexOf('--health-cmd') + 1] ?? ''
    expect(databaseHealth).toContain("'hindsight; rm -rf /; echo '\\'''")
    expect(databaseHealth.startsWith("'pg_isready'")).toBe(true)
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
