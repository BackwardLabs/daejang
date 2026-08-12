import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  TAX_REPORT_MODEL_V2_MEDIA_TYPE,
  type TaxReportModelArtifact,
} from './model-reader.js'
import {
  decodeAndProjectTaxReportModelV2,
  InvalidTaxReportModelV2Error,
  publicTaxReportV2DetailSchema,
} from './public-model-v2.js'

const reportId = `tax-report-v2:${'a'.repeat(64)}`
const digest = (character: string) => character.repeat(64)
const known = (amount: string) => ({ status: 'KNOWN', amount })
const clearReview = { status: 'CLEAR', limitations: [] }
const account = {
  status: 'KNOWN', accountId: 'upbit-account-1', accountKind: 'CEX',
  displayNameStatus: 'UNKNOWN',
}
const valuation = {
  status: 'KNOWN', valuationId: 'valuation-1', kind: 'MARKET_QUOTE',
  effectiveAt: '2027-03-01T00:00:00Z', quoteId: 'quote-1',
  snapshotArtifactDigest: digest('9'), baseAtomicUnits: '25000000',
  quoteAtomicUnits: '2250000000000000', rounding: 'FLOOR',
}
const sourceEvidence = [{
  legId: 'leg-1', fragmentId: 'fragment-1', observationId: 'observation-1',
  sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'],
  sourceKinds: ['FILE'],
}]

const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(row[key])}`).join(',')}}`
}

