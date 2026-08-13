import type { FastifyInstance } from 'fastify'

import { ApiError, resourceNotFound, unauthorized } from '../errors.js'
import {
  AmbiguousCurrentTaxReportError,
  CorrectionPendingError,
  InconsistentTaxReportGenerationStatusError,
  InconsistentTaxReportError,
} from '../tax-report/postgres-tax-report-reader.js'
import type {
  CurrentTaxReport,
  TaxAmount,
  TaxReportFinality,
  TaxReportGenerationStatus,
  TaxReportGenerationStatusReader,
  TaxReportReader,
} from '../tax-report/types.js'

type TaxReportRoutesOptions = {
  reader: TaxReportReader
  statusReader?: TaxReportGenerationStatusReader
}

const amountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'hasAmount'],
  properties: {
    status: { type: 'string', enum: ['KNOWN', 'UNKNOWN'] },
    hasAmount: { type: 'boolean' },
    amount: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' },
  },
} as const

const reportResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reportId', 'taxYear', 'finality', 'status', 'filingStatus',
    'denominationAssetId', 'pointerVersion', 'issuedAt', 'counts',
    'gainLoss', 'taxableBase', 'nationalTax', 'localTax', 'totalTax',
  ],
  properties: {
    reportId: { type: 'string' },
    taxYear: { type: 'integer', minimum: 2025, maximum: 9999 },
    finality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    status: { type: 'string', enum: ['FINAL', 'PARTIAL'] },
    filingStatus: { type: 'string', enum: ['READY', 'BLOCKED'] },
    denominationAssetId: { type: 'string' },
    pointerVersion: { type: 'integer', minimum: 1 },
    issuedAt: { type: 'string', format: 'date-time' },
    counts: {
      type: 'object', additionalProperties: false,
      required: ['disposals', 'transfers', 'excludedConversions', 'limitations'],
      properties: {
        disposals: { type: 'integer', minimum: 0 }, transfers: { type: 'integer', minimum: 0 },
        excludedConversions: { type: 'integer', minimum: 0 }, limitations: { type: 'integer', minimum: 0 },
      },
    },
    gainLoss: amountSchema,
    taxableBase: amountSchema,
    nationalTax: amountSchema,
    localTax: amountSchema,
    totalTax: amountSchema,
  },
} as const

const generationStatusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'generationId',
    'state',
    'taxYear',
    'finality',
    'pointerVersion',
    'outcome',
    'periodStart',
    'periodEnd',
    'coverageFrom',
    'coverageThrough',
    'calculatedAsOf',
    'coverageStatus',
    'coverageAssurance',
    'taxYearCloseStatus',
    'sourceCoverageIntervalCount',
    'sourceCoverageSummaryStatus',
    'sourceCoverage',
    'createdAt',
    'completedAt',
    'failedAt',
    'failureCode',
    'blockedReasonCode',
    'hasCurrentReport',
  ],
  properties: {
    generationId: {
      anyOf: [
        { type: 'string', pattern: '^[a-f0-9]{64}$' },
        { type: 'null' },
      ],
    },
    state: {
      type: 'string',
      enum: [
        'NOT_STARTED',
        'BUILDING',
        'ACTIVE',
        'REVIEW_REQUIRED',
        'FAILED',
        'SUPERSEDED',
      ],
    },
    taxYear: { type: 'integer', minimum: 2025, maximum: 2027 },
    finality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    pointerVersion: { type: 'integer', minimum: 0 },
    outcome: {
      anyOf: [
        { type: 'string', enum: ['REPORT', 'NO_TAX_EVENTS'] },
        { type: 'null' },
      ],
    },
    periodStart: { type: 'string', format: 'date' },
    periodEnd: { type: 'string', format: 'date' },
    coverageFrom: {
      anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
    },
    coverageThrough: {
      anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
    },
    calculatedAsOf: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    coverageStatus: {
      type: 'string',
      enum: ['UNKNOWN', 'PARTIAL', 'COMPLETE'],
    },
    coverageAssurance: {
      type: 'string',
      enum: [
        'UNKNOWN',
        'USER_DECLARED',
        'DOCUMENT_METADATA_VERIFIED',
        'CHAIN_VERIFIED',
      ],
    },
    taxYearCloseStatus: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    sourceCoverageIntervalCount: { type: 'integer', minimum: 0 },
    sourceCoverageSummaryStatus: {
      type: 'string',
      enum: ['UNKNOWN', 'PARTIAL', 'COMPLETE'],
    },
    sourceCoverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceKind',
          'systemName',
          'declaredFrom',
          'declaredThrough',
          'completeness',
          'assurance',
        ],
        properties: {
          sourceKind: { type: 'string', enum: ['API', 'FILE', 'MANUAL', 'OTHER'] },
          systemName: { type: 'string' },
          declaredFrom: {
            anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
          },
          declaredThrough: {
            anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
          },
          completeness: {
            type: 'string', enum: ['UNKNOWN', 'PARTIAL', 'COMPLETE'],
          },
          assurance: {
            type: 'string',
            enum: [
              'UNKNOWN', 'USER_DECLARED',
              'DOCUMENT_METADATA_VERIFIED', 'CHAIN_VERIFIED',
            ],
          },
        },
      },
    },
    createdAt: {
      anyOf: [
        { type: 'string', format: 'date-time' },
        { type: 'null' },
      ],
    },
    completedAt: {
      anyOf: [
        { type: 'string', format: 'date-time' },
        { type: 'null' },
      ],
    },
    failedAt: {
      anyOf: [
        { type: 'string', format: 'date-time' },
        { type: 'null' },
      ],
    },
    failureCode: {
      anyOf: [
        { type: 'string', pattern: '^[A-Z0-9_]{1,64}$' },
        { type: 'null' },
      ],
    },
    blockedReasonCode: {
      anyOf: [
        {
          type: 'string',
          enum: [
            'NOT_STARTED',
            'APPLICATION_PENDING',
            'GENERATION_BUILDING',
            'GENERATION_FAILED',
            'GENERATION_NOT_ACTIVE',
            'LEDGER_STALE',
            'SOURCE_COVERAGE_INVALID',
            'TAX_RESULT_STALE',
            'REVIEW_REQUIRED',
            'GENERATION_INCOMPLETE',
            'NO_TAX_EVENTS',
            'REPORT_NOT_CURRENT',
          ],
        },
        { type: 'null' },
      ],
    },
    hasCurrentReport: { type: 'boolean' },
  },
} as const

