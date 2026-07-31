import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type { AppConfig, ReportPaymentConfig } from '../config.js'
import { ApiError, resourceNotFound, unauthorized } from '../errors.js'
import type {
  ReportPaymentFacilitator,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402Settlement,
} from '../report-payment/facilitator.js'
import type {
  ReportPaymentBinding,
  ReportPaymentOrder,
  ReportPaymentStore,
} from '../report-payment/types.js'
import type {
  CurrentTaxReport,
  ReportPaymentTaxReport,
  ReportPaymentTaxReportReader,
} from '../tax-report/types.js'
import {
  AmbiguousCurrentTaxReportError,
  InconsistentTaxReportError,
} from '../tax-report/postgres-tax-report-reader.js'

type ReportPaymentRoutesOptions = {
  config: AppConfig
  paymentConfig?: ReportPaymentConfig
  reader?: ReportPaymentTaxReportReader
  store?: ReportPaymentStore
  facilitator?: ReportPaymentFacilitator
  now?: () => Date
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/
const noncePattern = /^0x[0-9a-fA-F]{64}$/
const signaturePattern = /^0x[0-9a-fA-F]+$/
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const encodeBase64Json = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

const decodePaymentPayload = (value: string): X402PaymentPayload => {
  if (value.length > 32_768) {
    throw new ApiError(402, 'PAYMENT_SIGNATURE_INVALID', '결제 서명 크기가 허용 범위를 초과했습니다.')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown
  } catch {
    throw new ApiError(402, 'PAYMENT_SIGNATURE_INVALID', '결제 서명을 확인할 수 없습니다.')
  }
  if (!isRecord(decoded) || decoded.x402Version !== 2 || !isRecord(decoded.accepted)) {
    throw new ApiError(402, 'PAYMENT_SIGNATURE_INVALID', '지원하지 않는 x402 결제 서명입니다.')
  }
  const payload = decoded.payload
  if (!isRecord(payload) || typeof payload.signature !== 'string' || !signaturePattern.test(payload.signature)) {
    throw new ApiError(402, 'PAYMENT_SIGNATURE_INVALID', '결제 서명을 확인할 수 없습니다.')
  }
  const authorization = payload.authorization
  if (
    !isRecord(authorization) ||
    typeof authorization.from !== 'string' ||
    !addressPattern.test(authorization.from) ||
    typeof authorization.to !== 'string' ||
    !addressPattern.test(authorization.to) ||
    typeof authorization.value !== 'string' ||
    !/^[0-9]+$/.test(authorization.value) ||
    typeof authorization.validAfter !== 'string' ||
    !/^[0-9]+$/.test(authorization.validAfter) ||
    typeof authorization.validBefore !== 'string' ||
    !/^[0-9]+$/.test(authorization.validBefore) ||
    typeof authorization.nonce !== 'string' ||
    !noncePattern.test(authorization.nonce)
  ) {
    throw new ApiError(402, 'PAYMENT_SIGNATURE_INVALID', '결제 authorization을 확인할 수 없습니다.')
  }
  return decoded as X402PaymentPayload
}

const reportEnvelope = (report: CurrentTaxReport) => ({ report })

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const resourceDigestFor = (value: ReportPaymentTaxReport) =>
  createHash('sha256')
    .update(stableJson({
      report: value.report,
      residentId: value.residentId,
      reportArtifactDigest: value.reportArtifactDigest,
      format: 'json',
    }))
    .digest('hex')

const requirementFor = (
  order: ReportPaymentOrder,
  paymentConfig: ReportPaymentConfig,
): X402PaymentRequirement => ({
  scheme: 'exact',
  network: order.network,
  asset: order.asset,
  amount: order.amount,
  payTo: order.payTo,
  maxTimeoutSeconds: order.maxTimeoutSeconds,
  extra: {
    name: paymentConfig.tokenName,
    version: paymentConfig.tokenVersion,
    paymentOrderId: order.id,
    reportId: order.reportId,
    taxYear: order.taxYear,
    finality: order.finality,
    pointerVersion: order.pointerVersion,
    format: order.format,
    resourceDigest: order.resourceDigest,
  },
})

const matchesRequirement = (
  accepted: X402PaymentRequirement,
  expected: X402PaymentRequirement,
) => {
  const extra = accepted.extra
  return (
    accepted.scheme === expected.scheme &&
    accepted.network === expected.network &&
    sameAddress(accepted.asset, expected.asset) &&
    accepted.amount === expected.amount &&
    sameAddress(accepted.payTo, expected.payTo) &&
    accepted.maxTimeoutSeconds === expected.maxTimeoutSeconds &&
    isRecord(extra) &&
    Object.entries(expected.extra).every(([key, value]) => extra[key] === value)
  )
}

const validateAuthorization = (
  payment: X402PaymentPayload,
  requirement: X402PaymentRequirement,
  now: Date,
) => {
  const authorization = payment.payload.authorization
  const nowSeconds = Math.floor(now.getTime() / 1000)
  return (
    sameAddress(authorization.to, requirement.payTo) &&
    authorization.value === requirement.amount &&
    BigInt(authorization.validAfter) <= BigInt(nowSeconds) &&
    BigInt(authorization.validBefore) > BigInt(nowSeconds) &&
    BigInt(authorization.validBefore) <= BigInt(nowSeconds + requirement.maxTimeoutSeconds)
  )
}

const paymentRequired = (
  order: ReportPaymentOrder,
  requirement: X402PaymentRequirement,
  resourceUrl: string,
) =>
  new ApiError(
    402,
    'PAYMENT_REQUIRED',
    '보고서를 내려받으려면 GIWA Sepolia 결제가 필요합니다.',
    {
      'cache-control': 'private, no-store',
      'payment-required': encodeBase64Json({
        x402Version: 2,
        resource: {
          url: resourceUrl,
          description: order.taxYear < 2027
            ? `${order.taxYear}년 정책 시뮬레이션 장부 (POLICY_SIMULATION · 2027.1.1 시행 예정 기준 · 신고용 아님)`
            : `${order.taxYear}년 FINAL 세금 보고서`,
          mimeType: 'application/json',
        },
        accepts: [requirement],
      }),
    },
  )

const ensurePayable = (report: CurrentTaxReport) => {
  if (report.finality !== 'FINAL' || report.status !== 'FINAL' || report.filingStatus !== 'READY') {
    throw new ApiError(409, 'REPORT_NOT_PAYABLE', '최종 발행 준비가 끝난 보고서만 결제할 수 있습니다.')
  }
}

const bindingFor = (
  userId: string,
  value: ReportPaymentTaxReport,
): ReportPaymentBinding => ({
  userId,
  reportId: value.report.reportId,
  residentId: value.residentId,
  taxYear: value.report.taxYear,
  finality: 'FINAL',
  pointerVersion: value.report.pointerVersion,
  reportArtifactDigest: value.reportArtifactDigest,
  format: 'json',
  resourceDigest: resourceDigestFor(value),
})

export const registerReportPaymentRoutes = async (
  app: FastifyInstance,
  options: ReportPaymentRoutesOptions,
) => {
  app.get(
    '/api/v1/report-payments/capabilities',
    {
      schema: {
        response: {
          200: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['enabled'],
                properties: {
                  enabled: { type: 'boolean', const: false },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'enabled',
                  'network',
                  'asset',
                  'amount',
                  'payTo',
                  'maxTimeoutSeconds',
                  'tokenName',
                  'tokenVersion',
                ],
                properties: {
                  enabled: { type: 'boolean', const: true },
                  network: { type: 'string', const: 'eip155:91342' },
                  asset: { type: 'string' },
                  amount: { type: 'string' },
                  payTo: { type: 'string' },
                  maxTimeoutSeconds: { type: 'integer' },
                  tokenName: { type: 'string' },
                  tokenVersion: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
    async () => ({
      enabled: options.paymentConfig !== undefined,
      ...(options.paymentConfig
        ? {
            network: options.paymentConfig.network,
            asset: options.paymentConfig.asset,
            amount: options.paymentConfig.amount,
            payTo: options.paymentConfig.payTo,
            maxTimeoutSeconds: options.paymentConfig.maxTimeoutSeconds,
            tokenName: options.paymentConfig.tokenName,
            tokenVersion: options.paymentConfig.tokenVersion,
          }
        : {}),
    }),
  )

  const { facilitator, paymentConfig, reader, store } = options
  if (!paymentConfig) return
  if (!reader || !store || !facilitator) {
    throw new Error('Report payment dependencies are required when payments are enabled')
  }

  app.get<{
    Params: { taxYear: string }
    Querystring: { finality?: 'FINAL'; residentId?: string; format?: 'json' }
  }>(
    '/api/v1/tax-reports/:taxYear/current/download',
    {
      schema: {
        params: {
          type: 'object', additionalProperties: false, required: ['taxYear'],
          properties: { taxYear: { type: 'string', pattern: '^(202[5-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$' } },
        },
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            finality: { type: 'string', const: 'FINAL', default: 'FINAL' },
            residentId: { type: 'string', minLength: 1, maxLength: 256 },
            format: { type: 'string', const: 'json', default: 'json' },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.authSession?.user.id
      if (!userId) throw unauthorized()

      let paymentReport: ReportPaymentTaxReport | undefined
      try {
        paymentReport = await reader.getCurrentForPayment(
          userId,
          Number(request.params.taxYear),
          'FINAL',
          request.query.residentId,
        )
      } catch (error) {
        if (error instanceof AmbiguousCurrentTaxReportError) {
          throw new ApiError(
            409,
            'AMBIGUOUS_TAX_RESIDENCY',
            '같은 과세연도에 여러 거주자 신고 자료가 있어 자동 선택할 수 없습니다.',
          )
        }
        if (error instanceof InconsistentTaxReportError) {
          throw new ApiError(
            503,
            'TAX_REPORT_INCONSISTENT',
            '신고 자료의 일관성 검증에 실패했습니다.',
          )
        }
        throw error
      }
      if (!paymentReport) throw resourceNotFound()
      const { report } = paymentReport
      ensurePayable(report)

      const binding = bindingFor(userId, paymentReport)
      reply.header('cache-control', 'private, no-store')
      if (await store.findEntitlement(userId, binding.resourceDigest, 'json')) {
        reply.header('x-daejang-payment-entitlement', 'reused')
        return reportEnvelope(report)
      }

      const now = options.now?.() ?? new Date()
      const order = await store.getOrCreateQuote(
        binding,
        {
          scheme: 'exact',
          network: paymentConfig.network,
          asset: paymentConfig.asset,
          amount: paymentConfig.amount,
          payTo: paymentConfig.payTo,
          maxTimeoutSeconds: paymentConfig.maxTimeoutSeconds,
        },
        new Date(now.getTime() + paymentConfig.maxTimeoutSeconds * 1_000),
      )
      const requirement = requirementFor(order, paymentConfig)
      const resourceUrl = `${options.config.publicOrigin}/api/v1/tax-reports/${report.taxYear}/current/download?finality=FINAL&format=json${request.query.residentId ? `&residentId=${encodeURIComponent(request.query.residentId)}` : ''}`
      const signatureHeader = request.headers['payment-signature']
      if (typeof signatureHeader !== 'string') {
        throw paymentRequired(order, requirement, resourceUrl)
      }

      const payment = decodePaymentPayload(signatureHeader)
      if (!matchesRequirement(payment.accepted, requirement) || !validateAuthorization(payment, requirement, now)) {
        throw paymentRequired(order, requirement, resourceUrl)
      }

      let verification
      try {
        verification = await facilitator.verify({
          paymentPayload: payment,
          paymentRequirements: requirement,
        })
      } catch {
        throw new ApiError(503, 'PAYMENT_FACILITATOR_UNAVAILABLE', '결제 검증 서비스에 연결할 수 없습니다.')
      }
      if (!verification.valid || !sameAddress(verification.payer, payment.payload.authorization.from)) {
        throw paymentRequired(order, requirement, resourceUrl)
      }

      const payloadHash = createHash('sha256').update(signatureHeader).digest('hex')
      const reservation = await store.reserveSettlement({
        orderId: order.id,
        userId,
        resourceDigest: binding.resourceDigest,
        payloadHash,
        payer: verification.payer,
        authorizationNonce: payment.payload.authorization.nonce,
        now,
      })
      if (reservation.kind === 'invalid') {
        throw paymentRequired(order, requirement, resourceUrl)
      }
      if (reservation.kind === 'busy') {
        throw new ApiError(409, 'PAYMENT_SETTLEMENT_IN_PROGRESS', '동일한 결제를 정산하고 있습니다.')
      }

      let settlement: X402Settlement
      if (reservation.kind === 'settled') {
        const settled = reservation.order
        if (!settled.transactionHash || !settled.payer) {
          throw new ApiError(503, 'PAYMENT_STATE_INCONSISTENT', '결제 상태를 확인할 수 없습니다.')
        }
        settlement = {
          success: true,
          transaction: settled.transactionHash,
          network: settled.network,
          payer: settled.payer,
        }
      } else {
        let result
        try {
          result = await facilitator.settle({
            paymentPayload: payment,
            paymentRequirements: requirement,
          })
        } catch {
          throw new ApiError(503, 'PAYMENT_FACILITATOR_UNAVAILABLE', '결제 정산 서비스에 연결할 수 없습니다.')
        }
        if (
          !result.success ||
          result.network !== requirement.network ||
          !transactionHashPattern.test(result.transaction) ||
          !sameAddress(result.payer, verification.payer)
        ) {
          await store.failSettlement(order.id, userId)
          throw paymentRequired(order, requirement, resourceUrl)
        }
        await store.completeSettlement({
          orderId: order.id,
          userId,
          resourceDigest: binding.resourceDigest,
          payer: result.payer,
          transactionHash: result.transaction,
        })
        settlement = result
      }

      reply.header('payment-response', encodeBase64Json(settlement))
      await store.markDelivered(order.id, userId)
      return reportEnvelope(report)
    },
  )
}
