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
import {
  decodeAndProjectTaxReportModel,
  InvalidTaxReportModelError,
  publicTaxReportDetailSchema,
} from '../tax-report/public-model.js'

type TaxReportDetailRoutesOptions = {
  reader: TaxReportModelReader
}

const inconsistentModel = () =>
  new ApiError(
    503,
    'TAX_REPORT_MODEL_INCONSISTENT',
    '세금 장부 원본의 일관성 검증에 실패했습니다.',
  )

export const registerTaxReportDetailRoutes = async (
  app: FastifyInstance,
  options: TaxReportDetailRoutesOptions,
) => {
  app.get<{ Params: { reportId: string } }>(
    '/api/v1/tax-reports/:reportId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['reportId'],
          properties: {
            reportId: {
              type: 'string',
              pattern: '^tax-report:[0-9a-f]{64}$',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['report'],
            properties: { report: publicTaxReportDetailSchema },
          },
        },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const context: SourceRequestContext = {
        requestId: request.id,
        userId: session.user.id,
        sessionId: session.id,
      }
      try {
        const artifact = await options.reader.getTaxReportModel(
          context,
          request.params.reportId,
        )
        return {
          report: decodeAndProjectTaxReportModel(
            artifact,
            request.params.reportId,
          ),
        }
      } catch (error) {
        if (
          error instanceof EngineRpcError &&
          (error.grpcCode === grpcStatus.NOT_FOUND ||
            error.grpcCode === grpcStatus.PERMISSION_DENIED)
        ) {
          throw resourceNotFound()
        }
        if (error instanceof InvalidTaxReportModelError) {
          request.log.error(
            { validationError: error.message },
            'tax report model validation failed',
          )
          throw inconsistentModel()
        }
        throw error
      }
    },
  )
}
