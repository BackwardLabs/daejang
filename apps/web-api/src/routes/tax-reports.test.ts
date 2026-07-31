import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import type { CurrentTaxReport, TaxReportFinality, TaxReportReader } from '../tax-report/types.js'
import { CorrectionPendingError } from '../tax-report/postgres-tax-report-reader.js'

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

class FakeTaxReportReader implements TaxReportReader {
  readonly durable = true
  calls: Array<{ subjectId: string; taxYear: number; finality: TaxReportFinality; residentId?: string }> = []
  value: CurrentTaxReport | undefined = fixture
  failure: Error | undefined

  async getCurrent(subjectId: string, taxYear: number, finality: TaxReportFinality, residentId?: string) {
    this.calls.push({ subjectId, taxYear, finality, ...(residentId ? { residentId } : {}) })
    if (this.failure) throw this.failure
    return this.value
  }
}

describe('current tax report route', () => {
  let context: Awaited<ReturnType<typeof buildApp>>
  let reader: FakeTaxReportReader

  beforeEach(async () => {
    reader = new FakeTaxReportReader()
    context = await buildApp({ config, logger: false, taxReportReader: reader })
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

  it('supports explicit provisional reads and rejects invalid years before storage access', async () => {
    const { token } = await createSession()
    const provisional = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current?finality=PROVISIONAL', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(provisional.statusCode).toBe(200)
    expect(reader.calls.at(-1)?.finality).toBe('PROVISIONAL')

    const invalid = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2026/current', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(invalid.statusCode).toBe(400)
    expect(reader.calls).toHaveLength(1)
  })

  it('allows an explicit resident selector but still scopes the lookup to the session subject', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/tax-reports/2027/current?residentId=resident-1', headers: { cookie: `${config.sessionCookieName}=${token}` } })
    expect(response.statusCode).toBe(200)
    expect(reader.calls).toEqual([{ subjectId: USER_ID, taxYear: 2027, finality: 'FINAL', residentId: 'resident-1' }])
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
      url: '/api/v1/tax-reports/2027/current?residentId=resident-1',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'CORRECTION_PENDING' } })
    expect(response.body).not.toContain(OTHER_USER_ID)
  })
})