const reportFixture = () => ({
  schemaVersion: 'giwa.tax-report-model.v2',
  reportId,
  inputDigest: digest('1'),
  subjectId: 'private-subject',
  residentId: 'private-resident',
  taxYear: 2027,
  status: 'PARTIAL',
  calculationStatus: 'COMPLETE',
  taxOutcome: 'ESTIMATED_TAX_DUE',
  filingAction: 'REVIEW_REQUIRED',
  filingStatus: 'BLOCKED',
  filingSubmissionStatus: 'NOT_SUBMITTED',
  inputPeriod: {
    from: '2026-12-31T15:00:00Z',
    through: '2027-12-31T14:59:59.999999999Z',
  },
  dataCoverage: {
    status: 'PARTIAL',
    assurance: 'DOCUMENT_METADATA_VERIFIED',
    from: '2026-12-31T15:00:00Z',
    through: '2027-06-30T14:59:59.999999999Z',
    coveredIntervals: [{
      from: '2026-12-31T15:00:00Z',
      through: '2027-06-30T14:59:59.999999999Z',
    }],
    uncoveredIntervals: [{
      from: '2027-06-30T15:00:00Z',
      through: '2027-12-31T14:59:59.999999999Z',
    }],
  },
  calculatedAsOf: '2027-07-01T00:00:00Z',
  taxYearCloseStatus: 'OPEN',
  valuationFinality: 'PROVISIONAL',
  reportFinality: 'PROVISIONAL',
  taxInventoryRunId: 'inventory-run-1',
  taxEstimateId: 'estimate-1',
  lotRunId: 'lot-run-1',
  sourceLedgerGenerationId: 'ledger-generation-1',
  schemaDigest: digest('2'),
  denominationAssetId: 'asset-krw-upbit',
  evidencePackDigest: digest('3'),
  counts: {
    assetSummaries: 1,
    disposals: 1,
    feeAssetDisposals: 0,
    acquisitions: 1,
    incomeRows: 0,
    transfers: 1,
    nonTaxableTransfers: 1,
    limitations: 0,
    sourceArtifacts: 1,
  },
  summary: {
    grossProceeds: known('2250000000000000'),
    disposedBasis: known('1750000000000000'),
    deductibleExpense: known('100000000'),
    incurredExpense: known('100000000'),
    disposalGainLoss: known('12500000000000'),
    lendingIncome: known('0'),
    lendingExpense: known('0'),
    netLendingIncome: known('0'),
    taxableIncome: known('12500000000000'),
    taxableBase: known('10000000000000'),
    nationalTax: known('2000000000000'),
    localTax: known('200000000000'),
    totalTax: known('2200000000000'),
    calculationRule: {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '250000000000000',
      deductionUsedAmount: '250000000000000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    },
  },
  assetSummaries: [{
    taxAssetId: 'BTC',
    openingQuantity: '0',
    openingBasis: known('0'),
    acquiredQuantity: '100000000',
    acquisitionCost: known('7000000000000000'),
    annualAverage: {
      status: 'KNOWN',
      numerator: '7000000000000000',
      denominator: '100000000',
      unitCost: '70000000',
      unitCostNumerator: '7000000000000000',
      unitCostDenominator: '100000000',
      rounding: 'FLOOR',
    },
    disposedQuantity: '25000000',
    grossProceeds: known('2250000000000000'),
    incurredExpense: known('100000000'),
    deductibleExpense: known('100000000'),
    disposedBasis: known('1750000000000000'),
    gainLoss: known('499999900000000'),
    endingQuantity: '75000000',
    endingCost: known('5250000000000000'),
    basisMode: 'ACTUAL_TOTAL_AVERAGE',
  }],
  disposals: [{
    transactionType: 'DISPOSAL', movementId: 'movement-1', eventId: 'event-1',
    revisionId: 'revision-1', legId: 'leg-1', taxAddressId: 'address-1',
    taxAssetId: 'BTC', ledgerAssetId: 'bitcoin', quantity: '25000000',
    grossProceeds: known('2250000000000000'), ancillaryExpense: known('0'),
    incurredExpense: known('0'), basis: known('1750000000000000'),
    gainLoss: known('500000000000000'), valuationId: 'valuation-1',
    costMethod: 'ANNUAL_TOTAL_AVERAGE', rounding: 'FLOOR',
    basisMode: 'ACTUAL_TOTAL_AVERAGE', occurredAt: '2027-03-01T00:00:00Z',
    account, valuation, sourceEvidence, review: clearReview,
  }],
  feeAssetDisposals: [],
  acquisitions: [{
    transactionType: 'OTHER_ACQUISITION', movementId: 'acquisition-1',
    eventId: 'event-4', revisionId: 'revision-1', legId: 'leg-acquisition',
    kind: 'OTHER_ACQUISITION', taxAssetId: 'ETH', ledgerAssetId: 'ethereum',
    quantity: '1000', valuationId: 'valuation-1', occurredAt: '2027-02-01T00:00:00Z',
    consideration: known('500000'), acquisitionAncillaryExpense: known('1000'),
    acquisitionCost: known('501000'), account, valuation, sourceEvidence,
    review: clearReview,
  }],
  incomeRows: [],
  transfers: [{
    transactionType: 'TRANSFER', movementId: 'transfer-1', eventId: 'event-2',
    revisionId: 'revision-1', fromLegId: 'leg-from', toLegId: 'leg-to',
    fromAddressId: 'address-1', toAddressId: 'address-2', taxAssetId: 'BTC',
    quantity: '10000000', basis: known('700000000000000'),
    fromCostMethod: 'ANNUAL_TOTAL_AVERAGE',
    toCostMethod: 'ANNUAL_TOTAL_AVERAGE', occurredAt: '2027-04-01T00:00:00Z',
    from: account,
    to: { ...account, accountId: 'wallet-account-1', accountKind: 'EVM_WALLET' },
    sourceEvidence, review: clearReview,
  }],
  nonTaxableTransfers: [{
    transactionType: 'SELF_TRANSFER', movementId: 'self-transfer-1',
    eventId: 'event-3', revisionId: 'revision-1', fromLegId: 'self-from',
    toLegId: 'self-to', taxAssetId: 'ETH', quantity: '1000',
    occurredAt: '2027-05-01T00:00:00Z', from: account,
    to: { ...account, accountId: 'wallet-account-2', accountKind: 'EVM_WALLET' },
    sourceEvidence, review: clearReview,
  }],
  excludedConversions: [],
  limitations: [],
  sourceCoverage: [{
    sourceArtifactId: 'source-1',
    sourceKind: 'FILE',
    systemName: 'UPBIT',
    assurance: 'DOCUMENT_METADATA_VERIFIED',
    status: 'PARTIAL',
    evidenceDigest: digest('7'),
    fragmentIds: ['fragment-1'],
    coveredIntervals: [{
      from: '2026-12-31T15:00:00Z',
      through: '2027-06-30T14:59:59.999999999Z',
    }],
    uncoveredIntervals: [{
      from: '2027-06-30T15:00:00Z',
      through: '2027-12-31T14:59:59.999999999Z',
    }],
  }],
  policy: {
    name: 'kr-virtual-asset-tax',
    version: '2027.1',
    artifactDigest: digest('4'),
    sourceSetDigest: digest('5'),
    applicationMode: 'ENACTED',
    effectiveFrom: '2027-01-01T00:00:00Z',
    effectiveThrough: '2027-12-31T23:59:59Z',
    roundingProfileStatus: 'ESTIMATE_ONLY_UNAPPROVED',
    legalReferences: [{
      law: '소득세법',
      article: '제37조',
      paragraphs: ['제1항'],
      purpose: '필요경비 계산 기준',
      sourceLocators: ['https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405'],
      sourceCheckedAt: '2026-08-03T15:00:00Z',
    }],
  },
  engine: {
    name: 'daejang-tax-engine',
    version: '2.0.0',
    artifactDigest: digest('6'),
  },
  issuedAt: '2027-07-01T00:00:00Z',
})

const artifact = (value: unknown): TaxReportModelArtifact => {
  const canonicalJson = Buffer.from(canonicalStringify(value))
  return {
    reportId,
    artifactDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    mediaType: TAX_REPORT_MODEL_V2_MEDIA_TYPE,
    canonicalJson,
  }
}

describe('ReportModel V2 public projection', () => {
  it('projects exact V2 calculation and coverage fields without private identities', () => {
    const projected = decodeAndProjectTaxReportModelV2(
      artifact(reportFixture()),
      reportId,
    )

    expect(projected).toMatchObject({
      schemaVersion: 'giwa.tax-report-model.v2',
      reportId,
      dataCoverage: { status: 'PARTIAL' },
      assetSummaries: [{
        taxAssetId: 'BTC',
        basisMode: 'ACTUAL_TOTAL_AVERAGE',
        annualAverage: {
          numerator: '7000000000000000',
          denominator: '100000000',
          unitCost: '70000000',
        },
      }],
      transfers: [{ transactionType: 'TRANSFER', movementId: 'transfer-1' }],
      nonTaxableTransfers: [{
        transactionType: 'SELF_TRANSFER', movementId: 'self-transfer-1',
      }],
      acquisitions: [{
        consideration: { amount: '500000' },
        acquisitionAncillaryExpense: { amount: '1000' },
        acquisitionCost: { amount: '501000' },
      }],
      methodology: {
        sourceLedgerGenerationId: 'ledger-generation-1',
        policy: {
          roundingProfileStatus: 'ESTIMATE_ONLY_UNAPPROVED',
          roundingProfileEvidenceDigest: null,
          legalReferences: [{
            law: '소득세법',
            sourceLocators: ['https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405'],
            sourceCheckedAt: '2026-08-03T15:00:00Z',
          }],
        },
      },
      sourceCoverage: [{ systemName: 'UPBIT' }],
      summary: {
        grossProceeds: { amount: '2250000000000000' },
        disposedBasis: { amount: '1750000000000000' },
        deductibleExpense: { amount: '100000000' },
        incurredExpense: { amount: '100000000' },
      },
    })
    expect(projected).not.toHaveProperty('subjectId')
    expect(projected).not.toHaveProperty('residentId')
  })

  it('fails closed on unknown fields instead of forwarding them to the browser', () => {
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({ ...reportFixture(), subjectDisplayName: 'private-name' }),
      reportId,
    )).toThrow(InvalidTaxReportModelV2Error)
  })

  it('rejects an acquisition whose consideration and fee do not equal total cost', () => {
    const report = reportFixture()
    report.acquisitions[0]!.acquisitionCost = known('999999')
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(InvalidTaxReportModelV2Error)
  })

  it('rejects the DB report generation field at the artifact boundary', () => {
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({ ...reportFixture(), generationId: 'db-generation-1' }),
      reportId,
    )).toThrow(InvalidTaxReportModelV2Error)
  })

  it('rejects a claimed approved rounding profile without evidence', () => {
    const report = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({
        ...report,
        policy: { ...report.policy, roundingProfileStatus: 'APPROVED' },
      }),
      reportId,
    )).toThrow(/rounding profile approval and evidence disagree/u)
  })

  it('rejects a filing-ready flag that contradicts the canonical action', () => {
    const report = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({ ...report, filingStatus: 'READY' }),
      reportId,
    )).toThrow(/must agree with the canonical filing action/u)
  })

  it('rejects a zero-time trace attached to an unknown valuation', () => {
    const report = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({
        ...report,
        acquisitions: report.acquisitions.map((row) => {
          const { valuationId: _valuationId, ...withoutValuationId } = row
          return {
            ...withoutValuationId,
            valuation: {
              status: 'UNKNOWN',
              effectiveAt: '0001-01-01T00:00:00Z',
            },
          }
        }),
      }),
      reportId,
    )).toThrow(/valuation completeness fields disagree/u)
  })

  it('fails closed when materialized counts do not match their arrays', () => {
    const value = reportFixture()
    value.counts.assetSummaries = 0
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(value),
      reportId,
    )).toThrow(/does not match materialized arrays/u)
  })

  it('serializes the complete public allowlist without reopening private fields', async () => {
    const projected = decodeAndProjectTaxReportModelV2(
      artifact(reportFixture()),
      reportId,
    )
    const app = Fastify({ logger: false })
    app.get('/', {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['report'],
            properties: { report: publicTaxReportV2DetailSchema },
          },
        },
      },
    }, async () => ({ report: projected }))

    try {
      const response = await app.inject({ method: 'GET', url: '/' })
      expect(response.statusCode).toBe(200)
      expect(response.json().report).toEqual(projected)
      expect(response.body).not.toContain('private-subject')
      expect(response.body).not.toContain('private-resident')
    } finally {
      await app.close()
    }
  })
})
