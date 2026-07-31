import { Readable } from 'node:stream'

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
import type { TaxReportReader } from './tax-report/types.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'

const config: AppConfig = {
  runtimeMode: 'test',
  reportsUiMode: 'product',
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
  upbitPdfImportEnabled: true,
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

class TestDurableTaxReportReader implements TaxReportReader {
  readonly durable = true
  async getCurrent() {
    return undefined
  }
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
      user: {
        id: USER_ID,
        displayName: '김대장',
        email: 'account@example.com',
      },
      verifiedSubjectName: {
        normalizedValue: '김대장',
      },
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

  it('rejects an unauthenticated PDF upload before consuming or storing its body', async () => {
    await context.app.close()
    let bodyRead = false
    const payload = new Readable({
      read() {
        bodyRead = true
        this.push(Buffer.alloc(20 * 1024 * 1024))
        this.push(null)
      },
    })
    const uploadStore: UploadStore = {
      durable: true,
      create: vi.fn(async () => {
        throw new Error('upload store must not be reached')
      }),
      write: vi.fn(async () => {
        throw new Error('upload store must not be reached')
      }),
      confirm: vi.fn(async () => {
        throw new Error('upload store must not be reached')
      }),
      discard: vi.fn(async () => {
        throw new Error('upload store must not be reached')
      }),
      cleanupAbandoned: vi.fn(async () => ({
        examined: 0, removed: 0, missing: 0, retryPending: 0,
      })),
    }
    context = await buildApp({
      config,
      logger: false,
      uploadStore,
      now: () => now,
    })

    const response = await context.app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/00000000-0000-4000-8000-000000000010/content',
      headers: {
        origin: config.publicOrigin,
        'content-type': 'application/pdf',
        'content-length': String(20 * 1024 * 1024),
      },
      payload,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    })
    expect(bodyRead).toBe(false)
    expect(uploadStore.write).not.toHaveBeenCalled()
  })

  it('resolves authentication once per protected request and not for public routes', async () => {
    await context.app.close()
    const sessionStore = new MemorySessionStore()
    const resolveAndTouch = vi.spyOn(sessionStore, 'resolveAndTouch')
    context = await buildApp({
      config,
      logger: false,
      sessionStore,
      taxReportReader: new TestDurableTaxReportReader(),
      now: () => now,
    })
    const { token } = await createSession()

    const protectedResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(protectedResponse.statusCode).toBe(200)
    expect(resolveAndTouch).toHaveBeenCalledTimes(1)

    const taxReportResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2027/current',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(taxReportResponse.statusCode).toBe(404)
    expect(resolveAndTouch).toHaveBeenCalledTimes(2)

    const publicResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/capabilities',
    })
    expect(publicResponse.statusCode).toBe(200)
    expect(resolveAndTouch).toHaveBeenCalledTimes(2)
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

  it('fails closed when a database is configured without a wallet Engine store', async () => {
    await context.app.close()
    context = await buildApp({
      config: { ...config, databaseUrl: 'postgres://configured.example/daejang' },
      logger: false,
      now: () => now,
    })
    const { token } = await createSession()
    const cookie = `${config.sessionCookieName}=${token}`

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: { cookie },
    })
    const challenge = await context.app.inject({
      method: 'POST',
      url: '/api/v1/sources/wallets/challenges',
      headers: { cookie, origin: config.publicOrigin },
      payload: {
        address: '0x1111111111111111111111111111111111111111',
        chainId: 'eip155:1',
      },
    })

    for (const response of [list, challenge]) {
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        error: { code: 'WALLET_SOURCE_UNAVAILABLE' },
      })
    }
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
      user: {
        id: USER_ID,
        displayName: '김대장',
        email: 'account@example.com',
      },
    })
  })

  it('does not expose a development session issuance endpoint', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/dev/session',
      headers: { origin: config.publicOrigin },
    })

    expect(response.statusCode).toBe(404)
  })

  it('reports the Upbit PDF import capability as disabled without a supported Engine', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources/capabilities',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      upbitPdf: {
        registrationEnabled: false,
        encryptedPdfSupported: false,
      },
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
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: Record<string, unknown>,
    ) => {
      const requestOptions = {
        method,
        url,
        headers: {
          cookie: `${config.sessionCookieName}=${token}`,
          ...(method !== 'GET' ? { origin: config.publicOrigin } : {}),
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
      chainIds: ['eip155:1'],
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

    const updated = await request(
      'PUT',
      `/api/v1/sources/${source.id}/chains`,
      { chainIds: ['eip155:1', 'eip155:10'] },
    )
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      id: source.id,
      address: wallet.address.toLowerCase(),
      chainScopes: [
        { chainId: 'eip155:1', status: 'ACTIVE' },
        { chainId: 'eip155:10', status: 'ACTIVE' },
      ],
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
            { chainId: 'eip155:10', status: 'ACTIVE' },
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
        { chainId: 'eip155:10', status: 'DISABLED' },
      ],
    })
  })

  it('rejects unsupported wallet collection networks', async () => {
    const { token } = await createSession()
    const wallet = Wallet.createRandom()
    const challengeResponse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/sources/wallets/challenges',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
      payload: { address: wallet.address, chainId: 'eip155:8453' },
    })

    expect(challengeResponse.statusCode).toBe(400)
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
      readConfirmed: vi.fn(async () =>
        session
          ? { session, contents: Buffer.from(pdf) }
          : undefined),
      discard: vi.fn(async () => true),
      cleanupAbandoned: vi.fn(async () => ({
        examined: 0, removed: 0, missing: 0, retryPending: 0,
      })),
    }
    const importUpbitDocument = vi.fn(async () => ({
      source: { id: sourceId, status: 'ACTIVE' },
      job: { id: '00000000-0000-4000-8000-000000000012', state: 'SUCCEEDED' },
      evidenceTerminalStatus: 'PARTIAL',
      sourceRecordCount: 1,
      normalizedRecordCount: 0,
    }))
    const engineDataClient = {
      upbitPdfImportSupported: true,
      importUpbitDocument,
      enqueueSync: vi.fn(async () => ({})),
      listAllSources: vi.fn(async () => ({ wallets: [], documents: [] })),
      getSyncJob: vi.fn(async () => ({})), listSyncJobs: vi.fn(async () => []),
      getDashboard: vi.fn(async () => ({})), listLedgerEvents: vi.fn(async () => []),
      getLedgerEventLots: vi.fn(async () => ({ runId: '', coverage: '', links: [] })),
      listReviews: vi.fn(async () => ({ items: [], nextPageToken: '' })), getReview: vi.fn(async () => ({})),
      resolveReview: vi.fn(async () => ({ review: {}, replayed: false })),
      createReport: vi.fn(async () => ({})),
      listReports: vi.fn(async () => []),
      listTaxReportHistory: vi.fn(async () => []),
    } satisfies EngineDataClient
    context = await buildApp({
      config,
      logger: false,
      now: () => now,
      uploadStore,
      engineDataClient,
      taxReportReader: new TestDurableTaxReportReader(),
    })
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
    const imported = await context.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/import?coverageStart=2026-01-01&coverageEnd=2026-12-31`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })
    expect(imported.statusCode).toBe(201)
    expect(importUpbitDocument).toHaveBeenCalledWith(expect.objectContaining({
      uploadId,
      byteLength: pdf.length,
      coverageStart: '2026-01-01',
      coverageEnd: '2026-12-31',
      expectedSubjectName: '',
    }))
  })

  it('does not create an upload when the Engine importer is unavailable', async () => {
    await context.app.close()
    const create = vi.fn(async () => {
      throw new Error('upload store must not be reached')
    })
    const uploadStore: UploadStore = {
      durable: true,
      create,
      write: vi.fn(async () => undefined),
      confirm: vi.fn(async () => undefined),
      discard: vi.fn(async () => true),
      cleanupAbandoned: vi.fn(async () => ({
        examined: 0, removed: 0, missing: 0, retryPending: 0,
      })),
    }
    context = await buildApp({ config, logger: false, now: () => now, uploadStore })
    const { token } = await createSession()
    const headers = { cookie: `${config.sessionCookieName}=${token}`, origin: config.publicOrigin }

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers,
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 128,
        intentKey: 'no-engine-upload',
      },
    })
    expect(created.statusCode).toBe(503)
    expect(created.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps source and data endpoints gated when only an upload store is available', async () => {
    await context.app.close()
    const discard = vi.fn(async () => true)
    const uploadStore: UploadStore = {
      durable: true,
      create: vi.fn(async () => { throw new Error('not used') }),
      write: vi.fn(async () => undefined),
      confirm: vi.fn(async (): Promise<UploadSession> => ({
        id: '00000000-0000-4000-8000-000000000021',
        userId: USER_ID,
        provider: 'UPBIT',
        objectKey: `upbit/${USER_ID}/confirmed.pdf`,
        originalFilename: 'confirmed.pdf',
        mediaType: 'application/pdf',
        expectedBytes: 16,
        state: 'CONFIRMED',
        idempotencyKey: 'confirmed-no-engine',
        expiresAt: new Date(now.getTime() + 60_000),
        verifiedDigest: 'a'.repeat(64),
        verifiedBytes: 16,
      })),
      discard,
      cleanupAbandoned: vi.fn(async () => ({
        examined: 0, removed: 0, missing: 0, retryPending: 0,
      })),
    }
    context = await buildApp({ config, logger: false, now: () => now, uploadStore })
    const { token } = await createSession()
    const headers = { cookie: `${config.sessionCookieName}=${token}`, origin: config.publicOrigin }

    const confirmed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/00000000-0000-4000-8000-000000000021/import?coverageStart=2026-01-01&coverageEnd=2026-12-31',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })
    expect(confirmed.statusCode).toBe(503)
    expect(confirmed.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(discard).not.toHaveBeenCalled()

    const dashboard = await context.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard?taxYear=2026',
      headers,
    })
    expect(dashboard.statusCode).toBe(503)
    expect(dashboard.json()).toMatchObject({
      error: { code: 'ENGINE_UNAVAILABLE' },
    })

    const reports = await context.app.inject({
      method: 'GET',
      url: '/api/v1/reports?taxYear=2026',
      headers,
    })
    expect(reports.statusCode).toBe(503)
    expect(reports.json()).toMatchObject({
      error: { code: 'ENGINE_UNAVAILABLE' },
    })
  })

  it('keeps data endpoints registered when neither Engine nor upload storage is configured', async () => {
    const unauthenticated = await context.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard?taxYear=2026',
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    })

    const { token } = await createSession()
    const headers = {
      cookie: `${config.sessionCookieName}=${token}`,
      origin: config.publicOrigin,
    }

    for (const url of [
      '/api/v1/dashboard?taxYear=2026',
      '/api/v1/ledger?taxYear=2026',
      '/api/v1/reviews',
      '/api/v1/reports?taxYear=2026',
    ]) {
      const response = await context.app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        error: { code: 'ENGINE_UNAVAILABLE' },
      })
    }

    const upload = await context.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers,
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 128,
        intentKey: 'no-upload-storage',
      },
    })
    expect(upload.statusCode).toBe(503)
    expect(upload.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
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

  it('rejects oversized bodies after authenticating the request', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: config.publicOrigin,
        cookie: `${config.sessionCookieName}=${token}`,
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

    await expect(
      buildApp({
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
      }),
    ).rejects.toThrow('durable TaxReportReader')

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
      taxReportReader: new TestDurableTaxReportReader(),
    })
    const health = await productionContext.app.inject('/healthz')
    expect(health.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
    await productionContext.app.close()

    context = await buildApp({ config, logger: false, now: () => now })
  })
})
