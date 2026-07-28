import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import { assertTaxReportSchema } from '../database/preflight.js'
import { PostgresTaxReportReader } from './postgres-tax-report-reader.js'

const databaseUrl = process.env.TAX_REPORT_TEST_DATABASE_URL
const describeWithPostgres = databaseUrl ? describe : describe.skip

describeWithPostgres('PostgreSQL tax report reader', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const reader = new PostgresTaxReportReader(pool)
  const config: AppConfig = {
    runtimeMode: 'test',
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
    databaseUrl,
    rateLimitHmacSecret: 'tax-report-integration-secret',
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
    engineMtls: undefined,
  }
  let appContext: Awaited<ReturnType<typeof buildApp>>
  let subjectId = ''
  let taxYear = 0
  let finality: 'FINAL' | 'PROVISIONAL' = 'FINAL'
  let residentId = ''

  beforeAll(async () => {
    await assertTaxReportSchema(pool)
    const result = await pool.query<{ subject_id: string; tax_year: number; finality: 'FINAL' | 'PROVISIONAL'; resident_id: string }>(
      `SELECT subject_id,tax_year,finality,resident_id FROM reporting.current_tax_report ORDER BY updated_at DESC LIMIT 1`,
    )
    const row = result.rows[0]
    if (!row) throw new Error('The integration database has no current tax report')
    subjectId = row.subject_id
    taxYear = row.tax_year
    finality = row.finality
    residentId = row.resident_id
    appContext = await buildApp({ config, logger: false, taxReportReader: reader })
  })

  afterAll(async () => {
    await appContext?.app.close()
    await pool.end()
  })

  it('reads one published summary without UNKNOWN zero fabrication', async () => {
    const report = await reader.getCurrent(subjectId, taxYear, finality, residentId)
    expect(report).toBeDefined()
    expect(Object.values(report?.counts ?? {}).every((count) => Number.isInteger(count) && count >= 0)).toBe(true)
    if (report?.summary.totalTax.status === 'UNKNOWN') {
      expect(report.summary.totalTax).not.toHaveProperty('amount')
    }
  })

  it('serves the persisted report through the authenticated HTTP contract', async () => {
    const { token } = await appContext.sessionService.create({ user: { id: subjectId, displayName: 'integration subject' } })
    const response = await appContext.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${taxYear}/current?finality=${finality}&residentId=${encodeURIComponent(residentId)}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ report: { taxYear, finality } })
    expect(response.json().report).not.toHaveProperty('residentId')
    expect(response.json().report).not.toHaveProperty('evidencePackDigest')
  })
})
