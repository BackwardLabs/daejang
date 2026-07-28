import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { status as grpcStatus } from '@grpc/grpc-js'

import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import { ApiError, resourceNotFound, unauthorized } from '../errors.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import type { UploadStore } from '../uploads/upload-store.js'

export type EngineDataClient = {
  registerDocument(input: {
    context: SourceRequestContext
    uploadId: string
    objectKey: string
    artifactDigest: string
    originalFilename: string
    mediaType: string
    byteLength: number
    coverageStart: string
    coverageEnd: string
  }): Promise<Record<string, unknown>>
  listAllSources(context: SourceRequestContext): Promise<{ wallets: unknown[]; documents: unknown[] }>
  enqueueSync(context: SourceRequestContext, sourceKind: string, sourceId: string): Promise<Record<string, unknown>>
  getSyncJob(context: SourceRequestContext, jobId: string): Promise<Record<string, unknown>>
  listSyncJobs(context: SourceRequestContext, limit?: number): Promise<Array<Record<string, unknown>>>
  getDashboard(context: SourceRequestContext, taxYear: number): Promise<Record<string, unknown>>
  listLedgerEvents(context: SourceRequestContext, taxYear: number, limit?: number): Promise<Array<Record<string, unknown>>>
  listReviews(context: SourceRequestContext, limit?: number, pageToken?: string): Promise<{
    items: Array<Record<string, unknown>>
    nextPageToken: string
  }>
  getReview(context: SourceRequestContext, reviewId: string): Promise<Record<string, unknown>>
  resolveReview(context: SourceRequestContext, input: {
    reviewId: string
    expectedRevisionId: string
    expectedPointerVersion: string
    resolutionCode: string
    resolutionNote: string
  }): Promise<{ review: Record<string, unknown>; replayed: boolean }>
  createReport(context: SourceRequestContext, taxYear: number): Promise<Record<string, unknown>>
  listReports(context: SourceRequestContext, taxYear: number, limit?: number): Promise<Array<Record<string, unknown>>>
}

const contextFor = (
  request: { id: string; authSession: SessionRecord | undefined },
  idempotencyKey?: string,
): SourceRequestContext => {
  const session = request.authSession
  if (!session) throw unauthorized()
  return { requestId: request.id, userId: session.user.id, sessionId: session.id, ...(idempotencyKey ? { idempotencyKey } : {}) }
}

const taxYearQuery = {
  type: 'object', additionalProperties: false, required: ['taxYear'],
  properties: { taxYear: { type: 'integer', minimum: 2009, maximum: 9999 } },
} as const

const mapReviewEngineError = (error: unknown): never => {
  if (!(error instanceof EngineRpcError)) throw error
  switch (error.grpcCode) {
    case grpcStatus.NOT_FOUND:
      throw resourceNotFound()
    case grpcStatus.ABORTED:
      throw new ApiError(409, 'REVIEW_STALE', '검토 내용이 변경되었습니다. 최신 내용을 다시 확인해 주세요.')
    case grpcStatus.FAILED_PRECONDITION:
      if (error.grpcDetails === 'REVIEW_SCHEMA_MODULE_PIN_MISSING') {
        throw new ApiError(409, 'REVIEW_LINEAGE_UNAVAILABLE', '이 검토의 필수 분석 계보를 확인할 수 없습니다.')
      }
      throw new ApiError(409, 'REVIEW_NOT_OPEN', '이미 완료되었거나 해결할 수 없는 검토입니다.')
    case grpcStatus.ALREADY_EXISTS:
      throw new ApiError(409, 'REVIEW_INTENT_CONFLICT', '같은 요청 키가 다른 응답에 사용되었습니다.')
    case grpcStatus.INVALID_ARGUMENT:
      throw new ApiError(400, 'REVIEW_RESOLUTION_INVALID', '검토 응답 값을 확인해 주세요.')
    default:
      throw error
  }
}

const mapReviewListError = (error: unknown): never => {
  if (error instanceof EngineRpcError && error.grpcCode === grpcStatus.INVALID_ARGUMENT) {
    throw new ApiError(400, 'INVALID_REVIEW_CURSOR', '검토 목록 위치 값이 유효하지 않습니다.')
  }
  throw error
}

