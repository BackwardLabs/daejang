import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import type {
  CurrentTaxReport,
  TaxReportFinality,
  TaxReportGenerationStatus,
  TaxReportGenerationStatusReader,
  TaxReportReader,
} from '../tax-report/types.js'
import {
  CorrectionPendingError,
  InconsistentTaxReportGenerationStatusError,
} from '../tax-report/postgres-tax-report-reader.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002'

const config: AppConfig = {
  runtimeMode: 'test',
  reportsUiMode: 'product',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1_024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl: undefined,
  rateLimitHmacSecret: 'test-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'test-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'test-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: false,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: false,
  engineMtls: undefined,
}

const fixture: CurrentTaxReport = {
  reportId: 'report-1', taxYear: 2027,
  finality: 'FINAL', status: 'PARTIAL', filingStatus: 'BLOCKED',
  denominationAssetId: 'asset-krw',
  pointerVersion: 1, issuedAt: '2028-01-10T00:00:00.000Z',
  counts: { disposals: 0, transfers: 0, excludedConversions: 1, limitations: 1 },
  summary: { gainLoss: { status: 'KNOWN', amount: '0' }, taxableBase: { status: 'UNKNOWN' }, nationalTax: { status: 'UNKNOWN' }, localTax: { status: 'UNKNOWN' }, totalTax: { status: 'UNKNOWN' } },
}

const generationStatusFixture: TaxReportGenerationStatus = {
  generationId: 'b'.repeat(64),
  state: 'BUILDING',
  taxYear: 2027,
  outcome: null,
  createdAt: '2028-01-09T00:00:00.000Z',
  completedAt: null,
  blockedReasonCode: 'GENERATION_BUILDING',
  hasCurrentReport: false,
}

class FakeTaxReportReader
  implements TaxReportReader, TaxReportGenerationStatusReader
{
  readonly durable = true
  calls: Array<{ subjectId: string; taxYear: number; finality: TaxReportFinality; residentId?: string }> = []
  statusCalls: Array<{
    subjectId: string
    taxYear: 2025 | 2026 | 2027
    finality: TaxReportFinality
    residentId?: string
  }> = []
  value: CurrentTaxReport | undefined = fixture
  statusValue: TaxReportGenerationStatus | undefined = generationStatusFixture
  failure: Error | undefined
  statusFailure: Error | undefined

  async getCurrent(subjectId: string, taxYear: number, finality: TaxReportFinality, residentId?: string) {
    this.calls.push({ subjectId, taxYear, finality, ...(residentId ? { residentId } : {}) })
    if (this.failure) throw this.failure
    return this.value
  }

  async getGenerationStatus(
    subjectId: string,
    taxYear: 2025 | 2026 | 2027,
    finality: TaxReportFinality = 'PROVISIONAL',
    residentId?: string,
  ) {
    this.statusCalls.push({
      subjectId, taxYear, finality, ...(residentId ? { residentId } : {}),
    })
    if (this.statusFailure) throw this.statusFailure
    return this.statusValue
  }
}

describe('current tax report route', () => {
  let context: Awaited<ReturnType<typeof buildApp>>
  let reader: FakeTaxReportReader

  beforeEach(async () => {
    reader = new FakeTaxReportReader()
    context = await buildApp({
      config,
      logger: false,
      taxReportReader: reader,
      taxReportGenerationStatusReader: reader,
    })
  })

  afterEach(async () => context.app.close())

  const createSession = () => context.sessionService.create({ user: { id: USER_ID, displayName: '김대장' } })

  it('derives the subject only from the authenticated session and returns a privacy-safe projection', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET', url: '/api/v1/tax-reports/2027/current',
      headers: { cookie: `${config.sessionCookieName}=${token}`, 'x-user-id': OTHER_USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(reader.calls).toEqual([{ subjectId: USER_ID, taxYear: 2027, finality: 'FINAL' }])
    expect(response.json()).toMatchObject({
      report: {
        status: 'PARTIAL',
        totalTax: { status: 'UNKNOWN', hasAmount: false },
      },
    })
    expect(response.json().report.totalTax).not.toHaveProperty('amount')
    expect(response.json().report).not.toHaveProperty('residentId')
    expect(response.json().report).not.toHaveProperty('evidencePackDigest')
  })

  it('supports 2025/2026 simulation reads and rejects 2024 before storage access', async () => {
    const { token } = await createSession()
    for (const taxYear of [2025, 2026]) {
      reader.value = { ...fixture, taxYear }
      const provisional = await context.app.inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${taxYear}/current?finality=PROVISIONAL`,
        headers: { cookie: `${config.sessionCookieName}=${token}` },
      })
      expect(provisional.statusCode).toBe(200)
      expect(reader.calls.at(-1)).toMatchObject({
        taxYear,
        finality: 'PROVISIONAL',
      })
      expect(provisional.json().report.taxYear).toBe(taxYear)
    }

    const invalid = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2024/current', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(invalid.statusCode).toBe(400)
    expect(reader.calls).toHaveLength(2)
  })

  it('rejects a client-supplied resident selector before storage access', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current?residentId=resident-1', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(response.statusCode).toBe(400)
    expect(reader.calls).toEqual([])
  })

  it('returns 404 without leaking whether another subject has a report', async () => {
    reader.value = undefined
    const { token } = await createSession()
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } })
  })
  it('fails closed with a stable correction-pending response without disclosing another subject', async () => {
    reader.failure = new CorrectionPendingError('invalid correction artifact')
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2027/current',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'CORRECTION_PENDING' } })
    expect(response.body).not.toContain(OTHER_USER_ID)
  })

  it('returns the generation gate reason from the authenticated subject only', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2027/status',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        'x-user-id': OTHER_USER_ID,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(reader.statusCalls).toEqual([
      { subjectId: USER_ID, taxYear: 2027, finality: 'PROVISIONAL' },
    ])
    expect(response.json()).toMatchObject({ status: generationStatusFixture })
    expect(response.json().status).toMatchObject({
      finality: 'PROVISIONAL',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      sourceCoverage: [],
    })
    expect(response.body).not.toContain(USER_ID)
    expect(response.body).not.toContain(OTHER_USER_ID)
  })

  it('returns NOT_STARTED instead of 404 when no generation exists', async () => {
    reader.statusValue = undefined
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2025/status',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: {
        generationId: null,
        state: 'NOT_STARTED',
        taxYear: 2025,
        outcome: null,
        createdAt: null,
        completedAt: null,
        blockedReasonCode: 'NOT_STARTED',
        hasCurrentReport: false,
      },
    })
  })

  it('returns the DB-owned application-pending state without inventing a generation', async () => {
    reader.statusValue = {
      generationId: null,
      state: 'NOT_STARTED',
      taxYear: 2027,
      outcome: null,
      createdAt: null,
      completedAt: null,
      blockedReasonCode: 'APPLICATION_PENDING',
      hasCurrentReport: false,
    }
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2027/status',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: reader.statusValue })
  })

  it('rejects unsupported status years before storage access', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2028/status',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(reader.statusCalls).toHaveLength(0)
  })

  it('fails closed when the persisted generation status is inconsistent', async () => {
    reader.statusFailure = new InconsistentTaxReportGenerationStatusError(
      'invalid status row',
    )
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2027/status',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'TAX_REPORT_STATUS_INCONSISTENT' },
    })
  })
})
