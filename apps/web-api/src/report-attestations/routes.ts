import type {
  FastifyInstance,
  FastifyRequest,
} from 'fastify'

import {
  ApiError,
  rateLimitExceeded,
  resourceNotFound,
  unauthorized,
} from '../errors.js'
import { MOCK_REPORT_ID } from './mock-publication-source.js'
import {
  ReportAttestationPublicationIneligibleError,
  reportAttestationEligibilityCheckCodes,
  type ReportAttestationPublicationSource,
} from './publication-source.js'
import type { ReportAttestationWriteRateLimiter } from './write-rate-limit.js'
import {
  ReportAttestationConflictError,
  LocalReportFixtureUnavailableError,
  ReportAttestationPreparationError,
  ReportAttestationService,
  ReportAttestationServiceClosedError,
} from './service.js'

const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const

const redactedExecutionResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'transactionHash', 'attestationUID', 'reasonCode'],
  properties: {
    status: { type: 'string' },
    transactionHash: nullableString,
    attestationUID: nullableString,
    reasonCode: nullableString,
  },
} as const

const nullableExecutionResultSchema = {
  anyOf: [redactedExecutionResultSchema, { type: 'null' }],
} as const

const statusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reportId',
    'lifecycle',
    'submission',
    'review',
    'failureCode',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    reportId: { type: 'string' },
    lifecycle: {
      type: 'string',
      enum: [
        'PREPARING',
        'PREPARED',
        'PREPARATION_FAILED',
        'SUBMISSION_QUEUED',
        'SUBMITTING',
        'SUBMITTED',
        'SUBMISSION_FAILED',
        'REVIEW_QUEUED',
        'REVIEWING',
        'APPROVED',
        'REJECTED',
        'PENDING',
        'MANUAL_REVIEW',
        'RETRY_REQUIRED',
        'RECONCILIATION_REQUIRED',
        'REVIEW_FAILED',
      ],
    },
    submission: nullableExecutionResultSchema,
    review: nullableExecutionResultSchema,
    failureCode: nullableString,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

const verificationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reportId', 'lifecycle', 'result', 'reasonCode'],
  properties: {
    reportId: { type: 'string' },
    lifecycle: statusResponseSchema.properties.lifecycle,
    result: {
      type: 'string',
      enum: ['USABLE', 'UNUSABLE', 'VERIFY_FAILED'],
    },
    reasonCode: nullableString,
  },
} as const

const eligibilityCheckCodes = [
  ...reportAttestationEligibilityCheckCodes,
  'ONCHAIN_RUNTIME',
] as const

export type ReportAttestationEligibilityResponse = Readonly<{
  reportId: string
  eligible: boolean
  checks: ReadonlyArray<{
    code: (typeof eligibilityCheckCodes)[number]
    status: 'PASSED' | 'FAILED'
  }>
}>

const eligibilityResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reportId', 'eligible', 'checks'],
  properties: {
    reportId: { type: 'string' },
    eligible: { type: 'boolean' },
    checks: {
      type: 'array',
      minItems: eligibilityCheckCodes.length,
      maxItems: eligibilityCheckCodes.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'status'],
        properties: {
          code: { type: 'string', enum: eligibilityCheckCodes },
          status: { type: 'string', enum: ['PASSED', 'FAILED'] },
        },
      },
    },
  },
} as const

const reportParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reportId'],
  properties: {
    reportId: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const

const emptyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  maxProperties: 0,
} as const

const assertAuthenticatedOwner = (request: FastifyRequest) => {
  const session = request.authSession
  if (!session) {
    throw unauthorized()
  }
  return session.user.id
}

const assertEmptyBody = (body: unknown) => {
  if (
    body !== undefined &&
    (typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0)
  ) {
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      '요청 본문은 비어 있어야 합니다.',
    )
  }
}

