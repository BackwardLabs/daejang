import { createHash } from 'node:crypto'

import { status as grpcStatus } from '@grpc/grpc-js'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import {
  TAX_REPORT_MODEL_V1_MEDIA_TYPE,
  type TaxReportModelArtifact,
  type TaxReportModelReader,
} from '../tax-report/model-reader.js'
import type { ReportPrintModelV1 } from '../tax-report/pdf/report-print-model.js'
import { registerTaxReportArtifactRoutes } from './tax-report-artifacts.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const REPORT_ID = `tax-report:${'a'.repeat(64)}`
const PDF_BYTES = Buffer.from('%PDF-1.7\nfixture', 'ascii')

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

const canonicalModel = {
  counts: {
    disposals: 1,
    excludedConversions: 0,
    limitations: 1,
    transfers: 0,
  },
  denominationAssetId: 'KRW',
  disposals: [
    {
      ancillaryExpense: { amount: '0', status: 'KNOWN' },
      basis: { status: 'UNKNOWN' },
      costMethod: 'FIFO',
      eventId: 'event-1',
      gainLoss: { status: 'UNKNOWN' },
      grossProceeds: { amount: '1500', status: 'KNOWN' },
      ledgerAssetId: 'eip155:1/slip44:0',
      legId: 'leg-1',
      movementId: 'movement-1',
      quantity: '10000000',
      revisionId: 'revision-1',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'BTC',
    },
  ],
  engine: {
    artifactDigest: '5'.repeat(64),
    name: 'daejang-tax-engine',
    version: '1.0.0',
  },
  evidencePackDigest: '3'.repeat(64),
  excludedConversions: [],
  filingStatus: 'BLOCKED',
  finality: 'FINAL',
  generationId: 'generation-1',
  inputDigest: '1'.repeat(64),
  issuedAt: '2028-01-10T00:00:00Z',
  limitations: [
    {
      code: 'MISSING_VALUATION',
      movementId: 'movement-1',
      reason: '가격 근거를 확정하지 못했습니다.',
      reviewId: 'review-1',
      reviewRevisionId: 'review-revision-1',
      taxAssetId: 'BTC',
    },
  ],
  lotRunId: 'lot-run-1',
  policy: {
    artifactDigest: '4'.repeat(64),
    name: 'giwa-korea-tax-policy',
    version: '2027.1',
  },
  reportId: REPORT_ID,
  residentId: 'resident-private-value',
  schemaDigest: '2'.repeat(64),
  schemaVersion: 'giwa.tax-report-model.v1',
  status: 'PARTIAL',
  subjectId: 'subject-private-value',
  summary: {
    gainLoss: { status: 'UNKNOWN' },
    localTax: { status: 'UNKNOWN' },
    nationalTax: { status: 'UNKNOWN' },
    taxableBase: { status: 'UNKNOWN' },
    totalTax: { status: 'UNKNOWN' },
  },
  taxEstimateId: 'tax-estimate-1',
  taxInventoryRunId: 'tax-inventory-run-1',
  taxYear: 2027,
  transfers: [],
}

