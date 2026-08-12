import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaxReportDetailV2 } from './TaxReportDetailV2.tsx'
import type { TaxReportV2DetailModel } from './taxReportApi.ts'

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:tax-report-pdf')
  revokeObjectURL = vi.fn()
  const NativeURL = globalThis.URL
  class TestURL extends NativeURL {}
  Object.defineProperties(TestURL, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  })
  vi.stubGlobal('URL', TestURL)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/artifacts/pdf')) {
      const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        blob: vi.fn(async () => pdf),
      } as unknown as Response
    }
    return new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const known = (amount: string) => ({
  status: 'KNOWN' as const,
  amount,
  hasAmount: true as const,
})

const report: TaxReportV2DetailModel = {
  schemaVersion: 'giwa.tax-report-model.v2',
  reportId: `tax-report-v2:${'a'.repeat(64)}`,
  reportModelDigest: '1'.repeat(64),
  inputDigest: '2'.repeat(64),
  evidencePackDigest: '3'.repeat(64),
  taxYear: 2027,
  status: 'PARTIAL',
  calculationStatus: 'COMPLETE',
  taxOutcome: 'ESTIMATED_TAX_DUE',
  filingAction: 'REVIEW_REQUIRED',
  filingStatus: 'BLOCKED',
  filingSubmissionStatus: 'NOT_SUBMITTED',
  inputPeriod: {
    from: '2026-12-31T15:00:00Z',
    through: '2027-12-31T14:59:59Z',
  },
  dataCoverage: {
    status: 'PARTIAL',
    assurance: 'DOCUMENT_METADATA_VERIFIED',
    from: '2026-12-31T15:00:00Z',
    through: '2027-06-30T14:59:59Z',
    declaration: null,
    coveredIntervals: [{
      from: '2026-12-31T15:00:00Z',
      through: '2027-06-30T14:59:59Z',
    }],
    uncoveredIntervals: [{
      from: '2027-06-30T15:00:00Z',
      through: '2027-12-31T14:59:59Z',
    }],
  },
  calculatedAsOf: '2027-07-01T00:00:00Z',
  taxYearCloseStatus: 'OPEN',
  valuationFinality: 'PROVISIONAL',
  reportFinality: 'PROVISIONAL',
  denominationAssetId: 'KRW',
  counts: {
    assetSummaries: 1, disposals: 1, feeAssetDisposals: 1,
    acquisitions: 1, incomeRows: 1, transfers: 1, nonTaxableTransfers: 1,
    limitations: 1, sourceArtifacts: 1,
  },
  summary: {
    grossProceeds: known('22500000'),
    disposedBasis: known('18000000'),
    deductibleExpense: known('1000'),
    incurredExpense: known('1000'),
    disposalGainLoss: known('4500000'),
    lendingIncome: known('500000'),
    lendingExpense: known('100000'),
    netLendingIncome: known('400000'),
    taxableIncome: known('4900000'),
    taxableBase: known('2400000'),
    nationalTax: known('480000'),
    localTax: known('48000'),
    totalTax: known('528000'),
    calculationRule: {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      deductionUsedAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    },
  },
  assetSummaries: [{
    taxAssetId: 'BTC', openingQuantity: '0', openingBasis: known('0'),
    acquiredQuantity: '100000000', acquisitionCost: known('70000000'),
    annualAverage: {
      status: 'KNOWN', numerator: '70000000', denominator: '100000000',
      unitCost: '0.7', unitCostNumerator: '70000000',
      unitCostDenominator: '100000000', rounding: 'FLOOR',
    },
    disposedQuantity: '25000000', grossProceeds: known('22500000'),
    incurredExpense: known('1000'), deductibleExpense: known('1000'),
    disposedBasis: known('18000000'), gainLoss: known('4499000'),
    endingQuantity: '75000000', endingCost: known('52500000'),
    basisMode: 'ACTUAL_TOTAL_AVERAGE', basisEvidenceDigest: null,
  }],
  disposals: [{
    transactionType: 'DISPOSAL', movementId: 'disposal-1', relatedMovementId: null, eventId: 'event-1',
    revisionId: 'revision-1', legId: 'leg-1', taxAddressId: 'address-1',
    taxAssetId: 'BTC', ledgerAssetId: 'bitcoin', quantity: '25000000',
    grossProceeds: known('22500000'), ancillaryExpense: known('1000'),
    incurredExpense: known('1000'), basis: known('18000000'),
    gainLoss: known('4499000'), valuationId: 'valuation-1',
    costMethod: 'ANNUAL_TOTAL_AVERAGE', rounding: 'FLOOR',
    basisMode: 'ACTUAL_TOTAL_AVERAGE', basisEvidenceDigest: null,
    occurredAt: '2027-03-01T00:00:00Z',
    account: { status: 'KNOWN', accountId: 'upbit-1', accountKind: 'CEX', displayNameStatus: 'UNKNOWN', displayName: null },
    valuation: { status: 'KNOWN', valuationId: 'valuation-1', kind: 'MARKET_QUOTE', effectiveAt: '2027-03-01T00:00:00Z', quoteId: 'quote-1', snapshotArtifactDigest: '9'.repeat(64), baseAtomicUnits: '25000000', quoteAtomicUnits: '22500000', rounding: 'FLOOR' },
    sourceEvidence: [{ legId: 'leg-1', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-1', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['FILE'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  feeAssetDisposals: [{
    transactionType: 'FEE_ASSET_DISPOSAL', movementId: 'fee-1', relatedMovementId: 'disposal-1', eventId: 'event-1',
    revisionId: 'revision-1', legId: 'fee-leg', taxAddressId: 'address-1',
    taxAssetId: 'ETH', ledgerAssetId: 'ethereum', quantity: '100',
    grossProceeds: known('1000'), ancillaryExpense: known('0'),
    incurredExpense: known('0'), basis: known('800'), gainLoss: known('200'),
    valuationId: 'valuation-fee', costMethod: 'ANNUAL_TOTAL_AVERAGE',
    rounding: 'FLOOR', basisMode: 'ACTUAL_TOTAL_AVERAGE',
    basisEvidenceDigest: null,
    occurredAt: '2027-03-01T00:00:00Z',
    account: { status: 'KNOWN', accountId: 'upbit-1', accountKind: 'CEX', displayNameStatus: 'UNKNOWN', displayName: null },
    valuation: { status: 'KNOWN', valuationId: 'valuation-fee', kind: 'MARKET_QUOTE', effectiveAt: '2027-03-01T00:00:00Z', quoteId: 'quote-fee', snapshotArtifactDigest: '9'.repeat(64), baseAtomicUnits: '100', quoteAtomicUnits: '1000', rounding: 'FLOOR' },
    sourceEvidence: [{ legId: 'fee-leg', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-fee', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['FILE'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  acquisitions: [{
    transactionType: 'OTHER_ACQUISITION', movementId: 'acquisition-1', relatedMovementId: 'income-1',
    eventId: 'event-2', revisionId: 'revision-2', legId: 'leg-2',
    kind: 'OTHER_ACQUISITION', taxAssetId: 'ETH', ledgerAssetId: 'ethereum',
    quantity: '1000', valuationId: 'valuation-2', consideration: known('490000'),
    acquisitionAncillaryExpense: known('10000'), acquisitionCost: known('500000'),
    occurredAt: '2027-02-01T00:00:00Z',
    account: { status: 'KNOWN', accountId: 'wallet-1', accountKind: 'EVM_WALLET', displayNameStatus: 'UNKNOWN', displayName: null },
    valuation: { status: 'KNOWN', valuationId: 'valuation-2', kind: 'MARKET_QUOTE', effectiveAt: '2027-02-01T00:00:00Z', quoteId: 'quote-2', snapshotArtifactDigest: '9'.repeat(64), baseAtomicUnits: '1000', quoteAtomicUnits: '500000', rounding: 'FLOOR' },
    sourceEvidence: [{ legId: 'leg-2', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-2', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['FILE'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  incomeRows: [{
    transactionType: 'LENDING_INCOME_ASSET', movementId: 'income-1', relatedMovementId: 'acquisition-1',
    eventId: 'event-2', revisionId: 'revision-2', legId: 'leg-2',
    kind: 'LENDING_INCOME_ASSET', taxAssetId: 'ETH', ledgerAssetId: 'ethereum',
    quantity: '1000', valuationId: 'valuation-2', income: known('500000'),
    ancillaryExpense: known('0'),
    occurredAt: '2027-02-01T00:00:00Z',
    account: { status: 'KNOWN', accountId: 'wallet-1', accountKind: 'EVM_WALLET', displayNameStatus: 'UNKNOWN', displayName: null },
    valuation: { status: 'KNOWN', valuationId: 'valuation-2', kind: 'MARKET_QUOTE', effectiveAt: '2027-02-01T00:00:00Z', quoteId: 'quote-2', snapshotArtifactDigest: '9'.repeat(64), baseAtomicUnits: '1000', quoteAtomicUnits: '500000', rounding: 'FLOOR' },
    sourceEvidence: [{ legId: 'leg-2', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-2', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['FILE'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  transfers: [{
    transactionType: 'TRANSFER', movementId: 'transfer-1', eventId: 'event-3',
    revisionId: 'revision-3', fromLegId: 'from-leg-1', toLegId: 'to-leg-1',
    fromAddressId: 'address-1', toAddressId: 'address-2', taxAssetId: 'BTC',
    quantity: '10000000', basis: known('7000000'),
    fromCostMethod: 'ANNUAL_TOTAL_AVERAGE', toCostMethod: 'ANNUAL_TOTAL_AVERAGE',
    occurredAt: '2027-04-01T00:00:00Z',
    from: { status: 'KNOWN', accountId: 'upbit-1', accountKind: 'CEX', displayNameStatus: 'UNKNOWN', displayName: null },
    to: { status: 'KNOWN', accountId: 'wallet-2', accountKind: 'EVM_WALLET', displayNameStatus: 'UNKNOWN', displayName: null },
    sourceEvidence: [{ legId: 'from-leg-1', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-3', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['FILE'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  nonTaxableTransfers: [{
    transactionType: 'SELF_TRANSFER', movementId: 'self-transfer-1',
    eventId: 'event-4', revisionId: 'revision-4', fromLegId: 'self-from',
    toLegId: 'self-to', taxAssetId: 'ETH', quantity: '500',
    occurredAt: '2027-05-01T00:00:00Z',
    from: { status: 'KNOWN', accountId: 'wallet-1', accountKind: 'EVM_WALLET', displayNameStatus: 'UNKNOWN', displayName: null },
    to: { status: 'KNOWN', accountId: 'wallet-2', accountKind: 'EVM_WALLET', displayNameStatus: 'UNKNOWN', displayName: null },
    sourceEvidence: [{ legId: 'self-from', relationId: null, fragmentId: 'fragment-1', observationId: 'observation-4', sourceArtifactBindingStatus: 'BOUND', sourceArtifactIds: ['source-1'], sourceKinds: ['CHAIN'] }],
    review: { status: 'CLEAR', limitations: [] },
  }],
  excludedConversions: [{
    eventId: 'event-5', revisionId: 'revision-5', relationId: 'relation-1',
    taxAddressId: 'address-1', taxAssetId: 'ETH', fromLegId: 'convert-from',
    toLegId: 'convert-to', fromQuantity: '100', toQuantity: '1000000000000000000',
  }],
  limitations: [{
    code: 'SOURCE_COVERAGE_UNVERIFIED', reason: '7월 이후 자료가 없습니다.',
    taxAddressId: null, taxAssetId: null, movementId: null,
    reviewId: null, reviewRevisionId: null,
  }],
  sourceCoverage: [{
    sourceArtifactId: 'source-1', sourceKind: 'FILE',
    systemName: 'UPBIT',
    assurance: 'DOCUMENT_METADATA_VERIFIED', status: 'PARTIAL',
    evidenceDigest: '4'.repeat(64), fragmentIds: ['fragment-1'],
    coveredIntervals: [{
      from: '2026-12-31T15:00:00Z', through: '2027-06-30T14:59:59Z',
    }],
    uncoveredIntervals: [{
      from: '2027-06-30T15:00:00Z', through: '2027-12-31T14:59:59Z',
    }],
  }],
  methodology: {
    taxInventoryRunId: 'inventory-1', taxEstimateId: 'estimate-1',
    lotRunId: 'lot-1', sourceLedgerGenerationId: 'ledger-generation-1', schemaDigest: '5'.repeat(64),
    policy: {
      name: 'kr-virtual-asset-tax', version: '2027.1',
      artifactDigest: '6'.repeat(64), sourceSetDigest: '7'.repeat(64),
      applicationMode: 'ENACTED', effectiveFrom: '2027-01-01T00:00:00Z',
      effectiveThrough: '2027-12-31T23:59:59Z',
      roundingProfileStatus: 'ESTIMATE_ONLY_UNAPPROVED',
      roundingProfileEvidenceDigest: null,
      legalReferences: [{
        law: '소득세법', article: '제37조', paragraphs: ['제1항'],
        purpose: '필요경비 계산 기준',
        sourceLocators: ['https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405'],
        sourceCheckedAt: '2026-08-03T15:00:00Z',
      }],
    },
    engine: {
      name: 'daejang-tax-engine', version: '2.0.0', artifactDigest: '8'.repeat(64),
    },
  },
  issuedAt: '2027-07-01T00:00:00Z',
}

describe('TaxReportDetailV2', () => {
  it('shows a compact partial-year summary and all engine-owned detail tabs', async () => {
    render(<TaxReportDetailV2 report={report} pointerVersion={3} isCurrent />)

    expect(screen.getByText(/현재 확보된 데이터 범위로 계산한/u)).toBeInTheDocument()
    expect(screen.getByText('528,000 KRW')).toBeInTheDocument()
    expect(screen.getByText('2027. 07. 01. 09:00:00 KST')).toBeInTheDocument()
    expect(screen.getByText('연간 자료·마감 확인 후 가능합니다.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '새 증명 제출 불가' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'PDF 내려받기' })).toHaveAttribute(
      'href',
      `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`,
    )
    const coverageNote = screen.getByRole('note')
    expect(coverageNote).toHaveTextContent('누락 구간')
    expect(coverageNote).toHaveTextContent('2027. 07. 01.')
    expect(coverageNote).toHaveTextContent('2027. 12. 31.')

    fireEvent.click(screen.getByRole('button', { name: 'PDF 미리보기' }))
    expect(screen.getByRole('dialog', { name: 'PDF 미리보기' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('PDF를 안전하게 불러오는 중입니다.')
    expect(await screen.findByTitle('2027년 세무 장부 PDF')).toHaveAttribute(
      'src', 'blob:tax-report-pdf',
    )
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`,
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ accept: 'application/pdf' }),
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'PDF 미리보기 닫기' }))
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(
      'blob:tax-report-pdf',
    ))

    fireEvent.click(screen.getByRole('tab', { name: '자산별 장부' }))
    const assetTab = screen.getByRole('tab', { name: '자산별 장부' })
    expect(assetTab).toHaveAttribute('aria-controls', 'tax-report-v2-panel-assets')
    expect(screen.getByRole('tabpanel', { name: '자산별 장부' })).toHaveAttribute(
      'aria-labelledby',
      'tax-report-v2-tab-assets',
    )
    expect(screen.getByText('총평균 분자 · 연간 취득가액(원천 정수)')).toBeInTheDocument()
    expect(screen.getAllByText('70,000,000', { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getByText('실제 취득가액 · 연간 총평균')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '소득·처분' }))
    expect(screen.getByText(/LENDING_INCOME_ASSET/u)).toBeInTheDocument()
    expect(screen.getByText(/FEE_ASSET_DISPOSAL/u)).toBeInTheDocument()
    const incomeSummary = screen.getByText(/LENDING_INCOME_ASSET · ETH/u)
    fireEvent.click(incomeSummary)
    expect(incomeSummary.closest('details')).toHaveAttribute('open')
    expect(
      screen.getAllByText(/2027\. 02\. 01\. 09:00:00 KST/u).length,
    ).toBeGreaterThan(0)
    expect(screen.getAllByText('EVM_WALLET · wallet-1').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/FILE · 원본 결합 완료/u).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/fragment fragment-1/u).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/원천 최소단위 수량/u).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(/OTHER_ACQUISITION · ETH/u))
    expect(screen.getByText('취득 대가')).toBeInTheDocument()
    expect(screen.getByText('취득 부대비용')).toBeInTheDocument()
    expect(screen.getByText('총 취득가액')).toBeInTheDocument()
    expect(screen.getByText(/TRANSFER · BTC/u)).toBeInTheDocument()
    expect(screen.getByText(/SELF_TRANSFER · ETH/u)).toBeInTheDocument()
    expect(screen.getByText('relation relation-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '계산·법적 근거' }))
    expect(screen.getByText('거주자 × 과세연도 × 세무자산')).toBeInTheDocument()
    expect(screen.getByText('승인 전 · 현재 세액은 추정치')).toBeInTheDocument()
    expect(screen.getByText('UPBIT')).toBeInTheDocument()
    expect(screen.getByText(/소득세법 제37조/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '국가법령정보센터 원문' })).toHaveAttribute(
      'href', 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405',
    )
    expect(screen.getByText('7월 이후 자료가 없습니다.')).toBeInTheDocument()
    expect(screen.getAllByText(/누락:/u).length).toBeGreaterThan(0)
  })

  it('revokes each PDF blob when the report changes and when it unmounts', async () => {
    createObjectURL
      .mockReturnValueOnce('blob:tax-report-first')
      .mockReturnValueOnce('blob:tax-report-second')
    const { rerender, unmount } = render(<TaxReportDetailV2 report={report} />)

    fireEvent.click(screen.getByRole('button', { name: 'PDF 미리보기' }))
    expect(await screen.findByTitle('2027년 세무 장부 PDF')).toHaveAttribute(
      'src', 'blob:tax-report-first',
    )

    rerender(<TaxReportDetailV2 report={{
      ...report,
      reportId: `tax-report-v2:${'b'.repeat(64)}`,
    }} />)
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(
      'blob:tax-report-first',
    ))
    expect(await screen.findByTitle('2027년 세무 장부 PDF')).toHaveAttribute(
      'src', 'blob:tax-report-second',
    )

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tax-report-second')
  })

  it('shows a recoverable preview error without replacing the download link', async () => {
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/artifacts/pdf')) {
        return new Response(JSON.stringify({ error: { code: 'PDF_UNAVAILABLE' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })
    render(<TaxReportDetailV2 report={report} />)

    fireEvent.click(screen.getByRole('button', { name: 'PDF 미리보기' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PDF 미리보기를 불러오지 못했습니다.',
    )
    expect(screen.queryByTitle('2027년 세무 장부 PDF')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'PDF 내려받기' })[0]).toHaveAttribute(
      'href',
      `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`,
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('formats Upbit KRW atomic amounts instead of exposing raw integers', () => {
    const krwReport: TaxReportV2DetailModel = {
      ...report,
      denominationAssetId: 'asset-krw-upbit',
      summary: {
        ...report.summary,
        totalTax: known('52800000000000'),
        calculationRule: {
          ...report.summary.calculationRule,
          basicDeductionAmount: '250000000000000',
          deductionUsedAmount: '250000000000000',
        },
      },
    }

    render(<TaxReportDetailV2 report={krwReport} />)

    expect(screen.getByText('528,000 KRW')).toBeInTheDocument()
    expect(screen.getByText('2,500,000 KRW / 2,500,000 KRW')).toBeInTheDocument()
    expect(screen.queryByText('52,800,000,000,000 KRW')).not.toBeInTheDocument()
  })
})
