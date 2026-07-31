import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import type {
  ReportPaymentFacilitator,
  X402PaymentPayload,
  X402PaymentRequirement,
} from '../report-payment/facilitator.js'
import { MemoryReportPaymentStore } from '../report-payment/types.js'
import type {
  CurrentTaxReport,
  ReportPaymentTaxReport,
  ReportPaymentTaxReportReader,
  TaxReportReader,
} from '../tax-report/types.js'
import {
  AmbiguousCurrentTaxReportError,
  InconsistentTaxReportError,
} from '../tax-report/postgres-tax-report-reader.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const PAYER = '0x1111111111111111111111111111111111111111'
const TX_HASH = `0x${'2'.repeat(64)}`

const config: AppConfig = {
  runtimeMode: 'test', reportsUiMode: 'product', host: '127.0.0.1', port: 3000,
  publicOrigin: 'http://localhost:5173', sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup', sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600, signupSessionTtlSeconds: 3_600, bodyLimitBytes: 65_536,
  secureCookies: false, trustProxyHops: 0, databaseUrl: undefined,
  rateLimitHmacSecret: 'test-rate-limit-secret',
  oauth: { enabledProviders: new Set(), transactionTtlSeconds: 600, stateHmacSecret: 'test-oauth-state-secret', transactionEncryptionKey: Buffer.alloc(32, 1), providers: {} },
  emailAuth: { enabled: false, resendApiKey: undefined, from: undefined, verificationHmacSecret: 'test-email-verification-secret', verificationTtlSeconds: 300, verificationTokenTtlSeconds: 600, resendAfterSeconds: 60 },
  signup: {
    enabled: false,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: false,
  engineMtls: undefined,
  reportPayments: {
    facilitatorUrl: 'http://localhost:4021', network: 'eip155:91342',
    asset: '0x1ce6222bd60923a9d5209a7e191016294dc2c961', amount: '100000',
    payTo: '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0', maxTimeoutSeconds: 300,
    tokenName: 'Mock USD', tokenVersion: '1',
  },
}

const report: CurrentTaxReport = {
  reportId: 'report-final-1', taxYear: 2027,
  finality: 'FINAL', status: 'FINAL', filingStatus: 'READY',
  denominationAssetId: 'asset-krw',
  pointerVersion: 3, issuedAt: '2028-01-10T00:00:00.000Z',
  counts: { disposals: 1, transfers: 0, excludedConversions: 0, limitations: 0 },
  summary: { gainLoss: { status: 'KNOWN', amount: '1000' }, taxableBase: { status: 'KNOWN', amount: '1000' }, nationalTax: { status: 'KNOWN', amount: '220' }, localTax: { status: 'KNOWN', amount: '22' }, totalTax: { status: 'KNOWN', amount: '242' } },
}

const paymentReport: ReportPaymentTaxReport = {
  report,
  residentId: 'resident-1',
  reportArtifactDigest: 'c'.repeat(64),
}

class FakeReader implements TaxReportReader, ReportPaymentTaxReportReader {
  readonly durable = true
  value: ReportPaymentTaxReport | undefined = paymentReport
  error: unknown
  async getCurrent(subjectId: string) {
    return subjectId === USER_ID ? this.value?.report : undefined
  }
  async getCurrentForPayment(subjectId: string) {
    if (this.error) throw this.error
    return subjectId === USER_ID ? this.value : undefined
  }
}

class FakeFacilitator implements ReportPaymentFacilitator {
  verifyCalls = 0
  settleCalls = 0
  settlePayer = PAYER
  throwSettleOnce = false
  async verify(input: { paymentPayload: X402PaymentPayload; paymentRequirements: X402PaymentRequirement }) {
    this.verifyCalls += 1
    return { valid: true as const, payer: input.paymentPayload.payload.authorization.from }
  }
  async settle() {
    this.settleCalls += 1
    if (this.throwSettleOnce) {
      this.throwSettleOnce = false
      throw new Error('temporary facilitator outage')
    }
    return { success: true as const, transaction: TX_HASH, network: 'eip155:91342', payer: this.settlePayer }
  }
}

const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

describe('actual report x402 payment route', () => {
  let context: Awaited<ReturnType<typeof buildApp>>
  let reader: FakeReader
  let facilitator: FakeFacilitator
  let store: MemoryReportPaymentStore
  let now = new Date('2028-01-10T00:00:00.000Z')

  beforeEach(async () => {
    reader = new FakeReader()
    facilitator = new FakeFacilitator()
    store = new MemoryReportPaymentStore()
    now = new Date('2028-01-10T00:00:00.000Z')
    context = await buildApp({
      config,
      logger: false,
      taxReportReader: reader,
      reportPaymentTaxReportReader: reader,
      reportPaymentStore: store,
      reportPaymentFacilitator: facilitator,
      now: () => now,
    })
  })
  afterEach(async () => context.app.close())

  const sessionHeaders = async () => {
    const { token } = await context.sessionService.create({ user: { id: USER_ID, displayName: '김대장' } })
    return { cookie: `${config.sessionCookieName}=${token}` }
  }

  const quote = async (taxYear = 2027) => {
    const headers = await sessionHeaders()
    const response = await context.app.inject({ method: 'GET', url: `/api/v1/tax-reports/${taxYear}/current/download?finality=FINAL&format=json`, headers })
    expect(response.statusCode).toBe(402)
    const requiredHeader = response.headers['payment-required']
    expect(requiredHeader).toBeTypeOf('string')
    const required = decode(requiredHeader as string) as { accepts: X402PaymentRequirement[] }
    return { headers, requirement: required.accepts[0] as X402PaymentRequirement, required }
  }

  const paymentFor = (requirement: X402PaymentRequirement) => encode({
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature: `0x${'3'.repeat(130)}`,
      authorization: {
        from: PAYER, to: requirement.payTo, value: requirement.amount,
        validAfter: '0', validBefore: `${Math.floor(now.getTime() / 1000) + 300}`,
        nonce: `0x${'4'.repeat(64)}`,
      },
    },
  })

  it('binds a 402 quote to the authenticated user and exact FINAL report revision', async () => {
    const { required, requirement } = await quote()
    expect(required).toMatchObject({
      x402Version: 2,
      resource: {
        description: '2027년 FINAL 세금 보고서',
        mimeType: 'application/json',
      },
    })
    expect(requirement).toMatchObject({
      scheme: 'exact', network: 'eip155:91342', amount: '100000',
      extra: { reportId: 'report-final-1', pointerVersion: 3, format: 'json' },
    })
    expect(requirement.extra).not.toHaveProperty('residentId')
    expect(requirement.extra).not.toHaveProperty('reportArtifactDigest')
  })

  it('labels a 2025/2026 x402 resource as a non-filing policy simulation and rejects 2024', async () => {
    reader.value = {
      ...paymentReport,
      report: {
        ...report,
        reportId: 'report-simulation-2026',
        taxYear: 2026,
      },
    }
    const { required, requirement } = await quote(2026)
    expect(required).toMatchObject({
      resource: {
        description:
          '2026년 정책 시뮬레이션 장부 (POLICY_SIMULATION · 2027.1.1 시행 예정 기준 · 신고용 아님)',
      },
    })
    expect(requirement.extra).toMatchObject({
      reportId: 'report-simulation-2026',
      taxYear: 2026,
    })

    const headers = await sessionHeaders()
    const invalid = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2024/current/download?finality=FINAL&format=json',
      headers,
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('returns the actual report only after verify and settle, then reuses the entitlement', async () => {
    const { headers, requirement } = await quote()
    const paid = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': paymentFor(requirement) },
    })
    expect(paid.statusCode).toBe(200)
    expect(paid.json()).toEqual({ report })
    expect(decode(paid.headers['payment-response'] as string)).toMatchObject({ success: true, transaction: TX_HASH, payer: PAYER })
    expect(facilitator.verifyCalls).toBe(1)
    expect(facilitator.settleCalls).toBe(1)

    const replay = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json', headers })
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['x-daejang-payment-entitlement']).toBe('reused')
    expect(facilitator.settleCalls).toBe(1)
  })

  it('does not accept a quote after the report revision changes', async () => {
    const { headers, requirement } = await quote()
    reader.value = {
      ...paymentReport,
      report: { ...report, pointerVersion: 4 },
      reportArtifactDigest: 'e'.repeat(64),
    }
    const response = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': paymentFor(requirement) },
    })
    expect(response.statusCode).toBe(402)
    expect(facilitator.verifyCalls).toBe(0)
    expect(facilitator.settleCalls).toBe(0)
  })

  it('rejects altered terms before facilitator access and settles concurrent replay only once', async () => {
    const { headers, requirement } = await quote()
    const altered = paymentFor({ ...requirement, amount: '999999' as '100000' })
    const rejected = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': altered },
    })
    expect(rejected.statusCode).toBe(402)
    expect(facilitator.verifyCalls).toBe(0)

    const signed = paymentFor(requirement)
    const responses = await Promise.all([
      context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json', headers: { ...headers, 'payment-signature': signed } }),
      context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json', headers: { ...headers, 'payment-signature': signed } }),
    ])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(facilitator.settleCalls).toBe(1)
  })

  it('reclaims an uncertain SETTLING order after the lease and retries the same authorization', async () => {
    const { headers, requirement } = await quote()
    const signed = paymentFor(requirement)
    facilitator.throwSettleOnce = true
    const unavailable = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': signed },
    })
    expect(unavailable.statusCode).toBe(503)

    const stillLeased = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': signed },
    })
    expect(stillLeased.statusCode).toBe(409)

    now = new Date(now.getTime() + 31_000)
    const recovered = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current/download?finality=FINAL&format=json',
      headers: { ...headers, 'payment-signature': signed },
    })
    expect(recovered.statusCode).toBe(200)
    expect(facilitator.settleCalls).toBe(2)
  })

  it('rejects PARTIAL reports and a settlement payer mismatch without returning report data', async () => {
    const headers = await sessionHeaders()
    reader.value = {
      ...paymentReport,
      report: { ...report, status: 'PARTIAL', filingStatus: 'BLOCKED' },
    }
    const partial = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download', headers })
    expect(partial.statusCode).toBe(409)
    expect(partial.json()).not.toHaveProperty('report')

    reader.value = paymentReport
    const first = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download', headers })
    const requirement = (decode(first.headers['payment-required'] as string) as { accepts: X402PaymentRequirement[] }).accepts[0] as X402PaymentRequirement
    facilitator.settlePayer = '0x9999999999999999999999999999999999999999'
    const mismatch = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current/download', headers: { ...headers, 'payment-signature': paymentFor(requirement) } })
    expect(mismatch.statusCode).toBe(402)
    expect(mismatch.json()).not.toHaveProperty('report')
  })

  it('publishes an explicit server-owned payment capability', async () => {
    const headers = await sessionHeaders()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-payments/capabilities',
      headers,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      enabled: true,
      network: 'eip155:91342',
      asset: '0x1ce6222bd60923a9d5209a7e191016294dc2c961',
      amount: '100000',
      payTo: '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0',
      maxTimeoutSeconds: 300,
      tokenName: 'Mock USD',
      tokenVersion: '1',
    })
  })

  it('keeps the capability route available and fail-closed when payments are disabled', async () => {
    const { reportPayments: _reportPayments, ...disabledConfig } = config
    const disabled = await buildApp({
      config: disabledConfig,
      logger: false,
    })
    try {
      const { token } = await disabled.sessionService.create({
        user: { id: USER_ID, displayName: '김대장' },
      })
      const response = await disabled.app.inject({
        method: 'GET',
        url: '/api/v1/report-payments/capabilities',
        headers: { cookie: `${config.sessionCookieName}=${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ enabled: false })
    } finally {
      await disabled.app.close()
    }
  })

  it.each([
    [
      new AmbiguousCurrentTaxReportError(),
      409,
      'AMBIGUOUS_TAX_RESIDENCY',
    ],
    [
      new InconsistentTaxReportError(),
      503,
      'TAX_REPORT_INCONSISTENT',
    ],
  ])(
    'maps private report reader failures without leaking report data',
    async (error, statusCode, code) => {
      reader.error = error
      const headers = await sessionHeaders()
      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/tax-reports/2027/current/download',
        headers,
      })

      expect(response.statusCode).toBe(statusCode)
      expect(response.json()).toMatchObject({ error: { code } })
      expect(response.json()).not.toHaveProperty('report')
    },
  )
})
