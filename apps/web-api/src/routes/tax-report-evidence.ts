import { status as grpcStatus } from '@grpc/grpc-js'
import type { FastifyInstance } from 'fastify'

import { EngineRpcError } from '../engine/rpc-error.js'
import {
  ApiError,
  resourceNotFound,
  unauthorized,
} from '../errors.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import {
  decodeAndProjectTaxEvidencePack,
  InvalidTaxEvidencePackError,
  publicTaxEvidencePackSchema,
} from '../tax-report/evidence-pack.js'
import {
  InvalidTaxEvidencePackV2Error,
  publicTaxEvidencePackV2Schema,
} from '../tax-report/evidence-pack-v2.js'
import type { TaxEvidencePackReader } from '../tax-report/model-reader.js'

type TaxReportEvidenceRoutesOptions = {
  reader: TaxEvidencePackReader
}

const inconsistentEvidencePack = () =>
  new ApiError(
    503,
    'TAX_EVIDENCE_PACK_INCONSISTENT',
    '세금 장부 계산 근거의 일관성 검증에 실패했습니다.',
  )

export const registerTaxReportEvidenceRoutes = async (
  app: FastifyInstance,
  options: TaxReportEvidenceRoutesOptions,
) => {
  app.get<{ Params: { reportId: string } }>(
    '/api/v1/tax-reports/:reportId/evidence',
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
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['evidencePack'],
            properties: {
              evidencePack: {
                anyOf: [
                  publicTaxEvidencePackSchema,
                  publicTaxEvidencePackV2Schema,
                ],
              },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) throw unauthorized()
      const context: SourceRequestContext = {
        requestId: request.id,
        userId: session.user.id,
        sessionId: session.id,
      }
      try {
        const artifact = await options.reader.getTaxEvidencePack(
          context,
          request.params.reportId,
        )
        return {
          evidencePack: decodeAndProjectTaxEvidencePack(
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
        if (
          error instanceof EngineRpcError &&
          error.grpcCode === grpcStatus.DATA_LOSS
        ) {
          request.log.error(
            { reportId: request.params.reportId },
            'tax evidence pack integrity verification failed upstream',
          )
          throw inconsistentEvidencePack()
        }
        if (
          error instanceof InvalidTaxEvidencePackError ||
          error instanceof InvalidTaxEvidencePackV2Error
        ) {
          request.log.error(
            { validationError: error.message },
            'tax evidence pack validation failed',
          )
          throw inconsistentEvidencePack()
        }
        throw error
      }
    },
  )
}
