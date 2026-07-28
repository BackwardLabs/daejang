import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import { assertWebAuthSchema } from '../database/preflight.js'
import { PostgresAccountAuthStore } from './account-auth-store.js'
import type {
  NormalizedOAuthIdentity,
  OAuthProviderAdapter,
} from './oauth.js'
import { AuthRateLimiter, PostgresRateLimitStore } from './rate-limit.js'
import { PostgresSessionStore } from './postgres-session-store.js'
import { PostgresUserStore } from './postgres-user-store.js'
import {
  provisionEmailAccount,
  type ProvisionEmailAccountInput,
} from './provision-email-account.js'
import { SessionService } from './session.js'
import { PostgresWalletSourceStore } from '../sources/postgres-wallet-source-store.js'
import { MemoryWalletSourceStore } from '../sources/wallet-source-store.js'
import { PostgresFileUploadStore } from '../uploads/postgres-file-upload-store.js'

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
const PROVISIONED_USER_ID = '00000000-0000-4000-8000-00000000a001'

const postgresAuthConfig: AppConfig = {
  runtimeMode: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1_048_576,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl,
  rateLimitHmacSecret: 'postgres-e2e-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(['naver']),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'postgres-e2e-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 2),
    providers: {
      naver: {
        clientId: 'postgres-e2e-client-id',
        clientSecret: 'postgres-e2e-client-secret',
      },
    },
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'postgres-e2e-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: true,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: ['naver'] },
  },
  identityVerificationMode: 'disabled',
  engineMtls: undefined,
}

class PostgresE2eNaverAdapter implements OAuthProviderAdapter {
  readonly provider = 'naver' as const

  constructor(
    private readonly email = 'postgres-oauth-e2e@example.com',
  ) {}

  buildAuthorizationUrl(
    input: Parameters<OAuthProviderAdapter['buildAuthorizationUrl']>[0],
  ) {
    const url = new URL('https://provider.example/authorize')
    url.searchParams.set('state', input.state)
    return url
  }

  async exchangeCode(
    input: Parameters<OAuthProviderAdapter['exchangeCode']>[0],
  ): Promise<NormalizedOAuthIdentity> {
    return {
      provider: 'naver',
      providerSubject: input.code,
      email: this.email,
      emailVerified: true,
    }
  }
}

