import { readFile } from 'node:fs/promises'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertWebAuthSchema } from '../database/preflight.js'
import { PostgresMembershipStore, PostgresSessionStore } from './postgres-session-store.js'
import { AuthRateLimiter, PostgresRateLimitStore } from './rate-limit.js'
import { SessionService } from './session.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithPostgres = databaseUrl ? describe : describe.skip

describeWithPostgres('PostgresSessionStore', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const memberships = new PostgresMembershipStore(pool)
  const sessions = new SessionService(new PostgresSessionStore(pool), 3_600, 600)

  beforeAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS web_private CASCADE')
    await pool.query('DROP SCHEMA IF EXISTS daejang_meta CASCADE')
    await pool.query(`
      CREATE SCHEMA daejang_meta;
      CREATE TABLE daejang_meta.schema_contract (
        component text PRIMARY KEY,
        contract_version bigint NOT NULL,
        migration_version bigint NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `)
    const migration = await readFile(
      process.env.WEB_AUTH_MIGRATION_PATH ??
        new URL(
          '../../../../../daejang-db/migrations/000008_create_web_auth_persistence.sql',
          import.meta.url,
        ),
      'utf8',
    )
    const [upMigration] = migration.split('-- +goose Down')
    if (!upMigration) {
      throw new Error('web auth migration is missing the Goose Up section')
    }
    await pool.query(upMigration)
    await memberships.upsertUser({ id: 'user-kim', displayName: '김대장' })
    await memberships.upsertWorkspace({ id: 'workspace-main', name: '김대장의 장부' })
    await memberships.setMembership({
      userId: 'user-kim',
      workspaceId: 'workspace-main',
      role: 'owner',
    })
  })

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS web_private CASCADE')
    await pool.query('DROP SCHEMA IF EXISTS daejang_meta CASCADE')
    await pool.end()
  })

  const createSession = () =>
    sessions.create({
      user: { id: 'user-kim', displayName: 'ignored-session-snapshot' },
      activeWorkspaceId: 'workspace-main',
      memberships: [
        {
          workspaceId: 'workspace-main',
          workspaceName: 'ignored-session-snapshot',
          role: 'member',
        },
      ],
    })

  it('loads identity and membership from PostgreSQL instead of the session input', async () => {
    const created = await createSession()
    const resolved = await sessions.resolve(created.token)

    expect(created.session.membershipVersion).toBe(2)
    expect(resolved).toMatchObject({
      user: { id: 'user-kim', displayName: '김대장' },
      memberships: [
        {
          workspaceId: 'workspace-main',
          workspaceName: '김대장의 장부',
          role: 'owner',
        },
      ],
    })
  })

  it('invalidates an existing session after a membership role change', async () => {
    const created = await createSession()
    await memberships.setMembership({
      userId: 'user-kim',
      workspaceId: 'workspace-main',
      role: 'member',
    })

    expect(await sessions.resolve(created.token)).toBeUndefined()
  })

  it('rotates the token in one PostgreSQL transaction', async () => {
    const created = await createSession()
    const rotated = await sessions.rotate(created.token)

    expect(rotated?.token).not.toBe(created.token)
    expect(await sessions.resolve(created.token)).toBeUndefined()
    expect(await sessions.resolve(rotated?.token ?? '')).toBeDefined()
  })

  it('shares provider rate-limit attempts through PostgreSQL', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const limiter = new AuthRateLimiter(
      new PostgresRateLimitStore(pool),
      'integration-test-secret',
      () => now,
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await limiter.consume({
            provider: 'siwe',
            phase: 'complete',
            ip: '203.0.113.10',
            identity: '0xabc',
          })
        ).allowed,
      ).toBe(true)
    }

    expect(
      (
        await limiter.consume({
          provider: 'siwe',
          phase: 'complete',
          ip: '203.0.113.10',
          identity: '0xabc',
        })
      ).allowed,
    ).toBe(false)
  })

  it('increments the session epoch when every user session is revoked', async () => {
    const first = await createSession()
    const second = await createSession()

    expect(await sessions.revokeUser('user-kim')).toBeGreaterThanOrEqual(2)
    expect(await sessions.resolve(first.token)).toBeUndefined()
    expect(await sessions.resolve(second.token)).toBeUndefined()
    expect((await createSession()).session.sessionEpoch).toBe(2)
  })

  it('allows only one atomic replacement of the same PostgreSQL session', async () => {
    const previous = await createSession()
    const input = {
      user: { id: 'user-kim', displayName: '김대장' },
      activeWorkspaceId: 'workspace-main',
      memberships: [
        {
          workspaceId: 'workspace-main',
          workspaceName: '김대장의 장부',
          role: 'member' as const,
        },
      ],
    }
    const [first, second] = await Promise.all([
      sessions.replaceAfterAuthentication(previous.token, input),
      sessions.replaceAfterAuthentication(previous.token, input),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('fails schema preflight when the membership trigger is disabled', async () => {
    await expect(assertWebAuthSchema(pool)).resolves.toBeUndefined()
    await pool.query(
      'ALTER TABLE web_private.workspace_memberships DISABLE TRIGGER workspace_membership_version_bump',
    )
    await expect(assertWebAuthSchema(pool)).rejects.toThrow('migration contract')
    await pool.query(
      'ALTER TABLE web_private.workspace_memberships ENABLE TRIGGER workspace_membership_version_bump',
    )
  })

  it('fails schema preflight when the membership trigger is replica-only', async () => {
    await pool.query(
      'ALTER TABLE web_private.workspace_memberships ENABLE REPLICA TRIGGER workspace_membership_version_bump',
    )
    await expect(assertWebAuthSchema(pool)).rejects.toThrow('migration contract')
    await pool.query(
      'ALTER TABLE web_private.workspace_memberships ENABLE TRIGGER workspace_membership_version_bump',
    )
  })
})