const mapServiceError = (error: unknown): never => {
  if (error instanceof ApiError) {
    throw error
  }
  if (error instanceof ReportAttestationServiceClosedError) {
    throw new ApiError(
      503,
      'REPORT_ATTESTATION_RUNTIME_UNAVAILABLE',
      '보고서 증명 실행 환경을 사용할 수 없습니다.',
    )
  }
  if (error instanceof LocalReportFixtureUnavailableError) {
    throw new ApiError(
      409,
      'LOCAL_FIXTURE_UNAVAILABLE',
      '로컬 보고서 fixture를 사용할 수 없습니다.',
    )
  }
  if (error instanceof ReportAttestationPreparationError) {
    throw new ApiError(
      503,
      'REPORT_ATTESTATION_PREPARATION_FAILED',
      '보고서 증명 자료를 준비하지 못했습니다.',
    )
  }
  if (error instanceof ReportAttestationPublicationIneligibleError) {
    throw new ApiError(
      409,
      'REPORT_ATTESTATION_NOT_ELIGIBLE',
      '현재 장부의 증빙 준비 상태를 다시 확인해 주세요.',
    )
  }
  if (error instanceof ReportAttestationConflictError) {
    if (error.code === 'NOT_PREPARED') {
      throw resourceNotFound()
    }
    throw new ApiError(
      409,
      error.code === 'NOT_SUBMITTED'
        ? 'REPORT_ATTESTATION_NOT_SUBMITTED'
        : error.code === 'PUBLICATION_CHANGED'
          ? 'REPORT_ATTESTATION_PUBLICATION_CHANGED'
          : 'REPORT_ATTESTATION_ALREADY_STARTED',
      error.code === 'NOT_SUBMITTED'
        ? '보고서 제출 증명이 아직 완료되지 않았습니다.'
        : error.code === 'PUBLICATION_CHANGED'
          ? '준비 후 보고서가 변경되어 다시 확인해야 합니다.'
          : '보고서 증명 작업이 이미 시작되었습니다.',
    )
  }
  throw new ApiError(
    503,
    'REPORT_ATTESTATION_RUNTIME_UNAVAILABLE',
    '보고서 증명 실행 환경을 사용할 수 없습니다.',
  )
}

