import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'

import { buildApp } from './app.js'
import { MemoryAccountAuthStore } from './auth/account-auth-store.js'
import { MemorySessionStore } from './auth/session.js'
import { MemoryRateLimitStore } from './auth/rate-limit.js'
import type { AppConfig } from './config.js'
import { MemoryWalletSourceStore } from './sources/wallet-source-store.js'
import { EngineRpcError } from './engine/rpc-error.js'
import { status as grpcStatus } from '@grpc/grpc-js'
import type { EngineDataClient } from './routes/data.js'
import type { CreateUpload, UploadSession, UploadStore } from './uploads/upload-store.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'

const config: AppConfig = {
  runtimeMode: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1_024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl: undefined,
  rateLimitHmacSecret: 'test-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'test-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'test-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: false,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  engineMtls: undefined,
}

class TestDurableSessionStore extends MemorySessionStore {
  override readonly durable = true
}

class TestDurableRateLimitStore extends MemoryRateLimitStore {
  override readonly durable = true
}

class TestDurableWalletSourceStore extends MemoryWalletSourceStore {
  override readonly durable = true
}

class TestDurableAccountAuthStore extends MemoryAccountAuthStore {
  override readonly durable = true
}

describe('web api authentication boundary', () => {
  let now: Date
  let context: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    now = new Date('2027-07-20T00:00:00.000Z')
    context = await buildApp({ config, logger: false, now: () => now })
  })

  afterEach(async () => {
    await context.app.close()
  })

  const createSession = async () => {
    const session = {
      user: { id: USER_ID, displayName: '김대장' },
    } as const

    return context.sessionService.create(session)
  }

  it('serves health checks without a session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('rejects protected requests without a session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/me' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    })
  })

  it.each([
    [grpcStatus.UNAVAILABLE, 503, 'ENGINE_UNAVAILABLE'],
    [grpcStatus.DEADLINE_EXCEEDED, 504, 'ENGINE_TIMEOUT'],
  ])(
    'maps Engine RPC failure %s to an explicit upstream response',
    async (grpcCode, expectedStatus, expectedCode) => {
      await context.app.close()
      class FailingWalletSourceStore extends MemoryWalletSourceStore {
        override async listWallets(): Promise<never> {
          throw new EngineRpcError(grpcCode)
        }
      }
      context = await buildApp({
        config,
        logger: false,
        walletSourceStore: new FailingWalletSourceStore(),
        now: () => now,
      })
      const { token } = await createSession()

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/sources',
        headers: { cookie: `${config.sessionCookieName}=${token}` },
      })

      expect(response.statusCode).toBe(expectedStatus)
      expect(response.json()).toMatchObject({ error: { code: expectedCode } })
    },
  )

  it('issues a real session for the configured development test user', async () => {
    await context.app.close()
    const developmentUserStore = {
      upsertUser: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => undefined),
    }
    context = await buildApp({
      config: {
        ...config,
        runtimeMode: 'development',
        devBootstrapUser: { id: USER_ID, displayName: '김대장' },
      },
      logger: false,
      developmentUserStore,
      now: () => now,
    })

    const bootstrap = await context.app.inject({
      method: 'POST',
      url: '/api/v1/dev/session',
      headers: { origin: config.publicOrigin },
    })
    expect(bootstrap.statusCode).toBe(201)
    expect(developmentUserStore.upsertUser).toHaveBeenCalledWith({
      id: USER_ID,
      displayName: '김대장',
    })
    expect(developmentUserStore.setStatus).toHaveBeenCalledWith(USER_ID, 'active')

    const setCookie = bootstrap.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0]
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({ user: { id: USER_ID, displayName: '김대장' } })
  })

  it('returns only the identity resolved from the server session', async () => {
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        'x-user-id': '00000000-0000-4000-8000-000000000099',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      user: { id: USER_ID, displayName: '김대장' },
    })
  })

  it('does not expose a workspace API', async () => {
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/00000000-0000-4000-8000-000000000099',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ message: 'Route GET:/api/v1/workspaces/00000000-0000-4000-8000-000000000099 not found' })
  })

  it('rejects idle-expired sessions and clears their cookie', async () => {
    const { token } = await createSession()
    now = new Date(now.getTime() + config.sessionIdleTtlSeconds * 1_000)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['set-cookie']).toContain(`${config.sessionCookieName}=;`)
  })

  it('requires an exact same-origin header before logout', async () => {
    const { token } = await createSession()

    const rejected = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: 'https://attacker.example',
      },
    })
    expect(rejected.statusCode).toBe(403)

    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
    })
    expect(accepted.statusCode).toBe(204)

    const afterLogout = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(afterLogout.statusCode).toBe(401)
  })

  it('rotates the session cookie and immediately rejects the previous token', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session/rotate',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
    })

    expect(response.statusCode).toBe(204)
    const setCookie = response.headers['set-cookie']
    expect(setCookie).toContain(`${config.sessionCookieName}=`)
    expect(setCookie).not.toContain(`${config.sessionCookieName}=${token}`)

    const rejected = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(rejected.statusCode).toBe(401)
  })

  it('registers, lists, and disconnects a server-verified wallet source', async () => {
    const { token } = await createSession()
    const wallet = Wallet.createRandom()
    const request = async (
      method: 'GET' | 'POST',
      url: string,
      payload?: Record<string, unknown>,
    ) => {
      const requestOptions = {
        method,
        url,
        headers: {
          cookie: `${config.sessionCookieName}=${token}`,
          ...(method === 'POST' ? { origin: config.publicOrigin } : {}),
        },
      } as const
      return payload === undefined
        ? context.app.inject(requestOptions)
        : context.app.inject({ ...requestOptions, payload })
    }

    const challengeResponse = await request(
      'POST',
      '/api/v1/sources/wallets/challenges',
      { address: wallet.address, chainId: 'eip155:1' },
    )
    expect(challengeResponse.statusCode).toBe(201)
    const challenge = challengeResponse.json<{
      challengeId: string
      message: string
    }>()
    const signature = await wallet.signMessage(challenge.message)

    const registration = await request('POST', '/api/v1/sources/wallets', {
      challengeId: challenge.challengeId,
      signature,
      chainIds: ['eip155:1', 'eip155:8453'],
      label: '세무 지갑',
    })
    expect(registration.statusCode).toBe(201)
    const source = registration.json<{ id: string; address: string }>()
    expect(source.address).toBe(wallet.address.toLowerCase())

    const replay = await request('POST', '/api/v1/sources/wallets', {
      challengeId: challenge.challengeId,
      signature,
      chainIds: ['eip155:1'],
    })
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({
      error: { code: 'WALLET_CHALLENGE_INVALID' },
    })

    const list = await request('GET', '/api/v1/sources')
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({
      items: [
        {
          id: source.id,
          address: wallet.address.toLowerCase(),
          status: 'ACTIVE',
          chainScopes: [
            { chainId: 'eip155:1', status: 'ACTIVE' },
            { chainId: 'eip155:8453', status: 'ACTIVE' },
          ],
        },
      ],
    })

    const disconnected = await request(
      'POST',
      `/api/v1/sources/${source.id}/disconnect`,
    )
    expect(disconnected.statusCode).toBe(200)
    expect(disconnected.json()).toMatchObject({
      id: source.id,
      status: 'DISCONNECTED',
      chainScopes: [
        { chainId: 'eip155:1', status: 'DISABLED' },
        { chainId: 'eip155:8453', status: 'DISABLED' },
      ],
    })
  })

  it('rejects a signature from a different wallet', async () => {
    const { token } = await createSession()
    const expectedWallet = Wallet.createRandom()
    const attackerWallet = Wallet.createRandom()
    const challengeResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/sources/wallets/challenges',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
      payload: { address: expectedWallet.address, chainId: 'eip155:1' },
    })
    const challenge = challengeResponse.json<{
      challengeId: string
      message: string
    }>()

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/sources/wallets',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
      payload: {
        challengeId: challenge.challengeId,
        signature: await attackerWallet.signMessage(challenge.message),
        chainIds: ['eip155:1'],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'WALLET_SIGNATURE_INVALID' },
    })
  })

  it('uploads, confirms, registers, and enqueues an Upbit PDF', async () => {
    await context.app.close()
    const uploadId = '00000000-0000-4000-8000-000000000010'
    const sourceId = '00000000-0000-4000-8000-000000000011'
    const pdf = Buffer.from('%PDF-test')
    let session: UploadSession | undefined
    const uploadStore: UploadStore = {
      durable: true,
      create: vi.fn(async (input: CreateUpload) => {
        session = {
          id: uploadId, userId: input.userId, provider: 'UPBIT',
          objectKey: `upbit/${input.userId}/${uploadId}.pdf`,
          originalFilename: input.originalFilename, mediaType: 'application/pdf',
          expectedBytes: input.expectedBytes, state: 'PENDING',
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(input.now.getTime() + 60_000),
        }
        return session
      }),
      write: vi.fn(async (_userId, _uploadId, contents) => {
        if (!session || !contents.equals(pdf)) return undefined
        session = { ...session, state: 'UPLOADED' }
        return session
      }),
      confirm: vi.fn(async () => {
        if (!session) return undefined
        session = { ...session, state: 'CONFIRMED', verifiedDigest: 'a'.repeat(64), verifiedBytes: pdf.length }
        return session
      }),
    }
    const registerDocument = vi.fn(async () => ({ id: sourceId }))
    const enqueueSync = vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000012', state: 'QUEUED' }))
    const engineDataClient = {
      registerDocument, enqueueSync,
      listAllSources: vi.fn(async () => ({ wallets: [], documents: [] })),
      getSyncJob: vi.fn(async () => ({})), listSyncJobs: vi.fn(async () => []),
      getDashboard: vi.fn(async () => ({})), listLedgerEvents: vi.fn(async () => []),
      listReviews: vi.fn(async () => ({ items: [], nextPageToken: '' })), getReview: vi.fn(async () => ({})),
      resolveReview: vi.fn(async () => ({ review: {}, replayed: false })),
      createReport: vi.fn(async () => ({})),
      listReports: vi.fn(async () => []),
    } satisfies EngineDataClient
    context = await buildApp({ config, logger: false, now: () => now, uploadStore, engineDataClient })
    const { token } = await createSession()
    const headers = { cookie: `${config.sessionCookieName}=${token}`, origin: config.publicOrigin }

    const created = await context.app.inject({
      method: 'POST', url: '/api/v1/uploads', headers,
      payload: { filename: '거래내역.pdf', mediaType: 'application/pdf', sizeBytes: pdf.length, intentKey: 'upbit-test' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ uploadId })
    const written = await context.app.inject({
      method: 'PUT', url: `/api/v1/uploads/${uploadId}/content`,
      headers: { ...headers, 'content-type': 'application/pdf' }, payload: pdf,
    })
    expect(written.statusCode).toBe(204)
    const confirmed = await context.app.inject({
      method: 'POST', url: `/api/v1/uploads/${uploadId}/confirm`, headers,
      payload: { coverageStart: '2026-01-01', coverageEnd: '2026-12-31' },
    })
    expect(confirmed.statusCode).toBe(201)
    expect(registerDocument).toHaveBeenCalledWith(expect.objectContaining({ uploadId, byteLength: pdf.length }))
    expect(enqueueSync).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), 'UPBIT_PDF', sourceId)
  })

  it('does not clear the winning cookie when concurrent rotation loses', async () => {
    const { token } = await createSession()
    const request = () =>
      context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/session/rotate',
        headers: {
          cookie: `${config.sessionCookieName}=${token}`,
          origin: config.publicOrigin,
        },
      })
    const responses = await Promise.all([request(), request()])
    const success = responses.find(({ statusCode }) => statusCode === 204)
    const conflict = responses.find(({ statusCode }) => statusCode === 409)

    expect(success?.headers['set-cookie']).toContain(`${config.sessionCookieName}=`)
    expect(conflict?.headers['set-cookie']).toBeUndefined()
    expect(conflict?.json()).toMatchObject({
      error: { code: 'SESSION_ROTATION_CONFLICT' },
    })
  })

  it.each([
    ['missing Origin', undefined, undefined],
    ['null Origin', 'null', undefined],
    ['mismatched Origin', 'https://attacker.example', undefined],
    ['same-site fetch', config.publicOrigin, 'same-site'],
    ['cross-site fetch', config.publicOrigin, 'cross-site'],
    ['none fetch', config.publicOrigin, 'none'],
    ['unknown fetch', config.publicOrigin, 'unexpected'],
  ])('rejects unsafe API requests with %s', async (_label, origin, fetchSite) => {
    const headers: Record<string, string> = {}
    if (origin) {
      headers.origin = origin
    }
    if (fetchSite) {
      headers['sec-fetch-site'] = fetchSite
    }

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/unregistered',
      headers,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST_ORIGIN' } })
  })

  it.each([
    ['Origin fallback', undefined],
    ['same-origin fetch', 'same-origin'],
  ])('allows unsafe requests with exact Origin and %s', async (_label, fetchSite) => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/unregistered',
      headers: {
        origin: config.publicOrigin,
        ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
      },
    })

    expect(response.statusCode).toBe(404)
  })

  it('does not apply the unsafe-method guard to OPTIONS', async () => {
    const response = await context.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/unregistered',
    })

    expect(response.statusCode).toBe(404)
  })

  it('adds security headers to public and API error responses', async () => {
    const health = await context.app.inject({ method: 'GET', url: '/healthz' })
    const unauthorizedResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
    })
    const notFound = await context.app.inject({
      method: 'GET',
      url: '/api/v1/unregistered',
    })

    for (const response of [health, unauthorizedResponse, notFound]) {
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      )
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=()',
      )
    }

    expect(health.headers['cache-control']).toBeUndefined()
    expect(unauthorizedResponse.headers['cache-control']).toBe('no-store')
    expect(notFound.headers['cache-control']).toBe('no-store')
  })

  it('adds security and cache headers to unexpected API errors', async () => {
    context.app.get('/api/v1/test-error', async () => {
      throw new Error('test failure')
    })

    const response = await context.app.inject({ method: 'GET', url: '/api/v1/test-error' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
  })

  it('rejects oversized bodies before authentication', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: config.publicOrigin,
        'content-type': 'text/plain',
      },
      payload: 'x'.repeat(config.bodyLimitBytes + 1),
    })

    expect(response.statusCode).toBe(413)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('refuses production startup without a durable session store', async () => {
    await context.app.close()
    await expect(
      buildApp({
        config: {
          ...config,
          runtimeMode: 'production',
          secureCookies: true,
          sessionCookieName: '__Host-daejang_session',
        },
        logger: false,
      }),
    ).rejects.toThrow('durable SessionStore')

    await expect(
      buildApp({
        config: {
          ...config,
          runtimeMode: 'production',
          secureCookies: true,
          sessionCookieName: '__Host-daejang_session',
        },
        logger: false,
        sessionStore: new MemorySessionStore(),
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    ).rejects.toThrow('durable SessionStore')

    const productionContext = await buildApp({
      config: {
        ...config,
        runtimeMode: 'production',
        secureCookies: true,
        sessionCookieName: '__Host-daejang_session',
      },
      logger: false,
      sessionStore: new TestDurableSessionStore(),
      rateLimitStore: new TestDurableRateLimitStore(),
      walletSourceStore: new TestDurableWalletSourceStore(),
      accountAuthStore: new TestDurableAccountAuthStore(),
    })
    const health = await productionContext.app.inject('/healthz')
    expect(health.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
    await productionContext.app.close()

    context = await buildApp({ config, logger: false, now: () => now })
  })
})
