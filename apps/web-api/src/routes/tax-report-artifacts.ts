import { createHash } from 'node:crypto'

import { status as grpcStatus } from '@grpc/grpc-js'
import type { FastifyInstance } from 'fastify'

import { EngineRpcError } from '../engine/rpc-error.js'
import {
  ApiError,
  resourceNotFound,
  unauthorized,
} from '../errors.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import type { TaxReportModelReader } from '../tax-report/model-reader.js'
import { loadPretendardFont } from '../tax-report/pdf/font.js'
import { renderTaxReportPdf } from '../tax-report/pdf/pdf-renderer.js'
import { createReportPrintModel } from '../tax-report/pdf/report-print-model.js'
import {
  decodeAndProjectTaxReportModel,
  InvalidTaxReportModelError,
} from '../tax-report/public-model.js'
import { InvalidTaxReportModelV2Error } from '../tax-report/public-model-v2.js'

type TaxReportArtifactRoutesOptions = {
  reader: TaxReportModelReader
  loadFont?: () => Promise<Buffer>
  renderPdf?: typeof renderTaxReportPdf
}

const inconsistentModel = () =>
  new ApiError(
    503,
    'TAX_REPORT_MODEL_INCONSISTENT',
    '세금 장부 원본의 일관성 검증에 실패했습니다.',
  )

const pdfUnavailable = () =>
  new ApiError(
    503,
    'TAX_REPORT_PDF_UNAVAILABLE',
    '세금 장부 PDF를 생성하지 못했습니다.',
  )

const safeFilePart = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)

export const registerTaxReportArtifactRoutes = async (
  app: FastifyInstance,
  options: TaxReportArtifactRoutesOptions,
) => {
  app.get<{ Params: { reportId: string } }>(
    '/api/v1/tax-reports/:reportId/artifacts/pdf',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['reportId'],
          properties: {
            reportId: {
              type: 'string',
              pattern: '^tax-report(?:-v2)?:[0-9a-f]{64}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const context: SourceRequestContext = {
        requestId: request.id,
        userId: session.user.id,
        sessionId: session.id,
      }
      let report
      try {
        const artifact = await options.reader.getTaxReportModel(
          context,
          request.params.reportId,
        )
        report = decodeAndProjectTaxReportModel(
          artifact,
          request.params.reportId,
        )
      } catch (error) {
        if (
          error instanceof EngineRpcError &&
          (error.grpcCode === grpcStatus.NOT_FOUND ||
            error.grpcCode === grpcStatus.PERMISSION_DENIED)
        ) {
          throw resourceNotFound()
        }
        if (
          error instanceof InvalidTaxReportModelError ||
          error instanceof InvalidTaxReportModelV2Error
        ) {
          request.log.error(
            { validationError: error.message },
            'tax report PDF source validation failed',
          )
          throw inconsistentModel()
        }
        throw error
      }

      let bytes: Buffer
      try {
        bytes = await (options.renderPdf ?? renderTaxReportPdf)(
          createReportPrintModel(report),
          {
            fontBytes: await (options.loadFont ?? loadPretendardFont)(),
            rendererVersion: '1',
          },
        )
      } catch (error) {
        request.log.error({ error }, 'tax report PDF rendering failed')
        throw pdfUnavailable()
      }

      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        request.log.error('tax report PDF renderer returned invalid bytes')
        throw pdfUnavailable()
      }
      const pdfDigest = createHash('sha256').update(bytes).digest('hex')
      const fileName = [
        report.taxYear < 2027
          ? 'daejang-tax-simulation'
          : 'daejang-tax-report',
        String(report.taxYear),
        safeFilePart(report.reportId),
      ].join('-')

      return reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="${fileName}.pdf"`,
        )
        .header('Content-Length', String(bytes.byteLength))
        .header('ETag', `"sha256-${pdfDigest}"`)
        .header('X-Report-Id', report.reportId)
        .send(bytes)
    },
  )
}
