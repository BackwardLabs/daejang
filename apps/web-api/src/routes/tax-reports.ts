import type { FastifyInstance } from 'fastify'

import { ApiError, resourceNotFound, unauthorized } from '../errors.js'
import {
  AmbiguousCurrentTaxReportError,
  InconsistentTaxReportError,
} from '../tax-report/postgres-tax-report-reader.js'
import type {
  CurrentTaxReport,
  TaxAmount,
  TaxReportFinality,
  TaxReportReader,
} from '../tax-report/types.js'

type TaxReportRoutesOptions = {
  reader: TaxReportReader
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
    taxYear: { type: 'integer', minimum: 2027, maximum: 9999 },
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

export const registerTaxReportRoutes = async (
  app: FastifyInstance,
  options: TaxReportRoutesOptions,
) => {
  app.get<{ Params: { taxYear: string }; Querystring: { finality?: TaxReportFinality; residentId?: string } }>(
    '/api/v1/tax-reports/:taxYear/current',
    {
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
        return { report: publicReport(report) }
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
