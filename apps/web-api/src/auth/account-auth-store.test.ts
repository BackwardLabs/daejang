import type { Pool, PoolClient, QueryResult } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { PostgresAccountAuthStore } from './account-auth-store.js'

const queryResult = <T extends Record<string, unknown>>(
  rows: T[],
): QueryResult<T> =>
  ({
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  }) as QueryResult<T>

describe('PostgresAccountAuthStore', () => {
  it('updates an active user nickname in the canonical users table', async () => {
    const query = vi.fn().mockResolvedValue(
      queryResult([
        {
          id: '00000000-0000-4000-8000-000000000001',
          display_name: '새 닉네임',
          status: 'active',
        },
      ]),
    )
    const store = new PostgresAccountAuthStore({ query } as unknown as Pool)

    await expect(
      store.updateUserDisplayName(
        '00000000-0000-4000-8000-000000000001',
        '새 닉네임',
      ),
    ).resolves.toMatchObject({ displayName: '새 닉네임', status: 'active' })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE web_private.users'),
      ['00000000-0000-4000-8000-000000000001', '새 닉네임'],
    )
  })

  it('trusts the database atomic OAuth consume result without app-clock filtering', async () => {
    const consumedAt = new Date('2027-07-20T00:00:00.001Z')
    const query = vi.fn().mockResolvedValue(
      queryResult([
        {
          id: '00000000-0000-4000-8000-000000000001',
          provider: 'naver',
          intent: 'login',
          state_hash: 'a'.repeat(43),
          nonce_hash: null,
          pkce_verifier_ciphertext: null,
          authenticated_user_id: null,
          return_path: '/dashboard',
          created_at: new Date('2027-07-19T23:59:00.000Z'),
          expires_at: new Date('2027-07-20T00:09:00.000Z'),
          consumed_at: consumedAt,
        },
      ]),
    )
    const store = new PostgresAccountAuthStore({ query } as unknown as Pool)

    await expect(
      store.consumeOAuthTransaction(
        'a'.repeat(43),
        new Date('2027-07-20T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ consumedAt })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).not.toContain('consumed_at <=')
    expect(query.mock.calls[0]?.[1]).toEqual(['a'.repeat(43)])
  })

  it('serializes direct-email creation with an advisory transaction lock and no user deletion', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(sql)
      if (sql.includes('FROM web_private.user_emails')) {
        return queryResult([])
      }
      return queryResult([])
    })
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool
    const store = new PostgresAccountAuthStore(pool)

    await expect(
      store.findOrCreatePendingDirectEmail('user@example.com'),
    ).resolves.toMatchObject({ loginEnabled: false })
    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(
      true,
    )
    expect(statements.some((sql) => /\bDELETE\b/u.test(sql))).toBe(false)
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('uses a PostgreSQL-safe advisory lock key when creating a social user', async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      return queryResult([])
    })
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool
    const store = new PostgresAccountAuthStore(pool)

    await expect(
      store.createPendingOAuthUser({
        userId: '00000000-0000-4000-8000-000000000001',
        identityId: '00000000-0000-4000-8000-000000000002',
        provider: 'google',
        providerSubject: 'provider-subject',
        verifiedAt: new Date('2027-07-20T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ status: 'pending' })

    const advisoryLock = calls.find(({ sql }) =>
      sql.includes('pg_advisory_xact_lock'),
    )
    expect(advisoryLock?.values).toEqual([
      JSON.stringify(['google', 'provider-subject']),
    ])
    expect(String(advisoryLock?.values?.[0])).not.toContain('\0')
    expect(
      calls.some(({ sql }) => sql.includes('FOR UPDATE OF identity_record')),
    ).toBe(false)
    expect(calls.at(-1)?.sql).toBe('COMMIT')
  })

  it('lets PostgreSQL assign the immutable consent occurrence time', async () => {
    const documentId = '00000000-0000-4000-8000-000000000010'
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM web_private.legal_documents')) {
        return queryResult([
          {
            id: documentId,
            document_type: 'terms',
          },
        ])
      }
      return queryResult([])
    })
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool
    const store = new PostgresAccountAuthStore(pool)

    await store.recordSignupConsents({
      userId: '00000000-0000-4000-8000-000000000011',
      locale: 'ko-KR',
      applicableDocumentTypes: ['terms'],
      requiredDocumentTypes: ['terms'],
      decisions: [
        {
          id: '00000000-0000-4000-8000-000000000012',
          legalDocumentId: documentId,
          action: 'accepted',
        },
      ],
      now: new Date('2027-07-20T00:00:00.000Z'),
    })

    const consentInsert = calls.find(({ sql }) =>
      sql.includes('INSERT INTO web_private.user_consents'),
    )
    expect(consentInsert?.sql).not.toContain('occurred_at')
    expect(consentInsert?.values).toEqual([
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000011',
      documentId,
      'accepted',
    ])
    expect(calls.at(-1)?.sql).toBe('COMMIT')
  })
})
