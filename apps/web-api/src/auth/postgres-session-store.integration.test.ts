import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { assertWebAuthSchema } from '../database/preflight.js'
import { PostgresAccountAuthStore } from './account-auth-store.js'
import { AuthRateLimiter, PostgresRateLimitStore } from './rate-limit.js'
import { PostgresSessionStore } from './postgres-session-store.js'
import { PostgresUserStore } from './postgres-user-store.js'
import { SessionService } from './session.js'
import { PostgresWalletSourceStore } from '../sources/postgres-wallet-source-store.js'
import { MemoryWalletSourceStore } from '../sources/wallet-source-store.js'

const validateDisposableTestDatabaseUrl = (value: string | undefined) => {
  if (!value) {
    return undefined
  }
  const url = new URL(value)
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  const databaseName = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    !databaseName.toLocaleLowerCase('en-US').includes('test')
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback-only disposable database whose name contains "test"',
    )
  }
  return value
}

const databaseUrl = validateDisposableTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
)
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
  const accounts = new PostgresAccountAuthStore(pool)
  const users = new PostgresUserStore(pool)
  const sessions = new SessionService(new PostgresSessionStore(pool), 3_600, 600)
  const walletSources = new PostgresWalletSourceStore(
    pool,
    new MemoryWalletSourceStore(),
  )

  const resetSchemas = () =>
    pool.query(`
      DROP SCHEMA IF EXISTS
        activation,
        artifact,
        chain_evidence,
        daejang_meta,
        jit_ops,
        ledger,
        lot,
        reporting,
        review,
        selection_private,
        source_private,
        subject_evidence,
        web_private
      CASCADE
    `)

  beforeAll(async () => {
    await resetSchemas()
    for (const filename of [
      '000001_create_giwa48_jit_persistence.sql',
      '000002_add_execution_cache_and_outbox_leases.sql',
      '000003_create_observation_projection.sql',
      '000004_complete_evidence_persistence.sql',
      '000005_create_ledger_lot_persistence.sql',
      '000006_add_execution_provenance_projection.sql',
      '000007_create_review_persistence.sql',
      '000008_create_web_auth_persistence.sql',
      '000009_create_wallet_source_persistence.sql',
      '000010_create_action_activation_persistence.sql',
      '000011_create_wallet_ownership_challenges.sql',
      '000012_move_wallet_sources_behind_engine.sql',
      '000013_create_source_jobs_and_reports.sql',
      '000014_grant_query_runtime_access.sql',
      '000015_create_web_oauth_email_persistence.sql',
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
    await pool.query('DELETE FROM web_private.wallet_ownership_challenges')
    await pool.query('DELETE FROM web_private.upload_sessions')
    await pool.query('DELETE FROM web_private.sessions')
  })

  afterAll(async () => {
    await resetSchemas()
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

  it('consumes a wallet challenge once and preserves disconnected sources', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const challenge = {
      id: '00000000-0000-4000-8000-000000000401',
      userId: USER_ID,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      verificationChainId: 'eip155:1',
      message: 'Daejang wallet integration challenge',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      consumedAt: undefined,
    } as const
    await walletSources.createChallenge(challenge)

    const registered = await walletSources.completeRegistration({
      challengeId: challenge.id,
      userId: USER_ID,
      recoveredAddress: challenge.address,
      verificationChainId: challenge.verificationChainId,
      chainIds: ['eip155:1', 'eip155:8453'],
      label: '통합 테스트 지갑',
      now,
      requestId: 'wallet-register-request',
      sessionId: 'wallet-register-session',
      idempotencyKey: challenge.id,
    })
    expect(registered).toMatchObject({
      address: challenge.address,
      status: 'ACTIVE',
      chainScopes: [
        { chainId: 'eip155:1', status: 'ACTIVE' },
        { chainId: 'eip155:8453', status: 'ACTIVE' },
      ],
    })
    await expect(
      walletSources.completeRegistration({
        challengeId: challenge.id,
        userId: USER_ID,
        recoveredAddress: challenge.address,
        verificationChainId: challenge.verificationChainId,
        chainIds: ['eip155:1'],
        label: undefined,
        now,
        requestId: 'wallet-register-replay',
        sessionId: 'wallet-register-session',
        idempotencyKey: challenge.id,
      }),
    ).resolves.toBeUndefined()

    const disconnected = await walletSources.disconnectWallet(
      {
        requestId: 'wallet-disconnect-request',
        userId: USER_ID,
        sessionId: 'wallet-register-session',
        idempotencyKey: `disconnect:${registered?.id ?? ''}`,
      },
      registered?.id ?? '',
      new Date(now.getTime() + 1_000),
    )
    expect(disconnected).toMatchObject({
      status: 'DISCONNECTED',
      chainScopes: [
        { chainId: 'eip155:1', status: 'DISABLED' },
        { chainId: 'eip155:8453', status: 'DISABLED' },
      ],
    })
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

  it('invalidates an old PostgreSQL token while allowing verified concurrent replacements', async () => {
    const previous = await createSession()
    const input = { user: { id: USER_ID, displayName: '김대장' } }
    const [first, second] = await Promise.all([
      sessions.replaceAfterAuthentication(previous.token, input),
      sessions.replaceAfterAuthentication(previous.token, input),
    ])

    expect(first?.session.user.id).toBe(USER_ID)
    expect(second?.session.user.id).toBe(USER_ID)
    expect(await sessions.resolve(previous.token)).toBeUndefined()
  })

  it('does not block PostgreSQL login replacement for a stale presented token', async () => {
    const replacement = await sessions.replaceAfterAuthentication('stale-token', {
      user: { id: USER_ID, displayName: '김대장' },
    })

    expect(replacement?.session.user.id).toBe(USER_ID)
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

  it('consumes an OAuth transaction exactly once in PostgreSQL', async () => {
    const stateHash = 'o'.repeat(43)
    await accounts.createOAuthTransaction({
      id: '00000000-0000-4000-8000-000000000401',
      provider: 'naver',
      intent: 'login',
      stateHash,
      nonceHash: undefined,
      pkceVerifierCiphertext: undefined,
      authenticatedUserId: undefined,
      returnPath: '/dashboard',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: undefined,
    })

    await expect(
      accounts.consumeOAuthTransaction(stateHash, new Date()),
    ).resolves.toMatchObject({ stateHash, consumedAt: expect.any(Date) })
    await expect(
      accounts.consumeOAuthTransaction(stateHash, new Date()),
    ).resolves.toBeUndefined()
  })

  it('serializes pending direct-email creation and persists a verified credential', async () => {
    const email = 'postgres-auth-test@example.com'
    const [first, second] = await Promise.all([
      accounts.findOrCreatePendingDirectEmail(email),
      accounts.findOrCreatePendingDirectEmail(email),
    ])
    expect(first.userEmailId).toBe(second.userEmailId)
    expect(first.user.id).toBe(second.user.id)

    const now = new Date()
    const challengeId = '00000000-0000-4000-8000-000000000402'
    const codeDigest = 'c'.repeat(43)
    await accounts.createEmailChallenge({
      id: challengeId,
      userEmailId: first.userEmailId,
      email,
      purpose: 'signup',
      codeDigest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      resendAfter: new Date(now.getTime() + 60_000),
      attempts: 0,
      maxAttempts: 5,
      consumedAt: undefined,
    })
    await expect(
      accounts.verifyEmailChallenge({
        email,
        purpose: 'signup',
        codeDigest,
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({ consumedAt: expect.any(Date) })

    await expect(
      accounts.createEmailCredential({
        challengeId,
        email,
        passwordHash:
          '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-password-hash-value',
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ id: first.user.id, status: 'pending' })
    await expect(accounts.findEmailCredential(email)).resolves.toMatchObject({
      user: { id: first.user.id },
      passwordHash: expect.stringContaining('$argon2id$'),
    })
  })

  it('abandons an undelivered PostgreSQL email challenge at the retry boundary', async () => {
    const email = 'postgres-abandoned-auth-test@example.com'
    const pending = await accounts.findOrCreatePendingDirectEmail(email)
    const now = new Date('2027-07-20T00:00:00.000Z')
    const challengeId = '00000000-0000-4000-8000-000000000403'
    await accounts.createEmailChallenge({
      id: challengeId,
      userEmailId: pending.userEmailId,
      email,
      purpose: 'signup',
      codeDigest: 'd'.repeat(43),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      resendAfter: new Date(now.getTime() + 60_000),
      attempts: 0,
      maxAttempts: 5,
      consumedAt: undefined,
    })

    await expect(
      accounts.abandonEmailChallenge({ challengeId, now }),
    ).resolves.toBe(true)
    await expect(
      accounts.getEligibleEmailChallenge(email, 'signup', now),
    ).resolves.toBeUndefined()
    await expect(
      accounts.verifyEmailChallenge({
        email,
        purpose: 'signup',
        codeDigest: 'd'.repeat(43),
        now,
      }),
    ).resolves.toBeUndefined()
  })

  it('activates signup only after accepting every current legal document version', async () => {
    const userId = '00000000-0000-4000-8000-000000000501'
    const signupTokenHash = 's'.repeat(43)
    const asOf = new Date('2027-07-20T00:00:00.000Z')
    await users.upsertUser({ id: userId, displayName: '가입 완료 테스트' })
    await accounts.createSignupSession({
      id: '00000000-0000-4000-8000-000000000502',
      tokenHash: signupTokenHash,
      userId,
      createdAt: new Date('2027-07-19T23:00:00.000Z'),
      expiresAt: new Date('2027-07-20T01:00:00.000Z'),
    })

    const insertDocument = async (
      id: string,
      documentType: 'terms' | 'privacy' | 'identity_verification',
      version: string,
      content: string,
      effectiveAt: Date,
    ) => {
      const contentHash = createHash('sha256').update(content).digest('hex')
      await pool.query(
        `
          INSERT INTO web_private.legal_documents (
            id,
            document_type,
            locale,
            version,
            content_hash,
            effective_at
          ) VALUES ($1, $2, 'ko-KR', $3, $4, $5)
        `,
        [id, documentType, version, contentHash, effectiveAt],
      )
      await pool.query(
        `
          INSERT INTO web_private.legal_document_contents (
            legal_document_id,
            content
          ) VALUES ($1, $2)
        `,
        [id, content],
      )
    }

    const initialDocuments = [
      [
        '00000000-0000-4000-8000-000000000511',
        'terms',
        '2027-07-a',
      ],
      [
        '00000000-0000-4000-8000-000000000512',
        'privacy',
        '2027-07-a',
      ],
      [
        '00000000-0000-4000-8000-000000000513',
        'identity_verification',
        '2027-07-a',
      ],
    ] as const
    for (const [id, documentType, version] of initialDocuments) {
      await insertDocument(
        id,
        documentType,
        version,
        `${documentType} ${version}`,
        new Date('2027-07-01T00:00:00.000Z'),
      )
    }
    await accounts.recordSignupConsents({
      userId,
      locale: 'ko-KR',
      decisions: initialDocuments.map(([legalDocumentId], index) => ({
        id: `00000000-0000-4000-8000-00000000052${index}`,
        legalDocumentId,
        action: 'accepted',
      })),
      now: asOf,
    })

    const currentTermsId = '00000000-0000-4000-8000-000000000514'
    await insertDocument(
      currentTermsId,
      'terms',
      '2027-07-b',
      'terms 2027-07-b',
      new Date('2027-07-19T00:00:00.000Z'),
    )
    await expect(
      accounts.completeSignup({ userId, signupTokenHash, now: asOf }),
    ).rejects.toThrow('Required legal documents were not accepted')

    await accounts.recordSignupConsents({
      userId,
      locale: 'ko-KR',
      decisions: [
        currentTermsId,
        initialDocuments[1][0],
        initialDocuments[2][0],
      ].map((legalDocumentId, index) => ({
        id: `00000000-0000-4000-8000-00000000053${index}`,
        legalDocumentId,
        action: 'accepted',
      })),
      now: asOf,
    })
    await expect(
      accounts.completeSignup({ userId, signupTokenHash, now: asOf }),
    ).resolves.toMatchObject({ id: userId, status: 'active' })
    await expect(
      accounts.completeSignup({ userId, signupTokenHash, now: asOf }),
    ).resolves.toBeUndefined()
  })
})
