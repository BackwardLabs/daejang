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
  providerStatus: 'KNOWN', provider: 'UPBIT',
  datasetVersionStatus: 'KNOWN', datasetVersion: 'fixture-v1',
  marketStatus: 'KNOWN', market: 'KRW-BTC',
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
  filingSubmissionStatus: 'UNKNOWN',
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
  denominationAtomicDecimals: 8,
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
    openingBasisProvenance: { status: 'NOT_APPLICABLE' },
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
    costMethod: 'ANNUAL_TOTAL_AVERAGE',
    rounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
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
    denominationAtomicDecimals: 8,
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
      denominationAtomicDecimals: 8,
      dataCoverage: { status: 'PARTIAL' },
      assetSummaries: [{
        taxAssetId: 'BTC',
        openingBasisProvenance: { status: 'NOT_APPLICABLE' },
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
        valuation: {
          provider: 'UPBIT',
          datasetVersion: 'fixture-v1',
          market: 'KRW-BTC',
        },
      }],
      methodology: {
        sourceLedgerGenerationId: 'ledger-generation-1',
        policy: {
          denominationAtomicDecimals: 8,
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

  it('rejects a denomination scale that disagrees with the sealed policy', () => {
    const report = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({ ...report, denominationAtomicDecimals: 6 }),
      reportId,
    )).toThrow(/must equal the exact policy denomination scale/u)
  })

  it('accepts the canonical provisional zero-tax outcome', () => {
    const report = reportFixture()
    const projected = decodeAndProjectTaxReportModelV2(
      artifact({ ...report, taxOutcome: 'ESTIMATED_TAX_ZERO' }),
      reportId,
    )

    expect(projected.taxOutcome).toBe('ESTIMATED_TAX_ZERO')
  })

  it('rejects a KNOWN valuation whose immutable quote trace is incomplete', () => {
    const report = reportFixture()
    const { quoteId: _quoteId, ...valuationWithoutQuote } =
      report.acquisitions[0]!.valuation
    report.acquisitions[0]!.valuation = valuationWithoutQuote as
      typeof report.acquisitions[0]['valuation']

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/valuation completeness fields disagree/u)
  })

  it('rejects a row whose valuation identity disagrees with its nested trace', () => {
    const report = reportFixture()
    report.acquisitions[0] = {
      ...report.acquisitions[0]!,
      valuationId: 'valuation-other',
    }

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/valuation identity and nested trace must match exactly/u)
  })

  it('rejects an opening balance without its canonical transition evidence', () => {
    const report = reportFixture()
    report.assetSummaries[0]!.openingQuantity = '1'
    Object.assign(report.assetSummaries[0]!.openingBasisProvenance, {
      status: 'KNOWN',
      basisRule: 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET',
      actualAcquisitionAmount: '100',
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/KNOWN provenance is missing the evidence required by its basis rule/u)
  })

  it('rejects opening basis that contradicts the sealed transition evidence', () => {
    const report = reportFixture()
    Object.assign(report.assetSummaries[0]!, {
      openingQuantity: '1',
      openingBasis: known('150'),
      openingBasisProvenance: {
        status: 'KNOWN',
        basisRule: 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET',
        actualAcquisitionAmount: '100',
        marketValueAt2026End: '200',
      },
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/does not match the canonical opening-basis transition evidence/u)
  })

  it('rejects a transition rule that is unavailable in the report tax year', () => {
    const report = reportFixture()
    Object.assign(report.assetSummaries[0]!, {
      openingQuantity: '1',
      openingBasis: known('100'),
      openingBasisProvenance: {
        status: 'KNOWN',
        basisRule: 'ACTUAL_ACQUISITION',
        actualAcquisitionAmount: '100',
      },
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/must be PRE_EFFECTIVE_MAX_ACTUAL_MARKET for tax year 2027/u)
  })

  it('rejects a 50% deemed-expense asset decision without statutory evidence', () => {
    const report = reportFixture()
    report.assetSummaries[0]!.basisMode = 'DEEMED_EXPENSE_50'

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/50% deemed-expense mode and its statutory evidence must appear together/u)
  })

  it('rejects actual-cost disposal rows that carry deemed-expense evidence', () => {
    const report = reportFixture()
    Object.assign(report.disposals[0]!, {
      basisEvidenceDigest: digest('b'),
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/50% deemed-expense mode and its statutory evidence must appear together/u)
  })

  it('accepts one sealed 50% deemed-expense decision across the asset year', () => {
    const report = reportFixture()
    const evidence = digest('b')
    Object.assign(report.assetSummaries[0]!, {
      annualAverage: {
        status: 'NOT_APPLICABLE',
      },
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: evidence,
    })
    Object.assign(report.disposals[0]!, {
      rounding: 'CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS',
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: evidence,
    })

    const projected = decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )
    expect(projected.assetSummaries[0]).toMatchObject({
      annualAverage: { status: 'NOT_APPLICABLE' },
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: evidence,
    })
  })

  it('rejects a 50% average that carries total-average values', () => {
    const report = reportFixture()
    const evidence = digest('b')
    Object.assign(report.assetSummaries[0]!, {
      annualAverage: {
        status: 'NOT_APPLICABLE',
        numerator: '1',
      },
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: evidence,
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/NOT_APPLICABLE average must omit exact values/u)
  })

  it('rejects a disposal decision that differs from its asset-year election', () => {
    const report = reportFixture()
    Object.assign(report.disposals[0]!, {
      rounding: 'CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS',
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: digest('b'),
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/must match the asset-year basis decision exactly/u)
  })

  it('rejects a deemed-expense decision before tax year 2027', () => {
    const report = reportFixture()
    report.taxYear = 2026
    Object.assign(report.assetSummaries[0]!, {
      annualAverage: { status: 'NOT_APPLICABLE' },
      basisMode: 'DEEMED_EXPENSE_50',
      basisEvidenceDigest: digest('b'),
    })

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/unavailable before tax year 2027/u)
  })

  it('rejects a disposal rounding rule that contradicts its basis mode', () => {
    const report = reportFixture()
    report.disposals[0] = {
      ...report.disposals[0]!,
      rounding: 'CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS',
    }

    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(report),
      reportId,
    )).toThrow(/rounding/u)
  })

  it('rejects unknown acquisition and income classifications', () => {
    const acquisitionReport = reportFixture()
    acquisitionReport.acquisitions[0] = {
      ...acquisitionReport.acquisitions[0]!,
      transactionType: 'AIRDROP',
      kind: 'AIRDROP',
    }
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(acquisitionReport),
      reportId,
    )).toThrow(/acquisitions\[0\]\.kind/u)

    const incomeReport = reportFixture()
    const acquisition = incomeReport.acquisitions[0]!
    incomeReport.incomeRows.push({
      transactionType: 'STAKING_REWARD',
      movementId: acquisition.movementId,
      eventId: acquisition.eventId,
      revisionId: acquisition.revisionId,
      legId: acquisition.legId,
      kind: 'STAKING_REWARD',
      taxAssetId: acquisition.taxAssetId,
      ledgerAssetId: acquisition.ledgerAssetId,
      quantity: acquisition.quantity,
      valuationId: acquisition.valuationId,
      occurredAt: acquisition.occurredAt,
      account: acquisition.account,
      valuation: acquisition.valuation,
      sourceEvidence: acquisition.sourceEvidence,
      review: acquisition.review,
      income: known('1'),
      ancillaryExpense: known('0'),
    } as never)
    incomeReport.counts.incomeRows = 1
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact(incomeReport),
      reportId,
    )).toThrow(/incomeRows\[0\]\.kind/u)
  })

  it('requires filing submission status to match policy mode', () => {
    const enacted = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({ ...enacted, filingSubmissionStatus: 'NOT_APPLICABLE' }),
      reportId,
    )).toThrow(/must match the report policy application mode/u)

    const simulation = reportFixture()
    expect(() => decodeAndProjectTaxReportModelV2(
      artifact({
        ...simulation,
        filingSubmissionStatus: 'UNKNOWN',
        policy: { ...simulation.policy, applicationMode: 'SIMULATION' },
      }),
      reportId,
    )).toThrow(/must match the report policy application mode/u)
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
              providerStatus: 'UNKNOWN',
              datasetVersionStatus: 'UNKNOWN',
              marketStatus: 'UNKNOWN',
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