const publicAmount = (amount: TaxAmount) => {
  const hasAmount = amount.status === 'KNOWN' && typeof amount.amount === 'string'
  return {
    status: amount.status,
    hasAmount,
    ...(hasAmount ? { amount: amount.amount } : {}),
  }
}

const publicReport = (report: CurrentTaxReport) => ({
  reportId: report.reportId,
  taxYear: report.taxYear,
  finality: report.finality,
  status: report.status,
  filingStatus: report.filingStatus,
  denominationAssetId: report.denominationAssetId,
  pointerVersion: report.pointerVersion,
  issuedAt: report.issuedAt,
  counts: report.counts,
  gainLoss: publicAmount(report.summary.gainLoss),
  taxableBase: publicAmount(report.summary.taxableBase),
  nationalTax: publicAmount(report.summary.nationalTax),
  localTax: publicAmount(report.summary.localTax),
  totalTax: publicAmount(report.summary.totalTax),
})

const publicGenerationStatus = (
  status: TaxReportGenerationStatus | undefined,
  taxYear: 2025 | 2026 | 2027,
  finality: TaxReportFinality,
) => {
  const value = status ?? {
    generationId: null,
    state: 'NOT_STARTED' as const,
    taxYear,
    finality,
    pointerVersion: 0,
    outcome: null,
    periodStart: `${taxYear}-01-01`,
    periodEnd: `${taxYear}-12-31`,
    coverageFrom: null,
    coverageThrough: null,
    calculatedAsOf: null,
    coverageStatus: 'UNKNOWN' as const,
    coverageAssurance: 'UNKNOWN' as const,
    taxYearCloseStatus: 'OPEN' as const,
    sourceCoverageIntervalCount: 0,
    sourceCoverageSummaryStatus: 'UNKNOWN' as const,
    sourceCoverageSnapshot: [],
    createdAt: null,
    completedAt: null,
    failedAt: null,
    failureCode: null,
    blockedReasonCode: 'NOT_STARTED' as const,
    hasCurrentReport: false,
  }
  return {
    generationId: value.generationId,
    state: value.state,
    taxYear: value.taxYear,
    finality: value.finality ?? finality,
    pointerVersion: value.pointerVersion ?? 0,
    outcome: value.outcome,
    periodStart: value.periodStart ?? `${taxYear}-01-01`,
    periodEnd: value.periodEnd ?? `${taxYear}-12-31`,
    coverageFrom: value.coverageFrom ?? null,
    coverageThrough: value.coverageThrough ?? null,
    calculatedAsOf: value.calculatedAsOf ?? null,
    coverageStatus: value.coverageStatus ?? 'UNKNOWN',
    coverageAssurance: value.coverageAssurance ?? 'UNKNOWN',
    taxYearCloseStatus: value.taxYearCloseStatus ?? 'OPEN',
    sourceCoverageIntervalCount: value.sourceCoverageIntervalCount ?? 0,
    sourceCoverageSummaryStatus:
      value.sourceCoverageSummaryStatus ?? 'UNKNOWN',
    sourceCoverage: (value.sourceCoverageSnapshot ?? []).map((source) => ({
      sourceKind: source.sourceKind,
      systemName: source.systemName,
      declaredFrom: source.declaredFrom,
      declaredThrough: source.declaredThrough,
      completeness: source.completeness,
      assurance: source.assurance,
    })),
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    failedAt: value.failedAt ?? null,
    failureCode: value.failureCode ?? null,
    blockedReasonCode: value.blockedReasonCode,
    hasCurrentReport: value.hasCurrentReport,
  }
}