const responseCookie = (
  header: string | string[] | undefined,
  name: string,
) => {
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  return cookies
    .map((value) => value.split(';', 1)[0])
    .find((value) => value?.startsWith(`${name}=`))
}

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

  it('runs the abandoned-upload cleanup query against PostgreSQL', async () => {
    const uploads = new PostgresFileUploadStore(
      pool,
      '/private/tmp/daejang-unused-integration-objects',
    )

    await expect(uploads.cleanupAbandoned(new Date())).resolves.toEqual({
      examined: 0,
      removed: 0,
      missing: 0,
      retryPending: 0,
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

  it('persists OAuth signup, login, and session resolution across app restarts', async () => {
    const buildPostgresApp = () =>
      buildApp({
        config: postgresAuthConfig,
        logger: false,
        accountAuthStore: accounts,
        sessionStore: new PostgresSessionStore(pool),
        rateLimitStore: new PostgresRateLimitStore(pool),
        oauthAdapters: [new PostgresE2eNaverAdapter()],
      })
    const startOAuth = async (
      context: Awaited<ReturnType<typeof buildApp>>,
      intent: 'signup' | 'login',
    ) => {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/naver/start?intent=${intent}&return_to=%2Fdashboard`,
      })
      expect(response.statusCode).toBe(302)
      const state = new URL(response.headers.location as string).searchParams.get(
        'state',
      )
      const cookie = responseCookie(
        response.headers['set-cookie'],
        'daejang_oauth',
      )
      expect(state).toBeTruthy()
      expect(cookie).toBeTruthy()
      return { state: state as string, cookie: cookie as string }
    }

    let context = await buildPostgresApp()
    const signupStart = await startOAuth(context, 'signup')
    const signup = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=postgres-restart-subject&state=${signupStart.state}`,
      headers: { cookie: signupStart.cookie },
    })
    expect(signup.statusCode).toBe(302)
    expect(signup.headers.location).toBe('/?onboarding=terms')

    const persistedAccount = await pool.query<{
      user_id: string
      status: string
      normalized_email: string
    }>(
      `
        SELECT
          identity_record.user_id,
          user_record.status,
          user_email.normalized_email
        FROM web_private.auth_identities identity_record
        JOIN web_private.users user_record
          ON user_record.id = identity_record.user_id
        JOIN web_private.user_emails user_email
          ON user_email.auth_identity_id = identity_record.id
        WHERE identity_record.provider = 'naver'
          AND identity_record.provider_subject = 'postgres-restart-subject'
      `,
    )
    expect(persistedAccount.rows).toEqual([
      {
        user_id: expect.any(String),
        status: 'pending',
        normalized_email: 'postgres-oauth-e2e@example.com',
      },
    ])
    const userId = persistedAccount.rows[0]?.user_id as string
    await users.setStatus(userId, 'active')
    await context.app.close()

    context = await buildPostgresApp()
    const loginStart = await startOAuth(context, 'login')
    const login = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=postgres-restart-subject&state=${loginStart.state}`,
      headers: { cookie: loginStart.cookie },
    })
    expect(login.statusCode).toBe(302)
    expect(login.headers.location).toBe('/dashboard')
    const sessionCookie = responseCookie(
      login.headers['set-cookie'],
      'daejang_session',
    )
    expect(sessionCookie).toBeTruthy()
    await expect(
      pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM web_private.sessions WHERE user_id = $1',
        [userId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] })
    await context.app.close()

    context = await buildPostgresApp()
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessionCookie as string },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ user: { id: userId } })
    await context.app.close()
  })

  it('creates a one-shot provisioned account and rejects reprovisioning', async () => {
    const provisionedAccount = {
      id: PROVISIONED_USER_ID,
      displayName: 'Provisioned User',
      email: 'provisioned-user@example.com',
      password: 'ProductionAccount1234!',
    } satisfies ProvisionEmailAccountInput
    const buildProvisionedAccountApp = () =>
      buildApp({
        config: postgresAuthConfig,
        logger: false,
        accountAuthStore: accounts,
        sessionStore: new PostgresSessionStore(pool),
        rateLimitStore: new PostgresRateLimitStore(pool),
        oauthAdapters: [new PostgresE2eNaverAdapter()],
      })

    await provisionEmailAccount(pool, provisionedAccount)
    let context = await buildProvisionedAccountApp()
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: { origin: postgresAuthConfig.publicOrigin },
      payload: {
        email: provisionedAccount.email,
        password: provisionedAccount.password,
        returnTo: '/dashboard',
      },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json()).toEqual({
      status: 'authenticated',
      nextPath: '/dashboard',
      user: {
        id: expect.any(String),
        displayName: provisionedAccount.displayName,
      },
    })
    const sessionCookie = responseCookie(
      login.headers['set-cookie'],
      postgresAuthConfig.sessionCookieName,
    )
    expect(sessionCookie).toBeTruthy()
    await expect(
      pool.query<{
        id: string
        display_name: string
        status: string
        normalized_email: string
        password_algorithm: string
        session_count: string
      }>(
        `
          SELECT
            user_record.id,
            user_record.display_name,
            user_record.status,
            user_email.normalized_email,
            credential.password_algorithm,
            count(session_record.id)::text AS session_count
          FROM web_private.users user_record
          JOIN web_private.user_emails user_email
            ON user_email.user_id = user_record.id
           AND user_email.login_enabled
          JOIN web_private.email_credentials credential
            ON credential.user_email_id = user_email.id
          LEFT JOIN web_private.sessions session_record
            ON session_record.user_id = user_record.id
          WHERE user_record.id = $1
          GROUP BY
            user_record.id,
            user_email.normalized_email,
            credential.password_algorithm
        `,
        [PROVISIONED_USER_ID],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: PROVISIONED_USER_ID,
          display_name: 'Provisioned User',
          status: 'active',
          normalized_email: provisionedAccount.email,
          password_algorithm: 'argon2id',
          session_count: '1',
        },
      ],
    })
    await context.app.close()

    const rotatedPassword = 'RotatedProductionAccount5678!'
    await expect(
      provisionEmailAccount(pool, {
        ...provisionedAccount,
        password: rotatedPassword,
      }),
    ).rejects.toBeTruthy()
    context = await buildProvisionedAccountApp()
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessionCookie as string },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({
      user: { id: PROVISIONED_USER_ID, displayName: 'Provisioned User' },
    })
    await context.app.close()
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
      pool.query(
        `
          SELECT attempts, max_attempts, expires_at, resend_after, consumed_at
          FROM web_private.email_verification_challenges
          WHERE id = $1
        `,
        [challengeId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          attempts: 5,
          max_attempts: 5,
          expires_at: new Date(now.getTime() + 300_000),
          resend_after: new Date(now.getTime() + 60_000),
          consumed_at: null,
        },
      ],
    })
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

  it('activates an identity-disabled signup with terms and privacy consent only', async () => {
    const documents = [
      {
        id: '00000000-0000-4000-8000-000000000611',
        documentType: 'terms',
        content: 'terms without identity verification',
      },
      {
        id: '00000000-0000-4000-8000-000000000612',
        documentType: 'privacy',
        content: 'privacy without identity verification',
      },
      {
        id: '00000000-0000-4000-8000-000000000613',
        documentType: 'identity_verification',
        content: 'identity verification is not applicable',
      },
    ] as const
    for (const document of documents) {
      const contentHash = createHash('sha256')
        .update(document.content)
        .digest('hex')
      await pool.query(
        `
          INSERT INTO web_private.legal_documents (
            id,
            document_type,
            locale,
            version,
            content_hash,
            effective_at
          ) VALUES ($1, $2, 'ko-KR', 'identity-disabled', $3, '2000-01-01T00:00:00.000Z')
        `,
        [document.id, document.documentType, contentHash],
      )
      await pool.query(
        `
          INSERT INTO web_private.legal_document_contents (
            legal_document_id,
            content
          ) VALUES ($1, $2)
        `,
        [document.id, document.content],
      )
    }

    const identityDisabledConfig: AppConfig = {
      ...postgresAuthConfig,
      signup: {
        ...postgresAuthConfig.signup,
        identityVerificationRequired: false,
      },
      identityVerificationMode: 'disabled',
    }
    const context = await buildApp({
      config: identityDisabledConfig,
      logger: false,
      accountAuthStore: accounts,
      sessionStore: new PostgresSessionStore(pool),
      rateLimitStore: new PostgresRateLimitStore(pool),
      oauthAdapters: [
        new PostgresE2eNaverAdapter('postgres-no-identity@example.com'),
      ],
    })

    try {
      const start = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/oauth/naver/start?intent=signup',
      })
      const state = new URL(start.headers.location as string).searchParams.get(
        'state',
      )
      const oauthCookie = responseCookie(
        start.headers['set-cookie'],
        'daejang_oauth',
      )
      expect(state).toBeTruthy()
      expect(oauthCookie).toBeTruthy()

      const callback = await context.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/naver/callback?code=postgres-no-identity-subject&state=${state}`,
        headers: { cookie: oauthCookie as string },
      })
      expect(callback.statusCode).toBe(302)
      expect(callback.headers.location).toBe('/?onboarding=terms')
      const signupCookie = responseCookie(
        callback.headers['set-cookie'],
        identityDisabledConfig.signupSessionCookieName,
      )
      expect(signupCookie).toBeTruthy()

      const currentDocuments = await context.app.inject({
        method: 'GET',
        url: '/api/v1/legal-documents/current?locale=ko-KR',
      })
      expect(currentDocuments.statusCode).toBe(200)
      const applicableDocuments = currentDocuments.json<{
        documents: Array<{
          id: string
          documentType: string
          required: boolean
        }>
      }>().documents
      expect(
        applicableDocuments.map(({ documentType, required }) => ({
          documentType,
          required,
        })),
      ).toEqual([
        { documentType: 'privacy', required: true },
        { documentType: 'terms', required: true },
      ])

      const consent = await context.app.inject({
        method: 'POST',
        url: '/api/v1/signup/consents',
        headers: {
          origin: identityDisabledConfig.publicOrigin,
          cookie: signupCookie as string,
        },
        payload: {
          locale: 'ko-KR',
          decisions: applicableDocuments.map((document) => ({
            legalDocumentId: document.id,
            action: 'accepted',
          })),
        },
      })
      expect(consent.statusCode).toBe(200)
      expect(consent.json()).toMatchObject({
        status: 'authenticated',
        nextPath: '/dashboard',
      })
      expect(
        responseCookie(
          consent.headers['set-cookie'],
          identityDisabledConfig.sessionCookieName,
        ),
      ).toBeTruthy()

      const persistedUser = await pool.query<{
        user_id: string
        status: string
      }>(
        `
          SELECT identity_record.user_id, user_record.status
          FROM web_private.auth_identities identity_record
          JOIN web_private.users user_record
            ON user_record.id = identity_record.user_id
          WHERE identity_record.provider = 'naver'
            AND identity_record.provider_subject = 'postgres-no-identity-subject'
        `,
      )
      expect(persistedUser.rows).toEqual([
        { user_id: expect.any(String), status: 'active' },
      ])
      const userId = persistedUser.rows[0]?.user_id as string
      await expect(
        pool.query<{ document_type: string }>(
          `
            SELECT document.document_type::text AS document_type
            FROM web_private.user_consents consent_record
            JOIN web_private.legal_documents document
              ON document.id = consent_record.legal_document_id
            WHERE consent_record.user_id = $1
            ORDER BY document.document_type
          `,
          [userId],
        ),
      ).resolves.toMatchObject({
        rows: [{ document_type: 'privacy' }, { document_type: 'terms' }],
      })
    } finally {
      await context.app.close()
    }
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
      applicableDocumentTypes: ['terms', 'privacy', 'identity_verification'],
      requiredDocumentTypes: ['terms', 'privacy', 'identity_verification'],
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
      accounts.completeSignup({
        userId,
        signupTokenHash,
        now: asOf,
        requiredDocumentTypes: ['terms', 'privacy', 'identity_verification'],
      }),
    ).rejects.toThrow('Required legal documents were not accepted')

    await accounts.recordSignupConsents({
      userId,
      locale: 'ko-KR',
      applicableDocumentTypes: ['terms', 'privacy', 'identity_verification'],
      requiredDocumentTypes: ['terms', 'privacy', 'identity_verification'],
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
      accounts.completeSignup({
        userId,
        signupTokenHash,
        now: asOf,
        requiredDocumentTypes: ['terms', 'privacy', 'identity_verification'],
      }),
    ).resolves.toMatchObject({ id: userId, status: 'active' })
    await expect(
      accounts.completeSignup({
        userId,
        signupTokenHash,
        now: asOf,
        requiredDocumentTypes: ['terms', 'privacy', 'identity_verification'],
      }),
    ).resolves.toBeUndefined()
  })
})
