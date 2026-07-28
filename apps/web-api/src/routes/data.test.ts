import { Readable } from 'node:stream'

import { status as grpcStatus } from '@grpc/grpc-js'
import Fastify, { type onRequestHookHandler } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MemoryRateLimitStore,
  UploadAdmissionRateLimiter,
  type RateLimitStore,
} from '../auth/rate-limit.js'
import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import { ApiError } from '../errors.js'
import { UploadValidationError, type UploadSession, type UploadStore } from '../uploads/upload-store.js'
import { registerDataRoutes, type EngineDataClient } from './data.js'

const userId = '11111111-1111-4111-8111-111111111111'
const session: SessionRecord = {
  id: 'session-1',
  user: { id: userId, displayName: '김대장' },
  sessionEpoch: 1,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  lastSeenAt: new Date('2027-01-01T00:00:00Z'),
  absoluteExpiresAt: new Date('2027-01-02T00:00:00Z'),
  idleExpiresAt: new Date('2027-01-01T01:00:00Z'),
}

const uploadStore: UploadStore = {
  durable: true,
  create: vi.fn(async () => { throw new Error('not used') }),
  write: vi.fn(async () => undefined),
  confirm: vi.fn(async () => undefined),
  discard: vi.fn(async () => true),
  cleanupAbandoned: vi.fn(async () => ({
    examined: 0, removed: 0, missing: 0, retryPending: 0,
  })),
}

const engineClient = (overrides: Partial<EngineDataClient> = {}): EngineDataClient => ({
  upbitPdfImportSupported: true,
  registerDocument: vi.fn(async () => ({})),
  listAllSources: vi.fn(async () => ({ wallets: [], documents: [] })),
  enqueueSync: vi.fn(async () => ({})),
  getSyncJob: vi.fn(async () => ({})),
  listSyncJobs: vi.fn(async () => []),
  getDashboard: vi.fn(async () => ({})),
  listLedgerEvents: vi.fn(async () => []),
  listReviews: vi.fn(async () => ({ items: [], nextPageToken: '' })),
  getReview: vi.fn(async () => ({ id: 'review-1' })),
  resolveReview: vi.fn(async () => ({ review: { id: 'review-1', status: 'RESOLVED' }, replayed: false })),
  createReport: vi.fn(async () => ({})),
  listReports: vi.fn(async () => []),
  listTaxReportHistory: vi.fn(async () => []),
  ...overrides,
})

const apps: Array<ReturnType<typeof Fastify>> = []

const buildRouteApp = async (
  engine: EngineDataClient | undefined,
  authenticate: onRequestHookHandler = async (request) => {
    request.authSession = session
  },
  routeUploadStore: UploadStore = uploadStore,
  rateLimitStore: RateLimitStore = new MemoryRateLimitStore(),
) => {
  const app = Fastify({ logger: false })
  apps.push(app)
  app.decorateRequest('authSession', undefined)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.headers(error.headers)
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      })
    }
    throw error
  })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', authenticate)
    await registerDataRoutes(protectedApp, {
      uploadStore: routeUploadStore,
      uploadAdmissionRateLimiter: new UploadAdmissionRateLimiter(
        rateLimitStore,
        'test-upload-rate-limit-secret',
        () => new Date('2027-01-01T00:00:00Z'),
      ),
      ...(engine ? { engine } : {}),
    })
  })
  return app
}

const confirmedUpload = (): UploadSession => ({
  id: '22222222-2222-4222-8222-222222222222',
  userId,
  provider: 'UPBIT',
  objectKey: `upbit/${userId}/statement.pdf`,
  originalFilename: 'statement.pdf',
  mediaType: 'application/pdf',
  expectedBytes: 128,
  state: 'CONFIRMED',
  idempotencyKey: 'upload-intent',
  expiresAt: new Date('2027-01-01T01:00:00Z'),
  verifiedDigest: 'a'.repeat(64),
  verifiedBytes: 128,
})

