import type {
  FastifyInstance,
  FastifyRequest,
} from 'fastify'

import {
  ApiError,
  rateLimitExceeded,
  unauthorized,
} from '../errors.js'
import {
  ReportAttestationConflictError,
  ReportAttestationPreparationError,
  ReportAttestationService,
  ReportAttestationServiceClosedError,
} from './service.js'
import type { ReportAttestationPublicationSource } from './publication-source.js'
import {
  SYNTHETIC_TESTNET_REPORT_ID,
  SYNTHETIC_TESTNET_REPORT_SUMMARY,
} from './synthetic-testnet-publication-source.js'
import type {
  ReportAttestationStatus,
  ReportVerification,
} from './types.js'
import type { ReportAttestationWriteRateLimiter } from './write-rate-limit.js'

const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const

export type SyntheticReportAttestationCapabilityDescriptor =
  | Readonly<{
      network: 'eip155:91342'
      mode: 'SYNTHETIC_TESTNET'
      explorerBaseUrl: 'https://sepolia-explorer.giwa.io'
    }>
  | Readonly<{
      network: 'eip155:31337'
      mode: 'LOCAL_ANVIL'
      explorerBaseUrl: null
    }>

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

const lifecycleSchema = {
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
} as const

const publicStatusSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'lifecycle',
    'submission',
    'review',
    'failureCode',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    lifecycle: lifecycleSchema,
    submission: {
      anyOf: [redactedExecutionResultSchema, { type: 'null' }],
    },
    review: {
      anyOf: [redactedExecutionResultSchema, { type: 'null' }],
    },
    failureCode: nullableString,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

const publicVerificationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lifecycle', 'result', 'reasonCode'],
  properties: {
    lifecycle: lifecycleSchema,
    result: {
      type: 'string',
      enum: ['USABLE', 'UNUSABLE', 'VERIFY_FAILED'],
    },
    reasonCode: nullableString,
  },
} as const

const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['capability', 'fixture', 'status', 'verification'],
  properties: {
    capability: {
      type: 'object',
      additionalProperties: false,
      required: [
        'enabled',
        'network',
        'mode',
        'explorerBaseUrl',
        'reasonCode',
      ],
      properties: {
        enabled: { type: 'boolean' },
        network: {
          type: 'string',
          enum: ['eip155:91342', 'eip155:31337'],
        },
        mode: {
          type: 'string',
          enum: ['SYNTHETIC_TESTNET', 'LOCAL_ANVIL'],
        },
        explorerBaseUrl: nullableString,
        reasonCode: nullableString,
      },
    },
    fixture: {
      type: 'object',
      additionalProperties: false,
      required: [
        'taxYear',
        'transactionCount',
        'completeCount',
        'exceptionCount',
        'denomination',
      ],
      properties: {
        taxYear: { type: 'integer' },
        transactionCount: { type: 'integer' },
        completeCount: { type: 'integer' },
        exceptionCount: { type: 'integer' },
        denomination: { type: 'string' },
      },
    },
    status: {
      anyOf: [publicStatusSchema, { type: 'null' }],
    },
    verification: {
      anyOf: [publicVerificationSchema, { type: 'null' }],
    },
  },
} as const

const emptyRequestSchema = {
  type: 'object',
  additionalProperties: false,
  maxProperties: 0,
} as const

const assertAuthenticatedOwner = (request: FastifyRequest) => {
  const session = request.authSession
  if (!session) throw unauthorized()
  return session.user.id
}

const publicStatus = (
  status: ReportAttestationStatus | undefined,
) => {
  if (!status) return null
  const { reportId: _reportId, ...safeStatus } = status
  return safeStatus
}

const publicVerification = (
  verification: ReportVerification | undefined,
) => {
  if (!verification) return null
  const { reportId: _reportId, ...safeVerification } = verification
  return safeVerification
}

const verifiableLifecycle = new Set([
  'APPROVED',
  'REJECTED',
])
const submissionEnqueueLifecycles = new Set([
  'PREPARED',
  'PENDING',
  'RETRY_REQUIRED',
])
const reviewEnqueueLifecycles = new Set([
  'SUBMITTED',
  'PENDING',
  'RETRY_REQUIRED',
])
const VERIFICATION_CACHE_TTL_MS = 15_000
const MAX_VERIFICATION_CACHE_ENTRIES = 1_000

type VerificationCacheEntry = {
  stateKey: string
  expiresAt: number
  verification: ReportVerification
}

