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
import type { UploadSession, UploadStore } from '../uploads/upload-store.js'
import { registerDataRoutes, type EngineDataClient } from './data.js'

const userId = '11111111-1111-4111-8111-111111111111'
const session: SessionRecord = {
  id: 'session-1',
  user: { id: userId, displayName: '김대장' },
  verifiedSubjectName: {
    normalizedValue: '김대장',
  },
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
  observeParsedBody?: (body: Buffer) => void,
  upbitPdfImportEnabled = true,
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
    if (observeParsedBody) {
      protectedApp.addHook('preValidation', async (request) => {
        if (Buffer.isBuffer(request.body)) observeParsedBody(request.body)
      })
    }
    await registerDataRoutes(protectedApp, {
      uploadStore: routeUploadStore,
      upbitPdfImportEnabled,
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
  it('rejects before creating storage state when the deployment feature gate is off', async () => {
    const create = vi.fn(async () => {
      throw new Error('feature-disabled request reached storage')
    })
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, create },
      undefined,
      undefined,
      false,
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: {
        filename: 'statement.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 128,
        intentKey: 'feature-off',
      },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'UPBIT_PDF_IMPORT_UNAVAILABLE' },
    })
    expect(create).not.toHaveBeenCalled()
  })

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

  it('zeroizes the parsed encrypted upload buffer after persistence returns', async () => {
    let capturedBody: Buffer | undefined
    const write = vi.fn(async (_userId: string, _uploadId: string, contents: Buffer) => {
      capturedBody = contents
      expect(contents.equals(Buffer.from('%PDF-test'))).toBe(true)
      return confirmedUpload()
    })
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, write },
    )

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/content',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-test'),
    })

    expect(response.statusCode).toBe(204)
    expect(capturedBody && [...capturedBody].every((byte) => byte === 0)).toBe(true)
  })

  it('blocks content and import without consuming more quota when capability is disabled after create', async () => {
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
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })

    for (const response of [content, imported]) {
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

describe('synchronous PDF import boundary', () => {
  it('does not expose the legacy confirmation route that bypassed parsing', async () => {
    const confirm = vi.fn(async () => confirmedUpload())
    const app = await buildRouteApp(
      engineClient(),
      undefined,
      { ...uploadStore, confirm },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/confirm',
      payload: { coverageStart: '2027-01-01', coverageEnd: '2027-12-31' },
    })

    expect(response.statusCode).toBe(404)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects an inverted coverage range before confirming or reading the upload', async () => {
    const confirm = vi.fn(async () => confirmedUpload())
    const readConfirmed = vi.fn(async () => ({
      session: confirmedUpload(),
      contents: Buffer.alloc(128, 0x45),
    }))
    const app = await buildRouteApp(
      engineClient({ importUpbitDocument: vi.fn(async () => ({})) }),
      undefined,
      { ...uploadStore, confirm, readConfirmed },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-12-31&coverageEnd=2027-01-01',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_COVERAGE_PERIOD' },
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(readConfirmed).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'invalid upload identifier rejected by schema validation',
      url: '/api/v1/uploads/not-a-uuid/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      payload: Buffer.from([1, 9, 8, 7]),
      statusCode: 400,
    },
    {
      name: 'unknown envelope version',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      payload: Buffer.from([2, 9, 8, 7]),
      statusCode: 404,
    },
    {
      name: 'inverted coverage period',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-12-31&coverageEnd=2027-01-01',
      payload: Buffer.from([1, 9, 8, 7]),
      statusCode: 400,
    },
  ])('zeroizes the parsed password envelope after $name validation fails', async ({
    url,
    payload,
    statusCode,
  }) => {
    let parsedBody: Buffer | undefined
    const app = await buildRouteApp(
      engineClient({ importUpbitDocument: vi.fn(async () => ({})) }),
      undefined,
      uploadStore,
      undefined,
      (body) => { parsedBody = body },
    )

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/octet-stream' },
      payload,
    })

    expect(response.statusCode).toBe(statusCode)
    expect(parsedBody).toBeDefined()
    expect(parsedBody && [...parsedBody].every((byte) => byte === 0)).toBe(true)
  })

  it('imports for an authenticated user without requiring a verified subject claim', async () => {
    const confirm = vi.fn(async () => confirmedUpload())
    const readConfirmed = vi.fn(async () => ({
      session: confirmedUpload(),
      contents: Buffer.alloc(128, 0x45),
    }))
    const importUpbitDocument = vi.fn(async () => ({
      source: { id: 'source-1', status: 'ACTIVE' },
      job: { id: 'job-1', state: 'SUCCEEDED' },
    }))
    const app = await buildRouteApp(
      engineClient({ importUpbitDocument }),
      async (request) => {
        const { verifiedSubjectName: _verifiedSubjectName, ...unverifiedSession } = session
        request.authSession = {
          ...unverifiedSession,
          user: { id: userId, displayName: '김대장' },
        }
      },
      { ...uploadStore, confirm, readConfirmed },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })

    expect(response.statusCode).toBe(201)
    expect(confirm).toHaveBeenCalledOnce()
    expect(readConfirmed).toHaveBeenCalledOnce()
    expect(importUpbitDocument).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSubjectName: '' }),
    )
  })

  it('passes the encrypted PDF and password only in memory and zeroizes both buffers after Engine returns', async () => {
    const encryptedOriginal = Buffer.alloc(128, 0x45)
    const confirm = vi.fn(async () => confirmedUpload())
    const readConfirmed = vi.fn(async () => ({
      session: confirmedUpload(),
      contents: encryptedOriginal,
    }))
    let capturedOriginal: Buffer | undefined
    let capturedPassword: Buffer | undefined
    const importUpbitDocument = vi.fn(async (input: Parameters<NonNullable<EngineDataClient['importUpbitDocument']>>[0]) => {
      capturedOriginal = input.encryptedOriginalPdf
      capturedPassword = input.pdfPasswordUtf8
      expect(input.expectedSubjectName).toBe('')
      expect(input.context).toMatchObject({
        userId,
        sessionId: session.id,
        idempotencyKey: 'import:22222222-2222-4222-8222-222222222222',
      })
      return {
        source: { id: 'source-1', status: 'ACTIVE' },
        job: { id: 'job-1', state: 'SUCCEEDED' },
        evidenceTerminalStatus: 'PARTIAL',
        sourceRecordCount: 12,
        normalizedRecordCount: 0,
      }
    })
    const app = await buildRouteApp(
      engineClient({ importUpbitDocument }),
      undefined,
      { ...uploadStore, confirm, readConfirmed },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([Buffer.from([1]), Buffer.from('transient-password')]),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      job: { state: 'SUCCEEDED' },
      evidenceTerminalStatus: 'PARTIAL',
      sourceRecordCount: 12,
      normalizedRecordCount: 0,
    })
    expect(importUpbitDocument).toHaveBeenCalledOnce()
    expect(capturedOriginal && [...capturedOriginal].every((byte) => byte === 0)).toBe(true)
    expect(capturedPassword && [...capturedPassword].every((byte) => byte === 0)).toBe(true)
  })

  it('does not load the retained original when the Engine importer is unavailable', async () => {
    let capturedBody: Buffer | undefined
    const unavailableImporter = engineClient()
    delete unavailableImporter.importUpbitDocument
    const app = await buildRouteApp(
      unavailableImporter,
      undefined,
      {
        ...uploadStore,
        confirm: vi.fn(async () => confirmedUpload()),
        readConfirmed: vi.fn(async () => {
          capturedBody = Buffer.alloc(128, 0x45)
          return { session: confirmedUpload(), contents: capturedBody }
        }),
      },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    })

    expect(response.statusCode).toBe(503)
    expect(capturedBody).toBeUndefined()
  })

  it.each([
    [grpcStatus.FAILED_PRECONDITION, 'PDF_PASSWORD_INVALID', 422, 'PDF_PASSWORD_INVALID'],
    [grpcStatus.FAILED_PRECONDITION, 'SUBJECT_MISMATCH', 422, 'SUBJECT_MISMATCH'],
    [grpcStatus.FAILED_PRECONDITION, 'SUBJECT_CLAIM_UNAVAILABLE', 422, 'UPBIT_PDF_LAYOUT_UNSUPPORTED'],
    [grpcStatus.FAILED_PRECONDITION, 'PARSER_DOCUMENT_REJECTED', 422, 'INVALID_PDF'],
    [grpcStatus.ABORTED, 'IMPORT_IN_PROGRESS', 409, 'IMPORT_IN_PROGRESS'],
    [grpcStatus.ALREADY_EXISTS, 'IMPORT_IDEMPOTENCY_CONFLICT', 409, 'DUPLICATE_SOURCE'],
  ])('maps Engine import failure %s/%s without exposing parser details', async (
    grpcCode,
    details,
    statusCode,
    publicCode,
  ) => {
    const retained = Buffer.alloc(128, 0x45)
    const app = await buildRouteApp(
      engineClient({
        importUpbitDocument: vi.fn(async () => {
          throw new EngineRpcError(grpcCode, details)
        }),
      }),
      undefined,
      {
        ...uploadStore,
        confirm: vi.fn(async () => confirmedUpload()),
        readConfirmed: vi.fn(async () => ({ session: confirmedUpload(), contents: retained })),
      },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/22222222-2222-4222-8222-222222222222/import?coverageStart=2027-01-01&coverageEnd=2027-12-31',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([Buffer.from([1]), Buffer.from('transient-password')]),
    })

    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toMatchObject({ error: { code: publicCode } })
    expect([...retained].every((byte) => byte === 0)).toBe(true)
    expect(response.body).not.toContain(details === publicCode ? 'parser traceback' : details)
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
