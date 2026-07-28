import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { ApiError, resourceNotFound, unauthorized } from '../errors.js'
import {
  AmbiguousCurrentTaxReportError,
  InconsistentTaxReportError,
} from '../tax-report/postgres-tax-report-reader.js'
import type { TaxReportFinality, TaxReportReader } from '../tax-report/types.js'

type TaxReportRoutesOptions = {
  authenticate: preHandlerHookHandler
  reader: TaxReportReader
}

const amountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['KNOWN', 'UNKNOWN'] },
    amount: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' },
  },
} as const

const reportResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'reportId', 'residentId', 'taxYear', 'finality', 'status', 'filingStatus',
    'taxInventoryRunId', 'taxEstimateId', 'lotRunId', 'inputDigest', 'schemaDigest',
    'denominationAssetId', 'reportArtifactDigest', 'evidencePackDigest', 'pointerVersion',
    'issuedAt', 'counts', 'summary', 'disposals', 'transfers', 'excludedConversions', 'limitations',
  ],
  properties: {
    schemaVersion: { type: 'string', const: 'giwa.web.tax-report.v1' },
    reportId: { type: 'string' },
    residentId: { type: 'string' },
    taxYear: { type: 'integer', minimum: 2027, maximum: 9999 },
    finality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    status: { type: 'string', enum: ['FINAL', 'PARTIAL'] },
    filingStatus: { type: 'string', enum: ['READY', 'BLOCKED'] },
    taxInventoryRunId: { type: 'string' },
    taxEstimateId: { type: 'string' },
    lotRunId: { type: 'string' },
    inputDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    schemaDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    denominationAssetId: { type: 'string' },
    reportArtifactDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    evidencePackDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
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
    summary: {
      type: 'object', additionalProperties: false,
      required: ['gainLoss', 'taxableBase', 'nationalTax', 'localTax', 'totalTax'],
      properties: { gainLoss: amountSchema, taxableBase: amountSchema, nationalTax: amountSchema, localTax: amountSchema, totalTax: amountSchema },
    },
    disposals: { type: 'array', items: { type: 'object', additionalProperties: true } },
    transfers: { type: 'array', items: { type: 'object', additionalProperties: true } },
    excludedConversions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    limitations: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
} as const

export const registerTaxReportRoutes = async (
  app: FastifyInstance,
  options: TaxReportRoutesOptions,
) => {
  app.get<{ Params: { taxYear: string }; Querystring: { finality?: TaxReportFinality; residentId?: string } }>(
    '/api/v1/tax-reports/:taxYear/current',
    {
      preHandler: options.authenticate,
      schema: {
        params: {
          type: 'object', additionalProperties: false, required: ['taxYear'],
          properties: { taxYear: { type: 'string', pattern: '^(202[7-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$' } },
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
      try {
        const report = await options.reader.getCurrent(subjectId, taxYear, finality, request.query.residentId)
        if (!report) {
          throw resourceNotFound()
        }
        return { report }
      } catch (error) {
        if (error instanceof ApiError) {
          throw error
        }
        if (error instanceof AmbiguousCurrentTaxReportError) {
          throw new ApiError(409, 'AMBIGUOUS_TAX_RESIDENCY', '같은 과세연도에 여러 거주자 신고 자료가 있어 자동 선택할 수 없습니다.')
        }
        if (error instanceof InconsistentTaxReportError) {
          throw new ApiError(503, 'TAX_REPORT_INCONSISTENT', '신고 자료의 일관성 검증에 실패했습니다.')
        }
        throw error
      }
    },
  )
}