describe('upload admission boundary', () => {
  it.each([
    ['missing Engine', undefined],
    [
      'unsupported Engine importer',
      engineClient({ upbitPdfImportSupported: false }),
    ],
  ])('rejects create before persistence for %s', async (_label, engine) => {
    const create = vi.fn(async () => confirmedUpload())
    const app = await buildRouteApp(
      engine,
      undefined,
      { ...uploadStore, create },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 128,
        intentKey: 'upload-intent',
      },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('returns the existing 429 contract before creating a thirteenth upload in one hour', async () => {
    const create = vi.fn(async () => confirmedUpload())
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, create },
    )
    const request = {
      method: 'POST' as const,
      url: '/api/v1/uploads',
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 128,
        intentKey: 'upload-intent',
      },
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await app.inject(request)).statusCode).toBe(201)
    }
    const rejected = await app.inject(request)

    expect(rejected.statusCode).toBe(429)
    expect(rejected.headers['retry-after']).toBe('3600')
    expect(rejected.json()).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED' },
    })
    expect(create).toHaveBeenCalledTimes(12)
  })

  it('blocks content and confirmation without consuming more quota when capability is disabled after create', async () => {
    const create = vi.fn(async () => confirmedUpload())
    const write = vi.fn(async () => confirmedUpload())
    const confirm = vi.fn(async () => confirmedUpload())
    const rateLimitStore = new MemoryRateLimitStore()
    const increment = vi.spyOn(rateLimitStore, 'increment')
    const engine = engineClient()
    const app = await buildRouteApp(
      engine,
      undefined,
      { ...uploadStore, create, write, confirm },
      rateLimitStore,
    )

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 9,
        intentKey: 'upload-intent',
      },
    })
    expect(created.statusCode).toBe(201)
    expect(increment).toHaveBeenCalledTimes(2)

    ;(engine as { upbitPdfImportSupported: boolean }).upbitPdfImportSupported = false
    const content = await app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/content',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-test'),
    })
    const confirmation = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/confirm',
      payload: { coverageStart: '2027-01-01', coverageEnd: '2027-12-31' },
    })

    for (const response of [content, confirmation]) {
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
      })
    }
    expect(increment).toHaveBeenCalledTimes(2)
    expect(write).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('requires a declared PDF byte length before reading or storing content', async () => {
    const write = vi.fn(async () => confirmedUpload())
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, write },
    )

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/content',
      headers: { 'content-type': 'application/pdf' },
      payload: Readable.from(Buffer.from('%PDF-test')),
    })

    expect(response.statusCode).toBe(411)
    expect(response.json()).toMatchObject({
      error: { code: 'CONTENT_LENGTH_REQUIRED' },
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects content whose parsed byte length differs from its declaration', async () => {
    const write = vi.fn(async () => confirmedUpload())
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, write },
    )

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/content',
      headers: {
        'content-type': 'application/pdf',
        'content-length': '1',
      },
      payload: Buffer.from('%PDF-test'),
    })

    expect(response.statusCode).toBe(400)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('upload confirmation boundary', () => {
  it('rejects an inverted coverage range before the upload store or Engine', async () => {
    const confirm = vi.fn(async () => confirmedUpload())
    const registerDocument = vi.fn(async () => ({ id: 'source-1' }))
    const app = await buildRouteApp(
      engineClient({ registerDocument }),
      undefined,
      { ...uploadStore, confirm },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/confirm',
      payload: { coverageStart: '2027-12-31', coverageEnd: '2027-01-01' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_COVERAGE_PERIOD' } })
    expect(confirm).not.toHaveBeenCalled()
    expect(registerDocument).not.toHaveBeenCalled()
  })

  it('does not register a source or job when the upload store detects encryption', async () => {
    const confirm = vi.fn(async () => {
      throw new UploadValidationError('ENCRYPTED_PDF')
    })
    const registerDocument = vi.fn(async () => ({ id: 'source-1' }))
    const enqueueSync = vi.fn(async () => ({ id: 'job-1' }))
    const app = await buildRouteApp(
      engineClient({ registerDocument, enqueueSync }),
      undefined,
      { ...uploadStore, confirm },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/confirm',
      payload: { coverageStart: '2027-01-01', coverageEnd: '2027-12-31' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'ENCRYPTED_PDF' } })
    expect(registerDocument).not.toHaveBeenCalled()
    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('rejects confirmation before upload validation when the Engine import capability is unavailable', async () => {
    const confirm = vi.fn(async () => confirmedUpload())
    const discard = vi.fn(async () => true)
    const registerDocument = vi.fn(async () => ({ id: 'source-1' }))
    const enqueueSync = vi.fn(async () => ({ id: 'job-1' }))
    const app = await buildRouteApp(
      engineClient({
        upbitPdfImportSupported: false,
        registerDocument,
        enqueueSync,
      }),
      undefined,
      { ...uploadStore, confirm, discard },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/confirm',
      payload: { coverageStart: '2027-01-01', coverageEnd: '2027-12-31' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(registerDocument).not.toHaveBeenCalled()
    expect(enqueueSync).not.toHaveBeenCalled()
  })
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('review data routes', () => {
  it('forwards the account-scoped review cursor without exposing Engine tokens as fields', async () => {
    const listReviews = vi.fn(async () => ({
      items: [{ id: 'review-2' }],
      nextPageToken: 'engine-page-token',
    }))
    const app = await buildRouteApp(engineClient({ listReviews }))
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reviews?limit=25&cursor=prior-engine-token',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [{ id: 'review-2' }],
      nextCursor: 'engine-page-token',
    })
    expect(listReviews).toHaveBeenCalledWith({
      requestId: expect.any(String),
      userId,
      sessionId: session.id,
    }, 25, 'prior-engine-token')
  })

  it('maps an invalid Engine review cursor to a client error', async () => {
    const app = await buildRouteApp(engineClient({
      listReviews: vi.fn(async () => {
        throw new EngineRpcError(grpcStatus.INVALID_ARGUMENT, 'invalid page token')
      }),
    }))
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reviews?cursor=invalid-but-shaped',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REVIEW_CURSOR' },
    })
  })

  it('requires an authenticated account for review detail', async () => {
    const app = await buildRouteApp(engineClient(), async () => undefined)
    const response = await app.inject({ method: 'GET', url: '/api/v1/reviews/review-1' })
    expect(response.statusCode).toBe(401)
  })

  it('maps missing account-scoped review detail to 404', async () => {
    const app = await buildRouteApp(engineClient({
      getReview: vi.fn(async () => { throw new EngineRpcError(grpcStatus.NOT_FOUND) }),
    }))
    const response = await app.inject({ method: 'GET', url: '/api/v1/reviews/review-1' })
    expect(response.statusCode).toBe(404)
  })

  it('derives actor context from the session and forwards only the resolution contract', async () => {
    const resolveReview = vi.fn(async () => ({
      review: { id: 'review-1', status: 'RESOLVED' },
      replayed: false,
    }))
    const app = await buildRouteApp(engineClient({ resolveReview }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/review-1/resolutions',
      payload: {
        expectedRevisionId: 'revision-1',
        expectedPointerVersion: '3',
        resolutionCode: 'PERSONAL',
        resolutionNote: '사용자 확인',
        intentKey: 'stable-intent-1',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(resolveReview).toHaveBeenCalledWith({
      requestId: expect.any(String),
      userId,
      sessionId: session.id,
      idempotencyKey: 'stable-intent-1',
    }, {
      reviewId: 'review-1',
      expectedRevisionId: 'revision-1',
      expectedPointerVersion: '3',
      resolutionCode: 'PERSONAL',
      resolutionNote: '사용자 확인',
    })
  })

  it('rejects pointer values that proto-loader would wrap outside signed int64', async () => {
    const resolveReview = vi.fn(async () => ({
      review: { id: 'review-1', status: 'RESOLVED' },
      replayed: false,
    }))
    const app = await buildRouteApp(engineClient({ resolveReview }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/review-1/resolutions',
      payload: {
        expectedRevisionId: 'revision-1',
        expectedPointerVersion: '9223372036854775808',
        resolutionCode: 'PERSONAL',
        intentKey: 'stable-intent-overflow',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'REVIEW_RESOLUTION_INVALID' },
    })
    expect(resolveReview).not.toHaveBeenCalled()
  })

  it('maps stale review CAS to 409', async () => {
    const app = await buildRouteApp(engineClient({
      resolveReview: vi.fn(async () => { throw new EngineRpcError(grpcStatus.ABORTED) }),
    }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/review-1/resolutions',
      payload: {
        expectedRevisionId: 'revision-1',
        expectedPointerVersion: '3',
        resolutionCode: 'PERSONAL',
        intentKey: 'stable-intent-2',
      },
    })
    expect(response.statusCode).toBe(409)
  })

  it('maps an unpinned review to an explicit lineage failure', async () => {
    const app = await buildRouteApp(engineClient({
      resolveReview: vi.fn(async () => {
        throw new EngineRpcError(
          grpcStatus.FAILED_PRECONDITION,
          'REVIEW_SCHEMA_MODULE_PIN_MISSING',
        )
      }),
    }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/review-1/resolutions',
      payload: {
        expectedRevisionId: 'revision-1',
        expectedPointerVersion: '3',
        resolutionCode: 'PERSONAL',
        intentKey: 'stable-intent-3',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: { code: 'REVIEW_LINEAGE_UNAVAILABLE' },
    })
  })
})

describe('sync and tax report data routes', () => {
  it('rejects an Upbit sync while PDF import capability is disabled', async () => {
    const enqueueSync = vi.fn(async () => ({ id: 'unexpected-job' }))
    const app = await buildRouteApp(
      engineClient({ upbitPdfImportSupported: false, enqueueSync }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/syncs',
      payload: {
        sourceKind: 'UPBIT_PDF',
        sourceId: '33333333-3333-4333-8333-333333333333',
        coverageStart: '2027-01-01',
        coverageEnd: '2027-12-31',
        trigger: 'USER_REQUEST',
        intentKey: 'disabled-upbit-sync',
      },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('creates an account-scoped sync with a date-only range and stable intent key', async () => {
    const enqueueSync = vi.fn(async () => ({ id: 'job-1', state: 'QUEUED' }))
    const app = await buildRouteApp(engineClient({ enqueueSync }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/syncs',
      headers: { 'x-user-id': '22222222-2222-4222-8222-222222222222' },
      payload: {
        sourceKind: 'EVM_WALLET',
        sourceId: '33333333-3333-4333-8333-333333333333',
        coverageStart: '2027-01-01',
        coverageEnd: '2027-12-31',
        trigger: 'USER_REQUEST',
        intentKey: 'wallet-2027',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(enqueueSync).toHaveBeenCalledWith({
      requestId: expect.any(String), userId, sessionId: session.id,
      idempotencyKey: 'wallet-2027',
    }, {
      sourceKind: 'EVM_WALLET',
      sourceId: '33333333-3333-4333-8333-333333333333',
      requestedCoverageStart: '2027-01-01',
      requestedCoverageEnd: '2027-12-31',
      trigger: 'USER_REQUEST',
    })
  })

  it('rejects an inverted sync range before calling Engine', async () => {
    const enqueueSync = vi.fn(async () => ({}))
    const app = await buildRouteApp(engineClient({ enqueueSync }))
    const response = await app.inject({
      method: 'POST', url: '/api/v1/syncs',
      payload: {
        sourceKind: 'EVM_WALLET', sourceId: '33333333-3333-4333-8333-333333333333',
        coverageStart: '2027-12-31', coverageEnd: '2027-01-01',
        trigger: 'USER_REQUEST', intentKey: 'inverted',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SYNC_PERIOD' } })
    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('does not leak a source owned by another account', async () => {
    const app = await buildRouteApp(engineClient({
      enqueueSync: vi.fn(async () => { throw new EngineRpcError(grpcStatus.NOT_FOUND) }),
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/v1/syncs',
      payload: {
        sourceKind: 'EVM_WALLET', sourceId: '44444444-4444-4444-8444-444444444444',
        coverageStart: '2027-01-01', coverageEnd: '2027-12-31',
        trigger: 'USER_REQUEST', intentKey: 'foreign-source',
      },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } })
  })

  it('maps reuse of a sync intent key with different immutable input to conflict', async () => {
    const app = await buildRouteApp(engineClient({
      enqueueSync: vi.fn(async () => { throw new EngineRpcError(grpcStatus.ALREADY_EXISTS, 'SYNC_IDEMPOTENCY_CONFLICT') }),
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/v1/syncs',
      payload: {
        sourceKind: 'EVM_WALLET', sourceId: '33333333-3333-4333-8333-333333333333',
        coverageStart: '2027-01-01', coverageEnd: '2027-12-31',
        trigger: 'USER_REQUEST', intentKey: 'reused-intent',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'SYNC_INTENT_CONFLICT' } })
  })

  it('projects every tax report history item through the browser whitelist', async () => {
    const listTaxReportHistory = vi.fn(async () => [{
      reportId: 'report-history', residentId: 'resident-private', taxYear: 2027,
      finality: 'FINAL', status: 'FINAL', filingStatus: 'READY', denominationAssetId: 'KRW',
      pointerVersion: '0', issuedAt: '2027-01-01T00:00:00Z', inputDigest: 'private',
      counts: {}, gainLoss: {}, taxableBase: {}, nationalTax: {}, localTax: {}, totalTax: {},
    }])
    const app = await buildRouteApp(engineClient({ listTaxReportHistory }))
    const response = await app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/history?limit=10' })
    expect(response.statusCode).toBe(200)
    expect(listTaxReportHistory).toHaveBeenCalledWith(expect.any(Object), 2027, 10)
    expect(response.json().items[0]).not.toHaveProperty('residentId')
    expect(response.json().items[0]).not.toHaveProperty('inputDigest')
  })

  it('returns an explicit replacement response for legacy zero-KRW report generation', async () => {
    const app = await buildRouteApp(engineClient({
      createReport: vi.fn(async () => { throw new EngineRpcError(grpcStatus.FAILED_PRECONDITION, 'LEGACY_REPORT_CREATION_DISABLED') }),
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/v1/reports', payload: { taxYear: 2027, intentKey: 'legacy-report' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'REPORT_GENERATION_REPLACED' } })
  })
})
