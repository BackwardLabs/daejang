import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { assertWebAuthSchema } from '../database/preflight.js'
import { AuthRateLimiter, PostgresRateLimitStore } from './rate-limit.js'
import { PostgresSessionStore } from './postgres-session-store.js'
import { PostgresUserStore } from './postgres-user-store.js'
import { SessionService } from './session.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithPostgres = databaseUrl ? describe : describe.skip

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002'
const IDENTITY_ID = '00000000-0000-4000-8000-000000000101'
const LEGAL_DOCUMENT_ID = '00000000-0000-4000-8000-000000000201'
const ACCEPT_CONSENT_ID = '00000000-0000-4000-8000-000000000301'
const WITHDRAW_CONSENT_ID = '00000000-0000-4000-8000-000000000302'
const CONTENT_HASH = 'a'.repeat(64)
const CONSENT_AS_OF = new Date('2027-07-20T00:00:00.000Z')

describeWithPostgres('PostgreSQL Web authentication persistence', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const users = new PostgresUserStore(pool)
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

    for (const filename of [
      '000008_create_web_auth_persistence.sql',
      '000009_create_single_user_auth_model.sql',
    ]) {
      const migrationUrl = process.env.WEB_AUTH_MIGRATION_DIRECTORY
        ? pathToFileURL(resolve(process.env.WEB_AUTH_MIGRATION_DIRECTORY, filename))
        : new URL(`../../../../../daejang-db/migrations/${filename}`, import.meta.url)
      const migration = await readFile(migrationUrl, 'utf8')
      const [upMigration] = migration.split('-- +goose Down')
      if (!upMigration) {
        throw new Error(`${filename} is missing the Goose Up section`)
      }
      await pool.query(upMigration)
    }

    await users.upsertUser({ id: USER_ID, displayName: '김대장' })
    await users.setStatus(USER_ID, 'active')
    await users.upsertUser({ id: OTHER_USER_ID, displayName: '다른 사용자' })
    await pool.query(
      `
        INSERT INTO web_private.legal_documents (
          id,
          document_type,
          locale,
          version,
          content_hash,
          effective_at
        ) VALUES ($1, 'privacy', 'ko-KR', '2027-01', $2, '2027-01-01T00:00:00.000Z')
      `,
      [LEGAL_DOCUMENT_ID, CONTENT_HASH],
    )
  })

  beforeEach(async () => {
    await users.setStatus(USER_ID, 'active')
    await pool.query('DELETE FROM web_private.sessions')
  })

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS web_private CASCADE')
    await pool.query('DROP SCHEMA IF EXISTS daejang_meta CASCADE')
    await pool.end()
  })

  const createSession = () =>
    sessions.create({
      user: { id: USER_ID, displayName: 'ignored-session-snapshot' },
    })

  it('loads the active canonical user from PostgreSQL instead of the session input', async () => {
    const created = await createSession()
    const resolved = await sessions.resolve(created.token)

    expect(resolved).toMatchObject({
      user: { id: USER_ID, displayName: '김대장' },
      sessionEpoch: expect.any(Number),
    })
  })

  it('does not create a session for a pending user', async () => {
    await expect(
      sessions.create({ user: { id: OTHER_USER_ID, displayName: 'ignored' } }),
    ).rejects.toThrow('Active session user does not exist')
  })

  it('invalidates sessions when the user is suspended', async () => {
    const created = await createSession()
    await users.setStatus(USER_ID, 'suspended')

    expect(await sessions.resolve(created.token)).toBeUndefined()
  })

  it('maps a provider subject to exactly one canonical user', async () => {
    const linked = await users.linkIdentity({
      id: IDENTITY_ID,
      userId: USER_ID,
      provider: 'oidc',
      providerSubject: 'provider-user-123',
      verifiedAt: new Date('2027-07-20T00:00:00.000Z'),
    })

    expect(linked.userId).toBe(USER_ID)
    expect(await users.findUserByIdentity('oidc', 'provider-user-123')).toMatchObject({
      id: USER_ID,
    })
    await expect(
      users.linkIdentity({
        id: '00000000-0000-4000-8000-000000000102',
        userId: OTHER_USER_ID,
        provider: 'oidc',
        providerSubject: 'provider-user-123',
        verifiedAt: new Date('2027-07-20T00:00:00.000Z'),
      }),
    ).rejects.toThrow('already linked to another user')
  })

  it('records version-specific consent as append-only history', async () => {
    expect(
      await users.getCurrentConsent(
        '00000000-0000-4000-8000-000000000099',
        'privacy',
        'ko-KR',
        CONSENT_AS_OF,
      ),
    ).toBeUndefined()

    const before = await users.getCurrentConsent(
      USER_ID,
      'privacy',
      'ko-KR',
      CONSENT_AS_OF,
    )
    expect(before).toMatchObject({ action: undefined })

    await users.recordConsent({
      id: ACCEPT_CONSENT_ID,
      userId: USER_ID,
      legalDocumentId: LEGAL_DOCUMENT_ID,
      action: 'accepted',
    })
    expect(
      await users.getCurrentConsent(USER_ID, 'privacy', 'ko-KR', CONSENT_AS_OF),
    ).toMatchObject({ action: 'accepted' })

    await users.recordConsent({
      id: WITHDRAW_CONSENT_ID,
      userId: USER_ID,
      legalDocumentId: LEGAL_DOCUMENT_ID,
      action: 'withdrawn',
    })
    expect(
      await users.getCurrentConsent(USER_ID, 'privacy', 'ko-KR', CONSENT_AS_OF),
    ).toMatchObject({ action: 'withdrawn' })

    await expect(
      pool.query(
        'UPDATE web_private.user_consents SET action = $1 WHERE id = $2',
        ['accepted', WITHDRAW_CONSENT_ID],
      ),
    ).rejects.toThrow('append-only')
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
    const epoch = first.session.sessionEpoch

    expect(await sessions.revokeUser(USER_ID)).toBe(2)
    expect(await sessions.resolve(first.token)).toBeUndefined()
    expect(await sessions.resolve(second.token)).toBeUndefined()
    expect((await createSession()).session.sessionEpoch).toBe(epoch + 1)
  })

  it('allows only one atomic replacement of the same PostgreSQL session', async () => {
    const previous = await createSession()
    const input = { user: { id: USER_ID, displayName: '김대장' } }
    const [first, second] = await Promise.all([
      sessions.replaceAfterAuthentication(previous.token, input),
      sessions.replaceAfterAuthentication(previous.token, input),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('fails schema preflight when an append-only guard is disabled', async () => {
    await expect(assertWebAuthSchema(pool)).resolves.toBeUndefined()
    await pool.query(
      'ALTER TABLE web_private.user_consents DISABLE TRIGGER user_consents_append_only',
    )
    await expect(assertWebAuthSchema(pool)).rejects.toThrow('migration contract')
    await pool.query(
      'ALTER TABLE web_private.user_consents ENABLE TRIGGER user_consents_append_only',
    )
  })
})
