import { status as grpcStatus } from '@grpc/grpc-js'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import { ApiError } from '../errors.js'
import type { UploadStore } from '../uploads/upload-store.js'
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
}

const engineClient = (overrides: Partial<EngineDataClient> = {}): EngineDataClient => ({
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
  ...overrides,
})

const apps: Array<ReturnType<typeof Fastify>> = []

const buildRouteApp = async (
  engine: EngineDataClient,
  authenticate: preHandlerHookHandler = async (request) => {
    request.authSession = session
  },
) => {
  const app = Fastify({ logger: false })
  apps.push(app)
  app.decorateRequest('authSession', undefined)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      })
    }
    throw error
  })
  await registerDataRoutes(app, { authenticate, uploadStore, engine })
  return app
}

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
