import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import type { SessionRecord } from '../auth/session.js'
import { resourceNotFound, unauthorized } from '../errors.js'
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
  listReviews(context: SourceRequestContext, limit?: number): Promise<Array<Record<string, unknown>>>
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

  app.get('/api/v1/reviews', { preHandler: options.authenticate }, async (request) => ({ items: await options.engine.listReviews(contextFor(request)) }))
  app.get<{ Querystring: { taxYear: number } }>('/api/v1/reports', { preHandler: options.authenticate, schema: { querystring: taxYearQuery } },
    async (request) => ({ items: await options.engine.listReports(contextFor(request), Number(request.query.taxYear)) }))
  app.post<{ Body: { taxYear: number; intentKey: string } }>('/api/v1/reports', { preHandler: options.authenticate, schema: { body: { type: 'object', additionalProperties: false, required: ['taxYear','intentKey'], properties: { taxYear: { type: 'integer', minimum: 2009, maximum: 9999 }, intentKey: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => reply.status(201).send({ report: await options.engine.createReport(contextFor(request, request.body.intentKey), request.body.taxYear) }))
  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', { preHandler: options.authenticate }, async (request) => ({ job: await options.engine.getSyncJob(contextFor(request), request.params.jobId) }))
  app.get('/api/v1/jobs', { preHandler: options.authenticate }, async (request) => ({ items: await options.engine.listSyncJobs(contextFor(request)) }))
}