export const registerReportAttestationRoutes = async (
  app: FastifyInstance,
  options: {
    service: ReportAttestationService
    publicationSource: ReportAttestationPublicationSource
    devRoutesEnabled?: boolean
    automaticReview?: boolean
    writeRateLimiter?: ReportAttestationWriteRateLimiter
    runtimeReady?: () => Promise<boolean>
  },
) => {
  const loadEligibility = async (
    ownerId: string,
    reportId: string,
  ): Promise<ReportAttestationEligibilityResponse> => {
    const sourceEligibility =
      await options.publicationSource.getEligibility(ownerId, reportId)
    if (!sourceEligibility || sourceEligibility.reportId !== reportId) {
      throw resourceNotFound()
    }
    const sourceCodes = new Set(
      sourceEligibility.checks.map((check) => check.code),
    )
    if (
      sourceEligibility.checks.length !==
        reportAttestationEligibilityCheckCodes.length ||
      sourceCodes.size !== reportAttestationEligibilityCheckCodes.length ||
      reportAttestationEligibilityCheckCodes.some(
        (code) => !sourceCodes.has(code),
      ) ||
      sourceEligibility.eligible !== sourceEligibility.checks.every(
        (check) => check.status === 'PASSED',
      )
    ) {
      throw new Error('Invalid report attestation eligibility response')
    }
    let runtimeReady = true
    try {
      runtimeReady = await (options.runtimeReady?.() ?? Promise.resolve(true))
    } catch {
      runtimeReady = false
    }
    const checks: ReportAttestationEligibilityResponse['checks'] = [
      ...sourceEligibility.checks,
      {
        code: 'ONCHAIN_RUNTIME',
        status: runtimeReady ? 'PASSED' : 'FAILED',
      },
    ]
    return {
      reportId,
      eligible:
        sourceEligibility.eligible &&
        checks.every((check) => check.status === 'PASSED'),
      checks,
    }
  }

  const assertEligible = async (
    ownerId: string,
    reportId: string,
  ) => {
    const eligibility = await loadEligibility(ownerId, reportId)
    if (!eligibility.eligible) {
      throw new ReportAttestationPublicationIneligibleError()
    }
  }

  const preparePublication = async (
    ownerId: string,
    reportId: string,
  ) => {
    await assertEligible(ownerId, reportId)
    const publication = await options.publicationSource.getPublication(
      ownerId,
      reportId,
    )
    if (!publication || publication.reportId !== reportId) {
      throw resourceNotFound()
    }
    return options.service.preparePublication(ownerId, publication)
  }

  app.get<{ Params: { reportId: string } }>(
    '/api/v1/reports/:reportId/attestation-eligibility',
    {
      schema: {
        params: reportParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: eligibilityResponseSchema },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const ownerId = assertAuthenticatedOwner(request)
      try {
        return await loadEligibility(ownerId, request.params.reportId)
      } catch (error) {
        return mapServiceError(error)
      }
    },
  )

  const consumeWrite = async (
    request: FastifyRequest,
    ownerId: string,
  ) => {
    const decision = await options.writeRateLimiter?.consume({
      userId: ownerId,
      ip: request.ip,
      action: 'SUBMIT',
    })
    if (decision && !decision.allowed) {
      throw rateLimitExceeded(decision.retryAfterSeconds)
    }
  }

  if (options.devRoutesEnabled === true) {
    app.post<{ Body: unknown }>(
      '/api/v1/dev/reports/attestation-fixture',
      {
        schema: {
          querystring: emptyQuerySchema,
          response: { 201: statusResponseSchema },
        },
      },
      async (request, reply) => {
        assertEmptyBody(request.body)
        const ownerId = assertAuthenticatedOwner(request)
        try {
          const status = await preparePublication(
            ownerId,
            MOCK_REPORT_ID,
          )
          return reply.status(201).send(status)
        } catch (error) {
          return mapServiceError(error)
        }
      },
    )
  }

  app.post<{
    Params: { reportId: string }
    Body: unknown
  }>(
    '/api/v1/reports/:reportId/attestation-preparation',
    {
      schema: {
        params: reportParamsSchema,
        querystring: emptyQuerySchema,
        response: { 201: statusResponseSchema },
      },
    },
    async (request, reply) => {
      assertEmptyBody(request.body)
      const ownerId = assertAuthenticatedOwner(request)
      try {
        const status = await preparePublication(
          ownerId,
          request.params.reportId,
        )
        return reply.status(201).send(status)
      } catch (error) {
        return mapServiceError(error)
      }
    },
  )

  app.post<{
    Params: { reportId: string }
    Body: unknown
  }>(
    '/api/v1/reports/:reportId/attestations',
    {
      schema: {
        params: reportParamsSchema,
        querystring: emptyQuerySchema,
        response: { 202: statusResponseSchema },
      },
    },
    async (request, reply) => {
      assertEmptyBody(request.body)
      const ownerId = assertAuthenticatedOwner(request)
      try {
        await assertEligible(ownerId, request.params.reportId)
        const currentPublication =
          await options.publicationSource.getPublication(
            ownerId,
            request.params.reportId,
          )
        if (
          !currentPublication ||
          currentPublication.reportId !== request.params.reportId
        ) {
          throw resourceNotFound()
        }
        await consumeWrite(request, ownerId)
        const status = options.automaticReview
          ? await options.service.queueSubmissionAndReview(
              ownerId,
              request.params.reportId,
              currentPublication,
            )
          : await options.service.queueSubmission(
              ownerId,
              request.params.reportId,
              currentPublication,
            )
        return reply.status(202).send(status)
      } catch (error) {
        return mapServiceError(error)
      }
    },
  )

  if (options.devRoutesEnabled === true) {
    app.post<{
      Params: { reportId: string }
      Body: unknown
    }>(
      '/api/v1/dev/reports/:reportId/attestation-review',
      {
        schema: {
          params: reportParamsSchema,
          querystring: emptyQuerySchema,
          response: { 202: statusResponseSchema },
        },
      },
      async (request, reply) => {
        assertEmptyBody(request.body)
        const ownerId = assertAuthenticatedOwner(request)
        try {
          const status = await options.service.queueReview(
            ownerId,
            request.params.reportId,
          )
          return reply.status(202).send(status)
        } catch (error) {
          return mapServiceError(error)
        }
      },
    )
  }

  app.get<{ Params: { reportId: string } }>(
    '/api/v1/reports/:reportId/attestation',
    {
      schema: {
        params: reportParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: statusResponseSchema },
      },
    },
    async (request) => {
      const ownerId = assertAuthenticatedOwner(request)
      const status = await options.service.getStatus(
        ownerId,
        request.params.reportId,
      )
      if (!status) {
        throw resourceNotFound()
      }
      return status
    },
  )

  app.get<{ Params: { reportId: string } }>(
    '/api/v1/reports/:reportId/verification',
    {
      schema: {
        params: reportParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: verificationResponseSchema },
      },
    },
    async (request) => {
      const ownerId = assertAuthenticatedOwner(request)
      const verification = await options.service.verify(
        ownerId,
        request.params.reportId,
      )
      if (!verification) {
        throw resourceNotFound()
      }
      return verification
    },
  )
}
