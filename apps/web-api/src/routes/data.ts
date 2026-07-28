import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import { status as grpcStatus } from '@grpc/grpc-js'

import type { UploadAdmissionRateLimiter } from '../auth/rate-limit.js'
import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import {
  ApiError,
  rateLimitExceeded,
  resourceNotFound,
  unauthorized,
} from '../errors.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import { UploadValidationError, type UploadStore } from '../uploads/upload-store.js'

export type EngineDataClient = {
  readonly upbitPdfImportSupported?: boolean
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
  enqueueSync(context: SourceRequestContext, input: {
    sourceKind: 'UPBIT_PDF' | 'EVM_WALLET'
    sourceId: string
    requestedCoverageStart: string
    requestedCoverageEnd: string
    trigger: 'USER_REQUEST'
  }): Promise<Record<string, unknown>>
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
  listTaxReportHistory(context: SourceRequestContext, taxYear: number, limit?: number): Promise<Array<Record<string, unknown>>>
}

const unavailableEngineMethod = async (): Promise<never> => {
  throw new ApiError(
    503,
    'ENGINE_UNAVAILABLE',
    '데이터 처리 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  )
}

const unavailableEngineDataClient: EngineDataClient = {
  upbitPdfImportSupported: false,
  registerDocument: unavailableEngineMethod,
  listAllSources: unavailableEngineMethod,
  enqueueSync: unavailableEngineMethod,
  getSyncJob: unavailableEngineMethod,
  listSyncJobs: unavailableEngineMethod,
  getDashboard: unavailableEngineMethod,
  listLedgerEvents: unavailableEngineMethod,
  listReviews: unavailableEngineMethod,
  getReview: unavailableEngineMethod,
  resolveReview: unavailableEngineMethod,
  createReport: unavailableEngineMethod,
  listReports: unavailableEngineMethod,
  listTaxReportHistory: unavailableEngineMethod,
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

const mapScopedReadError = (error: unknown): never => {
  if (!(error instanceof EngineRpcError)) throw error
  if (error.grpcCode === grpcStatus.NOT_FOUND) throw resourceNotFound()
  if (error.grpcCode === grpcStatus.ALREADY_EXISTS && error.grpcDetails === 'SYNC_IDEMPOTENCY_CONFLICT') {
    throw new ApiError(409, 'SYNC_INTENT_CONFLICT', '같은 요청 키가 다른 동기화 요청에 사용되었습니다.')
  }
  if (error.grpcCode === grpcStatus.FAILED_PRECONDITION && error.grpcDetails === 'AMBIGUOUS_TAX_RESIDENCY') {
    throw new ApiError(409, 'AMBIGUOUS_TAX_RESIDENCY', '같은 과세연도에 여러 거주자 신고 자료가 있어 자동 선택할 수 없습니다.')
  }
  throw error
}

const mapLegacyReportError = (error: unknown): never => {
  if (error instanceof EngineRpcError && error.grpcCode === grpcStatus.FAILED_PRECONDITION && error.grpcDetails === 'LEGACY_REPORT_CREATION_DISABLED') {
    throw new ApiError(409, 'REPORT_GENERATION_REPLACED', '세금 엔진이 발행한 연도별 신고 결과를 이용해 주세요.')
  }
  throw error
}

const validDateRange = (start: string, end: string) => {
  const startTime = Date.parse(`${start}T00:00:00.000Z`)
  const endTime = Date.parse(`${end}T00:00:00.000Z`)
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime
}

const mapUploadValidationError = (error: unknown): never => {
  if (!(error instanceof UploadValidationError)) throw error
  if (error.code === 'ENCRYPTED_PDF') {
    throw new ApiError(422, 'ENCRYPTED_PDF', '암호화된 PDF는 등록할 수 없습니다.')
  }
  throw new ApiError(422, 'INVALID_PDF', 'PDF 파일이 손상되었거나 형식을 확인할 수 없습니다.')
}

const validExpectedPointerVersion = (value: string) => {
  if (!/^[1-9][0-9]*$/.test(value)) return false
  const pointer = BigInt(value)
  return pointer <= 9_223_372_036_854_775_806n
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const publicTaxAmount = (value: unknown) => {
  const amount = recordValue(value)
  return {
    status: amount.status,
    hasAmount: amount.hasAmount,
    ...(amount.hasAmount === true && typeof amount.amount === 'string'
      ? { amount: amount.amount }
      : {}),
  }
}

const publicTaxReport = (value: Record<string, unknown>) => {
  const counts = recordValue(value.counts)
  return {
    reportId: value.reportId,
    taxYear: value.taxYear,
    finality: value.finality,
    status: value.status,
    filingStatus: value.filingStatus,
    denominationAssetId: value.denominationAssetId,
    pointerVersion: value.pointerVersion,
    issuedAt: value.issuedAt,
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    counts: {
      disposals: counts.disposals,
      transfers: counts.transfers,
      excludedConversions: counts.excludedConversions,
      limitations: counts.limitations,
    },
    gainLoss: publicTaxAmount(value.gainLoss),
    taxableBase: publicTaxAmount(value.taxableBase),
    nationalTax: publicTaxAmount(value.nationalTax),
    localTax: publicTaxAmount(value.localTax),
    totalTax: publicTaxAmount(value.totalTax),
  }
}

const maximumUploadBytes = 20 * 1024 * 1024

const upbitPdfImportUnavailable = () =>
  new ApiError(
    503,
    'UPBIT_PDF_IMPORT_UNAVAILABLE',
    '현재 Upbit 문서 가져오기를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  )

const uploadContentLength = (header: string | string[] | undefined) => {
  if (typeof header !== 'string' || !/^[1-9][0-9]*$/.test(header)) {
    throw new ApiError(
      411,
      'CONTENT_LENGTH_REQUIRED',
      '업로드 파일 크기를 확인할 수 없습니다.',
    )
  }
  const byteLength = Number(header)
  if (!Number.isSafeInteger(byteLength) || byteLength > maximumUploadBytes) {
    throw new ApiError(
      413,
      'REQUEST_BODY_TOO_LARGE',
      '요청 본문이 허용된 크기를 초과했습니다.',
    )
  }
  return byteLength
}

const enforceUploadAdmission = (decision: {
  allowed: boolean
  retryAfterSeconds: number
}) => {
  if (!decision.allowed) {
    throw rateLimitExceeded(decision.retryAfterSeconds)
  }
}

export const registerDataRoutes = async (
  app: FastifyInstance,
  options: {
    uploadStore: UploadStore
    uploadAdmissionRateLimiter: UploadAdmissionRateLimiter
    engine?: EngineDataClient
    now?: () => Date
  },
) => {
  const now = options.now ?? (() => new Date())
  const configuredEngine = options.engine
  const engine = configuredEngine ?? unavailableEngineDataClient
  const assertUpbitPdfImport = () => {
    if (configuredEngine?.upbitPdfImportSupported !== true) {
      throw upbitPdfImportUnavailable()
    }
  }
  const requireUpbitPdfImport: onRequestHookHandler = async () => {
    assertUpbitPdfImport()
  }
  const admitUploadCreate: onRequestHookHandler = async (request) => {
    const context = contextFor(request)
    enforceUploadAdmission(
      await options.uploadAdmissionRateLimiter.consumeCreate({
        userId: context.userId,
        ip: request.ip,
      }),
    )
  }
  const admitUploadContent: onRequestHookHandler = async (request) => {
    const context = contextFor(request)
    const byteLength = uploadContentLength(request.headers['content-length'])
    enforceUploadAdmission(
      await options.uploadAdmissionRateLimiter.consumeContent({
        userId: context.userId,
        ip: request.ip,
        byteLength,
      }),
    )
  }
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

  app.post<{ Body: { filename: string; mediaType: 'application/pdf'; sizeBytes: number; intentKey: string } }>(
    '/api/v1/uploads',
    { onRequest: [requireUpbitPdfImport, admitUploadCreate], schema: { body: { type: 'object', additionalProperties: false, required: ['filename','mediaType','sizeBytes','intentKey'], properties: {
      filename: { type: 'string', minLength: 1, maxLength: 255 }, mediaType: { type: 'string', const: 'application/pdf' },
      sizeBytes: { type: 'integer', minimum: 1, maximum: maximumUploadBytes }, intentKey: { type: 'string', minLength: 1, maxLength: 200 },
    } } } },
    async (request, reply) => {
      assertUpbitPdfImport()
      const context = contextFor(request)
      const session = await options.uploadStore.create({ userId: context.userId, originalFilename: request.body.filename,
        mediaType: request.body.mediaType, expectedBytes: request.body.sizeBytes, idempotencyKey: request.body.intentKey, now: now() })
      return reply.status(201).send({
        uploadId: session.id,
        uploadUrl: `/api/v1/uploads/${session.id}/content`,
        state: session.state,
        expiresAt: session.expiresAt.toISOString(),
      })
    },
  )

  app.put<{ Params: { uploadId: string }; Body: Buffer }>(
    '/api/v1/uploads/:uploadId/content',
    { onRequest: [requireUpbitPdfImport, admitUploadContent], bodyLimit: maximumUploadBytes, schema: { params: { type: 'object', required: ['uploadId'], properties: { uploadId: { type: 'string', format: 'uuid' } } } } },
    async (request, reply) => {
      assertUpbitPdfImport()
      const context = contextFor(request)
      if (!Buffer.isBuffer(request.body)) throw resourceNotFound()
      if (request.body.byteLength !== uploadContentLength(request.headers['content-length'])) {
        throw new ApiError(
          400,
          'CONTENT_LENGTH_MISMATCH',
          '업로드 파일 크기가 요청 정보와 일치하지 않습니다.',
        )
      }
      const session = await options.uploadStore.write(context.userId, request.params.uploadId, request.body, now())
      if (!session) throw resourceNotFound()
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { uploadId: string }; Body: { coverageStart: string; coverageEnd: string } }>(
    '/api/v1/uploads/:uploadId/confirm',
    { onRequest: requireUpbitPdfImport, schema: {
      params: { type: 'object', required: ['uploadId'], properties: { uploadId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['coverageStart','coverageEnd'], properties: {
        coverageStart: { type: 'string', format: 'date' }, coverageEnd: { type: 'string', format: 'date' },
      } },
    } },
    async (request, reply) => {
      assertUpbitPdfImport()
      if (!validDateRange(request.body.coverageStart, request.body.coverageEnd)) {
        throw new ApiError(400, 'INVALID_COVERAGE_PERIOD', '문서 포함 종료일은 시작일보다 빠를 수 없습니다.')
      }
      const context = contextFor(request, `upload:${request.params.uploadId}`)
      const session = await options.uploadStore
        .confirm(context.userId, request.params.uploadId, now())
        .catch(mapUploadValidationError)
      if (!session?.verifiedDigest || session.verifiedBytes === undefined) throw resourceNotFound()
      if (!configuredEngine) {
        const discarded = await options.uploadStore.discard(context.userId, session.id)
        if (!discarded) throw new Error('Unavailable Engine upload discard failed')
        throw new ApiError(503, 'ENGINE_UNAVAILABLE', '데이터 처리 서비스를 사용할 수 없습니다.')
      }
      if (engine.upbitPdfImportSupported !== true) {
        const discarded = await options.uploadStore.discard(context.userId, session.id)
        if (!discarded) throw new Error('Unsupported PDF upload discard failed')
        throw upbitPdfImportUnavailable()
      }
      const source = await engine.registerDocument({ context, uploadId: session.id, objectKey: session.objectKey,
        artifactDigest: session.verifiedDigest, originalFilename: session.originalFilename,
        mediaType: session.mediaType, byteLength: session.verifiedBytes,
        coverageStart: request.body.coverageStart, coverageEnd: request.body.coverageEnd })
      const job = await engine.enqueueSync({ ...context, idempotencyKey: `sync:${session.id}` }, {
        sourceKind: 'UPBIT_PDF', sourceId: String(source.id),
        requestedCoverageStart: request.body.coverageStart, requestedCoverageEnd: request.body.coverageEnd,
        trigger: 'USER_REQUEST',
      })
      return reply.status(201).send({ source, job })
    },
  )

  app.post<{ Body: {
    sourceKind: 'UPBIT_PDF' | 'EVM_WALLET'
    sourceId: string
    coverageStart: string
    coverageEnd: string
    trigger: 'USER_REQUEST'
    intentKey: string
  } }>('/api/v1/syncs', {
    schema: { body: { type: 'object', additionalProperties: false, required: [
      'sourceKind', 'sourceId', 'coverageStart', 'coverageEnd', 'trigger', 'intentKey',
    ], properties: {
      sourceKind: { type: 'string', enum: ['UPBIT_PDF', 'EVM_WALLET'] },
      sourceId: { type: 'string', format: 'uuid' },
      coverageStart: { type: 'string', format: 'date' },
      coverageEnd: { type: 'string', format: 'date' },
      trigger: { type: 'string', const: 'USER_REQUEST' },
      intentKey: { type: 'string', minLength: 1, maxLength: 200 },
    } } },
  }, async (request, reply) => {
    if (
      request.body.sourceKind === 'UPBIT_PDF' &&
      configuredEngine?.upbitPdfImportSupported !== true
    ) {
      throw upbitPdfImportUnavailable()
    }
    if (!validDateRange(request.body.coverageStart, request.body.coverageEnd)) {
      throw new ApiError(400, 'INVALID_SYNC_PERIOD', '동기화 종료일은 시작일보다 빠를 수 없습니다.')
    }
    try {
      const job = await engine.enqueueSync(contextFor(request, request.body.intentKey), {
        sourceKind: request.body.sourceKind,
        sourceId: request.body.sourceId,
        requestedCoverageStart: request.body.coverageStart,
        requestedCoverageEnd: request.body.coverageEnd,
        trigger: request.body.trigger,
      })
      return reply.status(201).send({ job })
    } catch (error) {
      return mapScopedReadError(error)
    }
  })

  app.get<{ Querystring: { taxYear: number } }>('/api/v1/dashboard', { schema: { querystring: taxYearQuery } },
    async (request) => ({ dashboard: await engine.getDashboard(contextFor(request), Number(request.query.taxYear)) }))

  const listEvents = async (request: { id: string; authSession: SessionRecord | undefined; query: { taxYear: number; limit?: number } }) => ({
    items: await engine.listLedgerEvents(contextFor(request), Number(request.query.taxYear), Number(request.query.limit ?? 100)),
  })
  const eventQuery = { ...taxYearQuery, properties: { ...taxYearQuery.properties, limit: { type: 'integer', minimum: 1, maximum: 200 } } } as const
  app.get<{ Querystring: { taxYear: number; limit?: number } }>('/api/v1/activities', { schema: { querystring: eventQuery } }, listEvents)
  app.get<{ Querystring: { taxYear: number; limit?: number } }>('/api/v1/ledger', { schema: { querystring: eventQuery } }, listEvents)

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/v1/reviews', {
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
      const page = await engine.listReviews(
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
    schema: { params: { type: 'object', additionalProperties: false, required: ['reviewId'], properties: {
      reviewId: { type: 'string', minLength: 1, maxLength: 256 },
    } } },
  }, async (request) => {
    try {
      return { review: await engine.getReview(contextFor(request), request.params.reviewId) }
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
      const result = await engine.resolveReview(contextFor(request, request.body.intentKey), {
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
  app.get<{ Querystring: { taxYear: number } }>('/api/v1/reports', { schema: { querystring: taxYearQuery } },
    async (request) => ({ items: await engine.listReports(contextFor(request), Number(request.query.taxYear)) }))
  app.post<{ Body: { taxYear: number; intentKey: string } }>('/api/v1/reports', { schema: { body: { type: 'object', additionalProperties: false, required: ['taxYear','intentKey'], properties: { taxYear: { type: 'integer', minimum: 2009, maximum: 9999 }, intentKey: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      try {
        return reply.status(201).send({ report: await engine.createReport(contextFor(request, request.body.intentKey), request.body.taxYear) })
      } catch (error) {
        return mapLegacyReportError(error)
      }
    })
  app.get<{ Params: { taxYear: string }; Querystring: { limit?: number } }>('/api/v1/tax-reports/:taxYear/history', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['taxYear'], properties: {
        taxYear: { type: 'string', pattern: '^(202[7-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$' },
      } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    },
  }, async (request) => ({
    items: (await engine.listTaxReportHistory(
      contextFor(request), Number(request.params.taxYear), Number(request.query.limit ?? 20),
    )).map(publicTaxReport),
  }))
  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request) => ({ job: await engine.getSyncJob(contextFor(request), request.params.jobId) }))
  app.get('/api/v1/jobs', async (request) => ({ items: await engine.listSyncJobs(contextFor(request)) }))
}