export const registerSyntheticReportAttestationRoutes = async (
  app: FastifyInstance,
  options: {
    enabled: boolean
    reconciliationEnabled: boolean
    disabledReasonCode: string | null
    capability: SyntheticReportAttestationCapabilityDescriptor
    service?: ReportAttestationService
    publicationSource?: ReportAttestationPublicationSource
    writeRateLimiter?: ReportAttestationWriteRateLimiter
  },
) => {
  if (
    options.enabled &&
    (!options.service || !options.publicationSource)
  ) {
    throw new Error(
      'Synthetic report attestation capability requires a service and publication source',
    )
  }

  const capability = Object.freeze({
    enabled: options.enabled,
    ...options.capability,
    reasonCode: options.enabled
      ? null
      : options.disabledReasonCode ?? 'WRITER_NOT_CONFIGURED',
  })
  const verificationCache = new Map<
    string,
    VerificationCacheEntry
  >()

  const cachedVerification = async (
    ownerId: string,
    status: ReportAttestationStatus,
  ) => {
    const stateKey = [
      status.lifecycle,
      status.updatedAt,
      status.submission?.attestationUID ?? '',
      status.review?.attestationUID ?? '',
    ].join(':')
    const now = Date.now()
    const cached = verificationCache.get(ownerId)
    if (
      cached &&
      cached.stateKey === stateKey &&
      cached.expiresAt > now
    ) {
      return cached.verification
    }
    const verification = await options.service?.verify(
      ownerId,
      SYNTHETIC_TESTNET_REPORT_ID,
    )
    if (!verification) return undefined
    if (
      !verificationCache.has(ownerId) &&
      verificationCache.size >= MAX_VERIFICATION_CACHE_ENTRIES
    ) {
      const oldestOwnerId =
        verificationCache.keys().next().value
      if (oldestOwnerId) {
        verificationCache.delete(oldestOwnerId)
      }
    }
    verificationCache.delete(ownerId)
    verificationCache.set(ownerId, {
      stateKey,
      expiresAt: now + VERIFICATION_CACHE_TTL_MS,
      verification,
    })
    return verification
  }

  const snapshot = async (ownerId: string) => {
    const status = options.service
      ? await options.service.getStatus(
          ownerId,
          SYNTHETIC_TESTNET_REPORT_ID,
        )
      : undefined
    const verification =
      status && verifiableLifecycle.has(status.lifecycle)
        ? await cachedVerification(ownerId, status)
        : undefined
    return {
      capability,
      fixture: SYNTHETIC_TESTNET_REPORT_SUMMARY,
      status: publicStatus(status),
      verification: publicVerification(verification),
    }
  }

  const assertServiceAvailable = () => {
    if (!options.enabled || !options.service) {
      throw new ApiError(
        503,
        'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
        'GIWA Sepolia 증명 쓰기 기능을 현재 사용할 수 없습니다.',
      )
    }
    return options.service
  }

  const assertWritable = () => {
    const service = assertServiceAvailable()
    if (!options.publicationSource) {
      throw new ApiError(
        503,
        'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
        'GIWA Sepolia 증명 쓰기 기능을 현재 사용할 수 없습니다.',
      )
    }
    return {
      service,
      publicationSource: options.publicationSource,
    }
  }

  const consumeWrite = async (
    request: FastifyRequest,
    ownerId: string,
    action: 'SUBMIT' | 'REVIEW',
  ) => {
    const decision = await options.writeRateLimiter?.consume({
      userId: ownerId,
      ip: request.ip,
      action,
    })
    if (decision && !decision.allowed) {
      throw rateLimitExceeded(decision.retryAfterSeconds)
    }
  }

  app.get(
    '/api/v1/report-attestations/synthetic-publication',
    {
      schema: {
        querystring: emptyRequestSchema,
        response: { 200: snapshotSchema },
      },
    },
    async (request) => snapshot(assertAuthenticatedOwner(request)),
  )

  app.post(
    '/api/v1/report-attestations/synthetic-publication/reconcile',
    {
      schema: {
        querystring: emptyRequestSchema,
        response: { 200: snapshotSchema },
      },
    },
    async (request) => {
      const ownerId = assertAuthenticatedOwner(request)
      if (options.enabled && !options.reconciliationEnabled) {
        throw new ApiError(
          503,
          'REPORT_ATTESTATION_RECONCILIATION_NOT_READY',
          '현재 증명 상태 확인 기능을 준비 중입니다.',
        )
      }
      try {
        if (options.enabled && options.service) {
          await options.service.reconcileReview(
            ownerId,
            SYNTHETIC_TESTNET_REPORT_ID,
          )
        }
        return snapshot(ownerId)
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError(
          503,
          'REPORT_ATTESTATION_RECONCILIATION_UNAVAILABLE',
          '현재 증명 상태를 다시 확인하지 못했습니다.',
        )
      }
    },
  )

  app.post(
    '/api/v1/report-attestations/synthetic-publication/submission',
    {
      schema: {
        querystring: emptyRequestSchema,
        response: { 200: snapshotSchema },
      },
    },
    async (request) => {
      const ownerId = assertAuthenticatedOwner(request)
      const { service, publicationSource } = assertWritable()
      try {
        let status = await service.getStatus(
          ownerId,
          SYNTHETIC_TESTNET_REPORT_ID,
        )
        if (
          !status ||
          status.lifecycle === 'PREPARATION_FAILED'
        ) {
          const publication = await publicationSource.getPublication(
            ownerId,
            SYNTHETIC_TESTNET_REPORT_ID,
          )
          if (!publication) {
            throw new ReportAttestationPreparationError()
          }
          status = await service.preparePublication(ownerId, publication)
        }
        if (
          submissionEnqueueLifecycles.has(status.lifecycle) &&
          status.submission?.status !== 'CONFIRMED'
        ) {
          await consumeWrite(request, ownerId, 'SUBMIT')
          await service.queueSubmission(
            ownerId,
            SYNTHETIC_TESTNET_REPORT_ID,
          )
        }
        return snapshot(ownerId)
      } catch (error) {
        if (error instanceof ApiError) {
          throw error
        }
        if (error instanceof ReportAttestationConflictError) {
          throw new ApiError(
            409,
            error.code === 'NOT_SUBMITTED'
              ? 'REPORT_ATTESTATION_NOT_SUBMITTED'
              : 'REPORT_ATTESTATION_ALREADY_STARTED',
            error.code === 'NOT_SUBMITTED'
              ? '보고서 제출 증명이 아직 완료되지 않았습니다.'
              : '보고서 증명 작업이 이미 시작되었습니다.',
          )
        }
        if (error instanceof ReportAttestationPreparationError) {
          throw new ApiError(
            503,
            'REPORT_ATTESTATION_PREPARATION_FAILED',
            '합성 장부 증명 입력을 준비하지 못했습니다.',
          )
        }
        if (error instanceof ReportAttestationServiceClosedError) {
          throw new ApiError(
            503,
            'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
            'GIWA Sepolia 증명 쓰기 기능을 현재 사용할 수 없습니다.',
          )
        }
        throw new ApiError(
          503,
          'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
          'GIWA Sepolia 증명 쓰기 기능을 현재 사용할 수 없습니다.',
        )
      }
    },
  )

  app.post(
    '/api/v1/report-attestations/synthetic-publication/review',
    {
      schema: {
        querystring: emptyRequestSchema,
        response: { 200: snapshotSchema },
      },
    },
    async (request) => {
      const ownerId = assertAuthenticatedOwner(request)
      const { service } = assertWritable()
      try {
        const status = await service.getStatus(
          ownerId,
          SYNTHETIC_TESTNET_REPORT_ID,
        )
        if (
          status &&
          reviewEnqueueLifecycles.has(status.lifecycle) &&
          status.submission?.status === 'CONFIRMED'
        ) {
          await consumeWrite(request, ownerId, 'REVIEW')
        }
        await service.queueReview(
          ownerId,
          SYNTHETIC_TESTNET_REPORT_ID,
        )
        return snapshot(ownerId)
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (error instanceof ReportAttestationConflictError) {
          throw new ApiError(
            error.code === 'NOT_PREPARED' ? 404 : 409,
            error.code === 'NOT_PREPARED'
              ? 'REPORT_ATTESTATION_NOT_FOUND'
              : 'REPORT_ATTESTATION_NOT_SUBMITTED',
            error.code === 'NOT_PREPARED'
              ? '먼저 장부를 생성하고 제출해 주세요.'
              : '보고서 제출 증명이 아직 완료되지 않았습니다.',
          )
        }
        throw new ApiError(
          503,
          'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
          'GIWA Sepolia 증명 쓰기 기능을 현재 사용할 수 없습니다.',
        )
      }
    },
  )
}