const validExpectedPointerVersion = (value: string) => {
  if (!/^[1-9][0-9]*$/.test(value)) return false
  const pointer = BigInt(value)
  return pointer <= 9_223_372_036_854_775_806n
}

export const registerDataRoutes = async (
  app: FastifyInstance,
  options: {
    authenticate: preHandlerHookHandler
    uploadStore: UploadStore
    engine: EngineDataClient
    now?: () => Date
  },
) => {
  const now = options.now ?? (() => new Date())
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

  app.post<{ Body: { filename: string; mediaType: 'application/pdf'; sizeBytes: number; intentKey: string } }>(
    '/api/v1/uploads',
    { preHandler: options.authenticate, schema: { body: { type: 'object', additionalProperties: false, required: ['filename','mediaType','sizeBytes','intentKey'], properties: {
      filename: { type: 'string', minLength: 1, maxLength: 255 }, mediaType: { type: 'string', const: 'application/pdf' },
      sizeBytes: { type: 'integer', minimum: 1, maximum: 20 * 1024 * 1024 }, intentKey: { type: 'string', minLength: 1, maxLength: 200 },
    } } } },
    async (request, reply) => {
      const context = contextFor(request)
      const session = await options.uploadStore.create({ userId: context.userId, originalFilename: request.body.filename,
        mediaType: request.body.mediaType, expectedBytes: request.body.sizeBytes, idempotencyKey: request.body.intentKey, now: now() })
      return reply.status(201).send({ uploadId: session.id, uploadUrl: `/api/v1/uploads/${session.id}/content`, expiresAt: session.expiresAt.toISOString() })
    },
  )

  app.put<{ Params: { uploadId: string }; Body: Buffer }>(
    '/api/v1/uploads/:uploadId/content',
    { preHandler: options.authenticate, bodyLimit: 20 * 1024 * 1024, schema: { params: { type: 'object', required: ['uploadId'], properties: { uploadId: { type: 'string', format: 'uuid' } } } } },
    async (request, reply) => {
      const context = contextFor(request)
      if (!Buffer.isBuffer(request.body)) throw resourceNotFound()
      const session = await options.uploadStore.write(context.userId, request.params.uploadId, request.body, now())
      if (!session) throw resourceNotFound()
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { uploadId: string }; Body: { coverageStart: string; coverageEnd: string } }>(
    '/api/v1/uploads/:uploadId/confirm',
    { preHandler: options.authenticate, schema: {
      params: { type: 'object', required: ['uploadId'], properties: { uploadId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['coverageStart','coverageEnd'], properties: {
        coverageStart: { type: 'string', format: 'date' }, coverageEnd: { type: 'string', format: 'date' },
      } },
    } },
    async (request, reply) => {
      const context = contextFor(request, `upload:${request.params.uploadId}`)
      const session = await options.uploadStore.confirm(context.userId, request.params.uploadId, now())
      if (!session?.verifiedDigest || session.verifiedBytes === undefined) throw resourceNotFound()
      const source = await options.engine.registerDocument({ context, uploadId: session.id, objectKey: session.objectKey,
        artifactDigest: session.verifiedDigest, originalFilename: session.originalFilename,
        mediaType: session.mediaType, byteLength: session.verifiedBytes,
        coverageStart: request.body.coverageStart, coverageEnd: request.body.coverageEnd })
      const job = await options.engine.enqueueSync({ ...context, idempotencyKey: `sync:${session.id}` }, 'UPBIT_PDF', String(source.id))
      return reply.status(201).send({ source, job })
    },
  )

  app.get<{ Querystring: { taxYear: number } }>('/api/v1/dashboard', { preHandler: options.authenticate, schema: { querystring: taxYearQuery } },
    async (request) => ({ dashboard: await options.engine.getDashboard(contextFor(request), Number(request.query.taxYear)) }))

  const listEvents = async (request: { id: string; authSession: SessionRecord | undefined; query: { taxYear: number; limit?: number } }) => ({
    items: await options.engine.listLedgerEvents(contextFor(request), Number(request.query.taxYear), Number(request.query.limit ?? 100)),
  })
  const eventQuery = { ...taxYearQuery, properties: { ...taxYearQuery.properties, limit: { type: 'integer', minimum: 1, maximum: 200 } } } as const
  app.get<{ Querystring: { taxYear: number; limit?: number } }>('/api/v1/activities', { preHandler: options.authenticate, schema: { querystring: eventQuery } }, listEvents)
  app.get<{ Querystring: { taxYear: number; limit?: number } }>('/api/v1/ledger', { preHandler: options.authenticate, schema: { querystring: eventQuery } }, listEvents)

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/v1/reviews', {
    preHandler: options.authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          cursor: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    },
  }, async (request) => {
    try {
      const page = await options.engine.listReviews(
        contextFor(request),
        Number(request.query.limit ?? 100),
        request.query.cursor ?? '',
      )
      return {
        items: page.items,
        ...(page.nextPageToken ? { nextCursor: page.nextPageToken } : {}),
      }
    } catch (error) {
      return mapReviewListError(error)
    }
  })
  app.get<{ Params: { reviewId: string } }>('/api/v1/reviews/:reviewId', {
    preHandler: options.authenticate,
    schema: { params: { type: 'object', additionalProperties: false, required: ['reviewId'], properties: {
      reviewId: { type: 'string', minLength: 1, maxLength: 256 },
    } } },
  }, async (request) => {
    try {
      return { review: await options.engine.getReview(contextFor(request), request.params.reviewId) }
    } catch (error) {
      return mapReviewEngineError(error)
    }
  })
  app.post<{ Params: { reviewId: string }; Body: {
    expectedRevisionId: string
    expectedPointerVersion: string
    resolutionCode: string
    resolutionNote?: string
    intentKey: string
  } }>('/api/v1/reviews/:reviewId/resolutions', {
    preHandler: options.authenticate,
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['reviewId'], properties: {
        reviewId: { type: 'string', minLength: 1, maxLength: 256 },
      } },
      body: { type: 'object', additionalProperties: false, required: [
        'expectedRevisionId', 'expectedPointerVersion', 'resolutionCode', 'intentKey',
      ], properties: {
        expectedRevisionId: { type: 'string', minLength: 1, maxLength: 256 },
        expectedPointerVersion: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 19 },
        resolutionCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
        resolutionNote: { type: 'string', maxLength: 4000 },
        intentKey: { type: 'string', minLength: 1, maxLength: 200 },
      } },
    },
  }, async (request, reply) => {
    try {
      if (!validExpectedPointerVersion(request.body.expectedPointerVersion)) {
        throw new ApiError(400, 'REVIEW_RESOLUTION_INVALID', '검토 pointer 값을 확인해 주세요.')
      }
      const result = await options.engine.resolveReview(contextFor(request, request.body.intentKey), {
        reviewId: request.params.reviewId,
        expectedRevisionId: request.body.expectedRevisionId,
        expectedPointerVersion: request.body.expectedPointerVersion,
        resolutionCode: request.body.resolutionCode,
        resolutionNote: request.body.resolutionNote ?? '',
      })
      return reply.status(result.replayed ? 200 : 201).send(result)
    } catch (error) {
      return mapReviewEngineError(error)
    }
  })
  app.get<{ Querystring: { taxYear: number } }>('/api/v1/reports', { preHandler: options.authenticate, schema: { querystring: taxYearQuery } },
    async (request) => ({ items: await options.engine.listReports(contextFor(request), Number(request.query.taxYear)) }))
  app.post<{ Body: { taxYear: number; intentKey: string } }>('/api/v1/reports', { preHandler: options.authenticate, schema: { body: { type: 'object', additionalProperties: false, required: ['taxYear','intentKey'], properties: { taxYear: { type: 'integer', minimum: 2009, maximum: 9999 }, intentKey: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => reply.status(201).send({ report: await options.engine.createReport(contextFor(request, request.body.intentKey), request.body.taxYear) }))
  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', { preHandler: options.authenticate }, async (request) => ({ job: await options.engine.getSyncJob(contextFor(request), request.params.jobId) }))
  app.get('/api/v1/jobs', { preHandler: options.authenticate }, async (request) => ({ items: await options.engine.listSyncJobs(contextFor(request)) }))
}
