import { createHash } from 'node:crypto'

import { status as grpcStatus } from '@grpc/grpc-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import {
  TAX_REPORT_MODEL_V1_MEDIA_TYPE,
  type TaxReportModelArtifact,
  type TaxReportModelReader,
} from '../tax-report/model-reader.js'
import type { CanonicalTaxReportModelV1 } from '../tax-report/public-model.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002'
const REPORT_ID = `tax-report:${'a'.repeat(64)}`

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

const canonicalModel = {
  schemaVersion: 'giwa.tax-report-model.v1',
  reportId: REPORT_ID,
  inputDigest: '1'.repeat(64),
  subjectId: 'subject-private-value',
  residentId: 'resident-private-value',
  taxYear: 2027,
  finality: 'FINAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  taxInventoryRunId: 'tax-inventory-run-1',
  taxEstimateId: 'tax-estimate-1',
  lotRunId: 'lot-run-1',
  generationId: 'generation-1',
  schemaDigest: '2'.repeat(64),
  denominationAssetId: 'KRW',
  evidencePackDigest: '3'.repeat(64),
  counts: {
    disposals: 1,
    transfers: 1,
    excludedConversions: 1,
    limitations: 1,
  },
  summary: {
    gainLoss: { status: 'KNOWN', amount: '500' },
    taxableBase: { status: 'UNKNOWN' },
    nationalTax: { status: 'UNKNOWN' },
    localTax: { status: 'UNKNOWN' },
    totalTax: { status: 'UNKNOWN' },
  },
  disposals: [
    {
      movementId: 'movement-disposal-1',
      eventId: 'event-1',
      revisionId: 'revision-1',
      legId: 'leg-1',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'BTC',
      ledgerAssetId: 'eip155:1/slip44:0',
      quantity: '10000000',
      grossProceeds: { status: 'KNOWN', amount: '1500' },
      ancillaryExpense: { status: 'KNOWN', amount: '0' },
      basis: { status: 'KNOWN', amount: '1000' },
      gainLoss: { status: 'KNOWN', amount: '500' },
      valuationId: 'valuation-1',
      costMethod: 'FIFO',
      rounding: 'HALF_UP',
    },
  ],
  transfers: [
    {
      movementId: 'movement-transfer-1',
      eventId: 'event-2',
      revisionId: 'revision-2',
      fromLegId: 'leg-2-from',
      toLegId: 'leg-2-to',
      fromAddressId: 'tax-address-1',
      toAddressId: 'tax-address-2',
      taxAssetId: 'ETH',
      quantity: '2000000000000000000',
      basis: { status: 'UNKNOWN' },
      fromCostMethod: 'FIFO',
      toCostMethod: 'FIFO',
    },
  ],
  excludedConversions: [
    {
      eventId: 'event-3',
      revisionId: 'revision-3',
      relationId: 'relation-3',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'USDT',
      fromLegId: 'leg-3-from',
      toLegId: 'leg-3-to',
      fromQuantity: '1000000',
      toQuantity: '1000000',
    },
  ],
  limitations: [
    {
      code: 'MISSING_VALUATION',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'USDT',
      movementId: 'movement-disposal-2',
      reason: '가격 근거를 확정하지 못했습니다.',
      reviewId: 'review-1',
      reviewRevisionId: 'review-revision-1',
    },
  ],
  policy: {
    name: 'giwa-korea-tax-policy',
    version: '2027.1',
    artifactDigest: '4'.repeat(64),
  },
  engine: {
    name: 'giwa-tax-engine',
    version: '1.0.0',
    artifactDigest: '5'.repeat(64),
  },
  issuedAt: '2028-01-10T00:00:00Z',
} as const satisfies CanonicalTaxReportModelV1

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`
}

const artifactFor = (
  model: unknown,
  serialize: (value: unknown) => string = canonicalJson,
): TaxReportModelArtifact => {
  const canonicalJsonBytes = Buffer.from(serialize(model), 'utf8')
  return {
    reportId: REPORT_ID,
    artifactDigest: createHash('sha256')
      .update(canonicalJsonBytes)
      .digest('hex'),
    mediaType: TAX_REPORT_MODEL_V1_MEDIA_TYPE,
    canonicalJson: canonicalJsonBytes,
  }
}

class FakeTaxReportModelReader implements TaxReportModelReader {
  readonly durable = true
  calls: Array<{
    context: SourceRequestContext
    reportId: string
  }> = []
  value = artifactFor(canonicalModel)
  failure: Error | undefined

  async getTaxReportModel(
    context: SourceRequestContext,
    reportId: string,
  ) {
    this.calls.push({ context, reportId })
    if (this.failure) throw this.failure
    return this.value
  }
}

describe('canonical tax report detail route', () => {
  let context: Awaited<ReturnType<typeof buildApp>>
  let reader: FakeTaxReportModelReader

  beforeEach(async () => {
    reader = new FakeTaxReportModelReader()
    context = await buildApp({
      config,
      logger: false,
      taxReportModelReader: reader,
    })
  })

  afterEach(async () => context.app.close())

  const createSession = () =>
    context.sessionService.create({
      user: { id: USER_ID, displayName: '김대장' },
    })

  it('uses the authenticated subject and returns only the public allowlist', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        'x-user-id': OTHER_USER_ID,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toMatchObject({
      context: { userId: USER_ID },
      reportId: REPORT_ID,
    })
    const report = response.json().report
    expect(report).toMatchObject({
      reportId: REPORT_ID,
      reportModelDigest: reader.value.artifactDigest,
      evidencePackDigest: canonicalModel.evidencePackDigest,
      taxYearCloseStatus: 'UNVERIFIED',
      summary: {
        gainLoss: {
          status: 'KNOWN',
          amount: '500',
          hasAmount: true,
        },
        totalTax: {
          status: 'UNKNOWN',
          amount: null,
          hasAmount: false,
        },
        calculationRule: null,
        calculationContract: 'UNSUPPORTED',
      },
      totals: {
        grossProceeds: {
          status: 'KNOWN',
          amount: '1500',
          hasAmount: true,
        },
        acquisitionCost: {
          status: 'KNOWN',
          amount: '1000',
          hasAmount: true,
        },
        ancillaryExpense: {
          status: 'KNOWN',
          amount: '0',
          hasAmount: true,
        },
        gainLoss: {
          status: 'KNOWN',
          amount: '500',
          hasAmount: true,
        },
      },
      assetSummaries: [
        {
          taxAssetId: 'BTC',
          disposalCount: 1,
          quantity: '10000000',
          grossProceeds: {
            status: 'KNOWN',
            amount: '1500',
            hasAmount: true,
          },
          acquisitionCost: {
            status: 'KNOWN',
            amount: '1000',
            hasAmount: true,
          },
          gainLoss: {
            status: 'KNOWN',
            amount: '500',
            hasAmount: true,
          },
        },
      ],
      disposals: [
        {
          grossProceeds: {
            status: 'KNOWN',
            amount: '1500',
            hasAmount: true,
          },
          eventId: 'event-1',
          rounding: 'HALF_UP',
        },
      ],
      limitations: [
        {
          reviewId: 'review-1',
          reviewRevisionId: 'review-revision-1',
        },
      ],
    })
    expect(report).not.toHaveProperty('subjectId')
    expect(report).not.toHaveProperty('residentId')
    expect(report).not.toHaveProperty('evidenceCoordinates')
    expect(report).not.toHaveProperty('artifactRoots')
    expect(response.body).not.toContain(canonicalModel.subjectId)
    expect(response.body).not.toContain(canonicalModel.residentId)
  })

  it('projects the annual total-average calculation contract', async () => {
    const annualModel = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    annualModel.disposals = annualModel.disposals.map((row) => ({
      ...row,
      costMethod: 'ANNUAL_TOTAL_AVERAGE',
      rounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }))
    annualModel.transfers = annualModel.transfers.map((row) => ({
      ...row,
      fromCostMethod: 'ANNUAL_TOTAL_AVERAGE',
      toCostMethod: 'ANNUAL_TOTAL_AVERAGE',
    }))
    annualModel.summary.calculationRule = {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }
    reader.value = artifactFor(annualModel)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().report.summary).toMatchObject({
      calculationContract: 'ANNUAL_TOTAL_AVERAGE',
      calculationRule: {
        poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
        costMethods: ['ANNUAL_TOTAL_AVERAGE'],
        basicDeductionAmount: '2500000',
        deductionUsedAmount: null,
        nationalRate: { numerator: '20', denominator: '100' },
        localRate: { numerator: '2', denominator: '100' },
        taxRounding: 'FLOOR',
        basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
      },
    })
  })

  it('does not approve an annual rule that conflicts with row cost methods', async () => {
    const conflictingModel = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    conflictingModel.summary.calculationRule = {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }
    reader.value = artifactFor(conflictingModel)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().report.summary.calculationContract).toBe(
      'UNSUPPORTED',
    )
  })

  it('does not approve an annual rule that conflicts with row rounding', async () => {
    const conflictingModel = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    conflictingModel.disposals = conflictingModel.disposals.map((row) => ({
      ...row,
      costMethod: 'ANNUAL_TOTAL_AVERAGE',
      rounding: 'HALF_UP',
    }))
    conflictingModel.transfers = conflictingModel.transfers.map((row) => ({
      ...row,
      fromCostMethod: 'ANNUAL_TOTAL_AVERAGE',
      toCostMethod: 'ANNUAL_TOTAL_AVERAGE',
    }))
    conflictingModel.summary.calculationRule = {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }
    reader.value = artifactFor(conflictingModel)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().report.summary.calculationContract).toBe(
      'UNSUPPORTED',
    )
  })

  it('does not approve the annual contract when the KRW deduction uses the wrong atomic scale', async () => {
    const annualModel = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    annualModel.denominationAssetId = 'asset-krw-upbit'
    annualModel.disposals = annualModel.disposals.map((row) => ({
      ...row,
      costMethod: 'ANNUAL_TOTAL_AVERAGE',
      rounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }))
    annualModel.transfers = annualModel.transfers.map((row) => ({
      ...row,
      fromCostMethod: 'ANNUAL_TOTAL_AVERAGE',
      toCostMethod: 'ANNUAL_TOTAL_AVERAGE',
    }))
    annualModel.summary.calculationRule = {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }
    reader.value = artifactFor(annualModel)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().report.summary).toMatchObject({
      calculationContract: 'UNSUPPORTED',
      calculationRule: {
        basicDeductionAmount: '2500000',
      },
    })
  })

  it('rejects a malformed calculation rule', async () => {
    const malformed = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    malformed.summary.calculationRule = {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      deductionUsedAmount: '500',
      nationalRate: { numerator: '20', denominator: '0' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    }
    reader.value = artifactFor(malformed)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'TAX_REPORT_MODEL_INCONSISTENT' },
    })
  })

  it('keeps a derived total unknown when any included disposal amount is unknown', async () => {
    const partialModel = structuredClone(
      canonicalModel,
    ) as unknown as CanonicalTaxReportModelV1
    partialModel.counts.disposals = 2
    const firstDisposal = partialModel.disposals[0]!
    partialModel.disposals.push({
      movementId: 'movement-disposal-2',
      eventId: 'event-4',
      revisionId: firstDisposal.revisionId,
      legId: firstDisposal.legId,
      taxAddressId: firstDisposal.taxAddressId,
      taxAssetId: firstDisposal.taxAssetId,
      ledgerAssetId: firstDisposal.ledgerAssetId,
      quantity: firstDisposal.quantity,
      grossProceeds: { status: 'KNOWN', amount: '2500' },
      ancillaryExpense: firstDisposal.ancillaryExpense,
      basis: { status: 'UNKNOWN' },
      gainLoss: { status: 'UNKNOWN' },
      costMethod: firstDisposal.costMethod,
    })
    reader.value = artifactFor(partialModel)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().report).toMatchObject({
      totals: {
        grossProceeds: {
          status: 'KNOWN',
          amount: '4000',
          hasAmount: true,
        },
        acquisitionCost: {
          status: 'UNKNOWN',
          amount: null,
          hasAmount: false,
        },
        gainLoss: {
          status: 'UNKNOWN',
          amount: null,
          hasAmount: false,
        },
      },
      assetSummaries: [
        {
          taxAssetId: 'BTC',
          disposalCount: 2,
          acquisitionCost: {
            status: 'UNKNOWN',
            amount: null,
            hasAmount: false,
          },
        },
      ],
    })
  })

  it('accepts 2025/2026 canonical simulation reports and rejects 2024', async () => {
    const { token } = await createSession()
    const headers = {
      cookie: `${config.sessionCookieName}=${token}`,
    }

    for (const taxYear of [2025, 2026]) {
      reader.value = artifactFor({ ...canonicalModel, taxYear })
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${REPORT_ID}`,
        headers,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().report.taxYear).toBe(taxYear)
      expect(response.json().report).not.toHaveProperty('policySimulation')
    }

    reader.value = artifactFor({ ...canonicalModel, taxYear: 2024 })
    const invalid = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers,
    })
    expect(invalid.statusCode).toBe(503)
    expect(invalid.json()).toMatchObject({
      error: { code: 'TAX_REPORT_MODEL_INCONSISTENT' },
    })
  })

  it('fails closed instead of converting UNKNOWN to zero', async () => {
    const malformed = structuredClone(canonicalModel) as unknown as {
      summary: { totalTax: unknown }
    }
    malformed.summary.totalTax = { status: 'UNKNOWN', amount: '0' }
    reader.value = artifactFor(malformed)
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'TAX_REPORT_MODEL_INCONSISTENT' },
    })
    expect(response.body).not.toContain('artifact.canonicalJson')
  })

  it('rejects unknown canonical fields, non-canonical bytes and digest mismatch', async () => {
    const { token } = await createSession()
    const headers = {
      cookie: `${config.sessionCookieName}=${token}`,
    }
    reader.value = artifactFor({
      ...canonicalModel,
      evidenceCoordinates: [{ kind: 'POSTING' }],
    })
    const unknownField = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers,
    })
    expect(unknownField.statusCode).toBe(503)

    reader.value = artifactFor(
      canonicalModel,
      (value) => JSON.stringify(value, null, 2),
    )
    const nonCanonical = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers,
    })
    expect(nonCanonical.statusCode).toBe(503)

    reader.value = {
      ...artifactFor(canonicalModel),
      artifactDigest: 'f'.repeat(64),
    }
    const digestMismatch = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
      headers,
    })
    expect(digestMismatch.statusCode).toBe(503)
  })

  it('returns the same 404 for missing and cross-subject report IDs', async () => {
    const { token } = await createSession()
    const headers = {
      cookie: `${config.sessionCookieName}=${token}`,
    }
    for (const grpcCode of [
      grpcStatus.NOT_FOUND,
      grpcStatus.PERMISSION_DENIED,
    ]) {
      reader.failure = new EngineRpcError(grpcCode)
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${REPORT_ID}`,
        headers,
      })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({
        error: { code: 'RESOURCE_NOT_FOUND' },
      })
    }
  })

  it('rejects malformed report IDs and unauthenticated reads before Engine access', async () => {
    const unauthenticated = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}`,
    })
    expect(unauthenticated.statusCode).toBe(401)

    const { token } = await createSession()
    const malformed = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tax-reports/not-a-report-id',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
      },
    })
    expect(malformed.statusCode).toBe(400)
    expect(reader.calls).toHaveLength(0)
  })
})