export const registerTaxReportRoutes = async (
  app: FastifyInstance,
  options: TaxReportRoutesOptions,
) => {
  app.get<{
    Params: { taxYear: string }
    Querystring: { finality?: TaxReportFinality; residentId?: string }
  }>(
    '/api/v1/tax-reports/:taxYear/current',
    {
      schema: {
        params: {
          type: 'object', additionalProperties: false, required: ['taxYear'],
          properties: { taxYear: { type: 'string', pattern: '^(202[5-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$' } },
        },
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            finality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'], default: 'FINAL' },
            residentId: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: { 200: { type: 'object', additionalProperties: false, required: ['report'], properties: { report: reportResponseSchema } } },
      },
    },
    async (request) => {
      const subjectId = request.authSession?.user.id
      if (!subjectId) {
        throw unauthorized()
      }
      const taxYear = Number(request.params.taxYear)
      const finality = request.query.finality ?? 'FINAL'
      if (request.query.residentId !== undefined) {
        throw new ApiError(
          400,
          'INVALID_REPORT_SCOPE',
          '거주자 범위는 인증된 사용자 정보에서 서버가 결정합니다.',
        )
      }
      try {
        const report = await options.reader.getCurrent(subjectId, taxYear, finality)
        if (!report) {
          throw resourceNotFound()
        }
        return { report: publicReport(report) }
      } catch (error) {
        if (error instanceof ApiError) {
          throw error
        }
        if (error instanceof AmbiguousCurrentTaxReportError) {
          throw new ApiError(409, 'AMBIGUOUS_TAX_RESIDENCY', '같은 과세연도에 여러 거주자 신고 자료가 있어 자동 선택할 수 없습니다.')
        }
        if (error instanceof CorrectionPendingError) {
          throw new ApiError(503, 'CORRECTION_PENDING', '정정 신고 검증이 완료될 때까지 신고 자료를 제공할 수 없습니다.')
        }
        if (error instanceof InconsistentTaxReportError) {
          throw new ApiError(503, 'TAX_REPORT_INCONSISTENT', '신고 자료의 일관성 검증에 실패했습니다.')
        }
        throw error
      }
    },
  )
  const statusReader = options.statusReader
  if (statusReader) {
    app.get<{
      Params: { taxYear: string }
      Querystring: { finality?: TaxReportFinality; residentId?: string }
    }>(
      '/api/v1/tax-reports/:taxYear/status',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['taxYear'],
            properties: {
              taxYear: { type: 'string', pattern: '^(2025|2026|2027)$' },
            },
          },
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              finality: {
                type: 'string',
                enum: ['FINAL', 'PROVISIONAL'],
                default: 'PROVISIONAL',
              },
              residentId: { type: 'string', minLength: 1, maxLength: 256 },
            },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['status'],
              properties: { status: generationStatusResponseSchema },
            },
          },
        },
      },
      async (request) => {
        const subjectId = request.authSession?.user.id
        if (!subjectId) {
          throw unauthorized()
        }
        const taxYear = Number(request.params.taxYear) as 2025 | 2026 | 2027
        const finality = request.query.finality ?? 'PROVISIONAL'
        if (request.query.residentId !== undefined) {
          throw new ApiError(
            400,
            'INVALID_REPORT_SCOPE',
            '거주자 범위는 인증된 사용자 정보에서 서버가 결정합니다.',
          )
        }
        try {
          const status = await statusReader.getGenerationStatus(
            subjectId,
            taxYear,
            finality,
          )
          return { status: publicGenerationStatus(status, taxYear, finality) }
        } catch (error) {
          if (error instanceof AmbiguousCurrentTaxReportError) {
            throw new ApiError(
              409,
              'AMBIGUOUS_TAX_RESIDENCY',
              '같은 과세연도에 여러 거주자 신고 자료가 있어 자동 선택할 수 없습니다.',
            )
          }
          if (error instanceof InconsistentTaxReportGenerationStatusError) {
            throw new ApiError(
              503,
              'TAX_REPORT_STATUS_INCONSISTENT',
              '신고 자료 생성 상태의 일관성 검증에 실패했습니다.',
            )
          }
          throw error
        }
      },
    )
  }
}