const artifactFor = (value: unknown): TaxReportModelArtifact => {
  const bytes = Buffer.from(canonicalJson(value), 'utf8')
  return {
    reportId: REPORT_ID,
    artifactDigest: createHash('sha256').update(bytes).digest('hex'),
    mediaType: TAX_REPORT_MODEL_V1_MEDIA_TYPE,
    canonicalJson: bytes,
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

const session: SessionRecord = {
  id: 'session-1',
  user: { id: USER_ID, displayName: '김대장' },
  sessionEpoch: 1,
  createdAt: new Date('2028-01-10T00:00:00Z'),
  lastSeenAt: new Date('2028-01-10T00:00:00Z'),
  absoluteExpiresAt: new Date('2028-01-11T00:00:00Z'),
  idleExpiresAt: new Date('2028-01-10T01:00:00Z'),
}

describe('tax report PDF artifact route', () => {
  let app: ReturnType<typeof Fastify>
  let reader: FakeTaxReportModelReader
  let rendered: ReportPrintModelV1 | undefined

  beforeEach(async () => {
    app = Fastify({ logger: false })
    app.decorateRequest('authSession', undefined)
    app.addHook('onRequest', async (request: FastifyRequest) => {
      request.authSession =
        request.headers['x-test-unauthenticated'] === 'true'
          ? undefined
          : session
    })
    reader = new FakeTaxReportModelReader()
    rendered = undefined
    await registerTaxReportArtifactRoutes(app, {
      reader,
      loadFont: async () => Buffer.from('test-font'),
      renderPdf: async (model) => {
        rendered = model
        return PDF_BYTES
      },
    })
  })

  afterEach(async () => app.close())

  it('renders the exact authenticated report with download integrity headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.rawPayload.equals(PDF_BYTES)).toBe(true)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toContain(
      `daejang-tax-report-2027-${REPORT_ID.replace(':', '_')}.pdf`,
    )
    expect(response.headers['x-report-id']).toBe(REPORT_ID)
    expect(response.headers.etag).toBe(
      `"sha256-${createHash('sha256').update(PDF_BYTES).digest('hex')}"`,
    )
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toMatchObject({
      context: { userId: USER_ID, sessionId: session.id },
      reportId: REPORT_ID,
    })
    expect(rendered).toMatchObject({
      reportId: REPORT_ID,
      summary: {
        totalTax: { status: 'UNKNOWN' },
        calculationContract: 'UNSUPPORTED',
      },
      disposals: [
        {
          ancillaryExpense: { status: 'KNOWN', amount: '0' },
          basis: { status: 'UNKNOWN' },
        },
      ],
      limitations: [
        {
          reviewId: 'review-1',
          reviewRevisionId: 'review-revision-1',
        },
      ],
    })
    expect(rendered).not.toHaveProperty('subjectId')
    expect(rendered).not.toHaveProperty('residentId')
    expect(rendered).not.toHaveProperty('publication')
    expect(rendered).not.toHaveProperty('payment')
    expect(rendered?.summary).not.toHaveProperty('calculationRule')
  })

  it('allowlists the Tax Engine calculation rule for the PDF', async () => {
    reader.value = artifactFor({
      ...canonicalModel,
      summary: {
        ...canonicalModel.summary,
        calculationRule: {
          poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
          costMethods: ['ANNUAL_TOTAL_AVERAGE'],
          basicDeductionAmount: '2500000',
          deductionUsedAmount: '1250000',
          nationalRate: { numerator: '20', denominator: '100' },
          localRate: { numerator: '2', denominator: '100' },
          taxRounding: 'FLOOR',
          basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
        },
      },
    })

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
    })

    expect(response.statusCode).toBe(200)
    expect(rendered?.summary).toMatchObject({
      calculationContract: 'ANNUAL_TOTAL_AVERAGE',
      calculationRule: {
        poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
        costMethods: ['ANNUAL_TOTAL_AVERAGE'],
        basicDeductionAmount: '2500000',
        deductionUsedAmount: '1250000',
        nationalRate: { numerator: '20', denominator: '100' },
        localRate: { numerator: '2', denominator: '100' },
        taxRounding: 'FLOOR',
        basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
      },
    })
  })

  it('renders a 2026 policy simulation PDF without adding simulation fields to the print model', async () => {
    reader.value = artifactFor({ ...canonicalModel, taxYear: 2026 })
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-disposition']).toContain(
      `daejang-tax-simulation-2026-${REPORT_ID.replace(':', '_')}.pdf`,
    )
    expect(rendered).toMatchObject({
      reportId: REPORT_ID,
      taxYear: 2026,
    })
    expect(rendered).not.toHaveProperty('policySimulation')
    expect(rendered).not.toHaveProperty('policyEffectiveFrom')
  })

  it('does not query or render a report without an authenticated session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
      headers: { 'x-test-unauthenticated': 'true' },
    })

    expect(response.statusCode).toBe(401)
    expect(reader.calls).toHaveLength(0)
    expect(rendered).toBeUndefined()
  })

  it('conceals missing and cross-subject reports with the same 404', async () => {
    for (const grpcCode of [
      grpcStatus.NOT_FOUND,
      grpcStatus.PERMISSION_DENIED,
    ]) {
      reader.failure = new EngineRpcError(grpcCode)
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
      })

      expect(response.statusCode).toBe(404)
      expect(rendered).toBeUndefined()
    }
  })

  it('fails closed before rendering an inconsistent canonical model', async () => {
    reader.value = {
      ...artifactFor(canonicalModel),
      artifactDigest: 'f'.repeat(64),
    }
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/artifacts/pdf`,
    })

    expect(response.statusCode).toBe(503)
    expect(rendered).toBeUndefined()
  })
})
