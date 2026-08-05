import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { ReportWorkspacePage } from './ReportPage.tsx'

const partialTaxReport = {
  reportId: 'tax-report-1',
  taxYear: 2027,
  taxYearCloseStatus: 'UNVERIFIED',
  finality: 'PROVISIONAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  pointerVersion: 2,
  denominationAssetId: 'KRW',
  issuedAt: '2027-02-01T00:00:00Z',
  counts: {
    disposals: 3,
    transfers: 2,
    excludedConversions: 1,
    limitations: 1,
  },
  gainLoss: { status: 'KNOWN', amount: '125000', hasAmount: true },
  taxableBase: { status: 'UNKNOWN', hasAmount: false },
  nationalTax: { status: 'UNKNOWN', hasAmount: false },
  localTax: { status: 'UNKNOWN', hasAmount: false },
  totalTax: { status: 'UNKNOWN', hasAmount: false },
} as const

const knownAmount = (amount: string) => ({
  amount,
  hasAmount: true,
  status: 'KNOWN' as const,
})

const unknownAmount = {
  amount: null,
  hasAmount: false,
  status: 'UNKNOWN' as const,
}

const detailReport = {
  schemaVersion: 'giwa.tax-report-model.v1',
  reportId: partialTaxReport.reportId,
  reportModelDigest: 'a'.repeat(64),
  inputDigest: 'b'.repeat(64),
  evidencePackDigest: 'c'.repeat(64),
  taxYear: 2027,
  taxYearCloseStatus: 'UNVERIFIED',
  finality: 'PROVISIONAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  denominationAssetId: 'KRW',
  issuedAt: '2027-02-01T00:00:00Z',
  counts: partialTaxReport.counts,
  summary: {
    calculationContract: 'ANNUAL_TOTAL_AVERAGE',
    calculationRule: {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      deductionUsedAmount: '2000000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    },
    gainLoss: knownAmount('125000'),
    taxableBase: unknownAmount,
    nationalTax: unknownAmount,
    localTax: unknownAmount,
    totalTax: unknownAmount,
  },
  totals: {
    grossProceeds: knownAmount('22500000'),
    acquisitionCost: knownAmount('18000000'),
    ancillaryExpense: knownAmount('0'),
    gainLoss: knownAmount('4500000'),
  },
  assetSummaries: [
    {
      taxAssetId: 'BTC',
      disposalCount: 1,
      quantity: '25000000',
      grossProceeds: knownAmount('22500000'),
      acquisitionCost: knownAmount('18000000'),
      ancillaryExpense: knownAmount('0'),
      gainLoss: knownAmount('4500000'),
    },
  ],
  disposals: [
    {
      movementId: 'disposal-1',
      eventId: 'event-1',
      revisionId: 'ledger-revision-1',
      legId: 'leg-1',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'BTC',
      ledgerAssetId: 'bitcoin',
      quantity: '25000000',
      grossProceeds: knownAmount('22500000'),
      ancillaryExpense: knownAmount('0'),
      basis: knownAmount('18000000'),
      gainLoss: knownAmount('4500000'),
      valuationId: 'valuation-1',
      costMethod: 'ANNUAL_TOTAL_AVERAGE',
      rounding: null,
    },
  ],
  transfers: [
    {
      movementId: 'transfer-1',
      eventId: 'event-2',
      revisionId: 'ledger-revision-1',
      fromLegId: 'leg-2-out',
      toLegId: 'leg-2-in',
      fromAddressId: 'tax-address-1',
      toAddressId: 'tax-address-2',
      taxAssetId: 'ETH',
      quantity: '120000000',
      basis: unknownAmount,
      fromCostMethod: 'MOVING_AVERAGE',
      toCostMethod: 'MOVING_AVERAGE',
    },
  ],
  excludedConversions: [
    {
      eventId: 'event-3',
      revisionId: 'ledger-revision-1',
      relationId: 'conversion-1',
      fromLegId: 'leg-3-out',
      toLegId: 'leg-3-in',
      taxAddressId: 'tax-address-1',
      taxAssetId: 'WETH',
      fromQuantity: '100000000',
      toQuantity: '100000000',
    },
  ],
  limitations: [
    {
      code: 'BASIS_UNKNOWN',
      taxAddressId: 'tax-address-2',
      taxAssetId: 'ETH',
      movementId: 'transfer-1',
      reviewId: 'review-1',
      reviewRevisionId: 'review-revision-1',
      reason: '이체된 자산의 취득원가를 확정할 수 없습니다.',
    },
  ],
  methodology: {
    policy: {
      name: 'kr-virtual-asset-tax',
      version: '2027.1',
      artifactDigest: 'd'.repeat(64),
    },
    engine: {
      name: 'daejang-tax-engine',
      version: '1.0.0',
      artifactDigest: 'e'.repeat(64),
    },
    taxInventoryRunId: 'tax-inventory-run-1',
    taxEstimateId: 'tax-estimate-1',
    lotRunId: 'lot-run-1',
    generationId: 'generation-1',
    schemaDigest: 'f'.repeat(64),
  },
} as const

const evidencePack = {
  schemaVersion: 'giwa.tax-evidence-pack.v1',
  reportId: partialTaxReport.reportId,
  artifactDigest: '1'.repeat(64),
  manifestId: 'tax-evidence-pack:manifest-1',
  taxYear: 2027,
  artifactRoots: [
    { kind: 'TAX_INVENTORY', digest: '2'.repeat(64) },
    { kind: 'TAX_ESTIMATE', digest: '3'.repeat(64) },
  ],
  evidenceCoordinates: Array.from({ length: 14 }, (_, index) => ({
    kind: index % 2 === 0 ? 'POSTING' : 'VALUATION',
    eventId: `evidence-event-${index}`,
    revisionId: `evidence-revision-${index}`,
    legId: index % 2 === 0 ? `evidence-leg-${index}` : null,
    relationId: null,
    valuationId: index % 2 === 1 ? `evidence-valuation-${index}` : null,
    movementId: `evidence-movement-${index}`,
    reviewId: null,
    reviewRevisionId: null,
    fragmentId: null,
    observationId: null,
    generationId: null,
    schemaDigest: null,
  })),
  methodology: {
    taxInventoryRunId: 'tax-inventory-run-1',
    taxEstimateId: 'tax-estimate-1',
    lotRunId: 'lot-run-1',
    generationId: 'generation-1',
    schemaDigest: '4'.repeat(64),
    policy: {
      name: 'kr-virtual-asset-tax',
      version: '2027.1',
      artifactDigest: '5'.repeat(64),
    },
    engine: {
      name: 'daejang-tax-engine',
      version: '1.0.0',
      artifactDigest: '6'.repeat(64),
    },
  },
  issuedAt: '2027-02-01T00:00:00Z',
} as const

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubReportRequests(options: {
  detail?: unknown
  detailStatus?: number
  evidence?: unknown
  evidenceStatus?: number
  history?: unknown[]
  finalCurrent?: unknown
  finalCurrentStatus?: number
  provisionalCurrent?: unknown
  provisionalCurrentStatus?: number
  historyStatus?: number
  taxYear?: 2025 | 2026 | 2027
} = {}) {
  const taxYear = options.taxYear ?? 2027
  const detail = options.detail ?? { ...detailReport, taxYear }
  const provisionalCurrent = options.provisionalCurrent ?? {
    ...partialTaxReport,
    taxYear,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes(`/tax-reports/${taxYear}/current`)) {
        if (url.includes('finality=FINAL')) {
          if (options.finalCurrentStatus) {
            return jsonResponse(
              { error: { code: 'CORRECTION_PENDING' } },
              options.finalCurrentStatus,
            )
          }
          return options.finalCurrent
            ? jsonResponse({ report: options.finalCurrent })
            : jsonResponse({ error: { code: 'RESOURCE_NOT_FOUND' } }, 404)
        }
        if (options.provisionalCurrentStatus) {
          return jsonResponse(
            { error: { code: 'RESOURCE_NOT_FOUND' } },
            options.provisionalCurrentStatus,
          )
        }
        return jsonResponse({
          report: provisionalCurrent,
        })
      }
      if (url.includes(`/tax-reports/${taxYear}/history`)) {
        return jsonResponse(
          options.historyStatus
            ? { error: { code: 'TAX_REPORT_HISTORY_UNAVAILABLE' } }
            : { items: options.history ?? [provisionalCurrent] },
          options.historyStatus,
        )
      }
      if (url.endsWith('/api/v1/tax-reports/tax-report-1/evidence')) {
        return jsonResponse(
          options.evidenceStatus && options.evidenceStatus >= 400
            ? { error: { code: 'TAX_EVIDENCE_PACK_UNAVAILABLE' } }
            : { evidencePack: options.evidence ?? evidencePack },
          options.evidenceStatus,
        )
      }
      if (url.endsWith('/api/v1/tax-reports/tax-report-1')) {
        return jsonResponse(
          options.detailStatus && options.detailStatus >= 400
            ? { error: { code: 'TAX_REPORT_DETAIL_UNAVAILABLE' } }
            : { report: detail },
          options.detailStatus,
        )
      }
      return jsonResponse({ items: [] })
    }),
  )
}

beforeEach(() => {
  saveAppPreferences({ currency: 'KRW', year: '2027' })
  stubReportRequests()
})

describe('ReportPage', () => {
  it('presents one revisioned ledger workspace without legacy or EAS controls', async () => {
    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('heading', {
        name: '장부 계산 요약',
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name: '합성 장부 온체인 증명',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '발행 산출물 이력' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '장부 revision' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('미확정').length).toBeGreaterThanOrEqual(4)
    expect(
      screen.getByText('‘미확정’은 0원을 뜻하지 않습니다.'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('0 KRW').length).toBeGreaterThan(0)
    expect(
      screen.getByText('PROVISIONAL · 평가 입력 잠정'),
    ).toBeInTheDocument()
    expect(screen.getByText('일부 미확정')).toBeInTheDocument()
    expect(screen.getByText('검토 필요')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '세금 추정 요약' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '적용 계산 기준' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('연간 총평균 원가 계약 기록됨'),
    ).toBeInTheDocument()
    expect(screen.getByText('연간 총평균법')).toBeInTheDocument()
    expect(
      screen.getByText('거주자 × 과세연도 × 세무자산'),
    ).toBeInTheDocument()
    expect(screen.getByText('2,500,000 KRW')).toBeInTheDocument()
    expect(screen.getByText('2,000,000 KRW')).toBeInTheDocument()
    expect(screen.getByText('20% (20 / 100)')).toBeInTheDocument()
    expect(screen.getByText('2% (2 / 100)')).toBeInTheDocument()
    expect(
      screen.getByText('연간 묶음의 누적 배분값을 기준으로 버림'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/프런트에서 임의 보정하지 않고 그대로 표시합니다/u),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '자산별 계산 요약' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '검토용 PDF' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/artifacts/pdf',
    )
    expect(
      screen.getByRole('link', { name: '검토용 PDF' }),
    ).toHaveAttribute('download')

    const assetToggle = screen.getByRole('button', {
      name: /BTC 처분 내역 펼쳐보기/u,
    })
    expect(assetToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(assetToggle)
    expect(assetToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('BTC 개별 처분 내역')).toBeInTheDocument()
    expect(
      screen.getByText(/화면에서 금액을 다시 계산하지 않습니다/u),
    ).toBeInTheDocument()

    const fetchMock = vi.mocked(fetch)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/tax-report-1/evidence',
        ),
      ),
    ).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: '처분 장부' }))
    expect(
      screen.getByRole('heading', { name: '처분 장부' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '이체·전환' }))
    expect(screen.getByRole('heading', { name: '이체' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '과세 제외 전환' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/leg-2-out/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /검토 항목/u }))
    expect(
      screen.getByRole('heading', { name: '검토가 필요한 항목' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('이체된 자산의 취득원가를 확정할 수 없습니다.'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByText('연결된 원장·검토 정보', { selector: 'summary' }),
    )
    expect(screen.getByText('review-revision-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '계산 근거' }))
    expect(
      screen.getByRole('heading', { name: '계산 기준과 추적 정보' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '근거 JSON 보기' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/evidence',
    )
    expect(await screen.findByText('TAX_INVENTORY')).toBeInTheDocument()
    expect(screen.getByText('TAX_ESTIMATE')).toBeInTheDocument()
    expect(screen.getByText('evidence-event-11')).toBeInTheDocument()
    expect(screen.queryByText('evidence-event-12')).not.toBeInTheDocument()
    expect(screen.getByText('12/14')).toBeInTheDocument()

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/2027/current?finality=FINAL',
        ),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/2027/current?finality=PROVISIONAL',
        ),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/tax-reports/tax-report-1'),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/tax-report-1/evidence',
        ),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/2027/history?limit=20',
        ),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/reports?taxYear=2027'),
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /\/api\/v1\/(?:dev\/reports\/.+attestation|reports\/.+\/attestation)/u
          .test(String(url)),
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/report-attestations/deployment'),
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/report-attestations/synthetic-publication',
        ),
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/report-payments/capabilities'),
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false)
  })

  it('formats canonical Upbit KRW atomic amounts as KRW', async () => {
    stubReportRequests({
      detail: {
        ...detailReport,
        denominationAssetId: 'asset-krw-upbit',
        totals: {
          ...detailReport.totals,
          grossProceeds: knownAmount('368786100000000'),
          ancillaryExpense: knownAmount('1'),
        },
      },
    })

    render(<ReportWorkspacePage />)

    expect(await screen.findByText('3,687,861 KRW')).toBeInTheDocument()
    expect(screen.getByText('0.00000001 KRW')).toBeInTheDocument()
    expect(
      screen.queryByText('368,786,100,000,000 asset-krw-upbit'),
    ).not.toBeInTheDocument()
  })

  it('does not infer calculation rules for a historical V1 report', async () => {
    const legacySummary = {
      calculationContract: 'UNSUPPORTED',
      calculationRule: null,
      gainLoss: detailReport.summary.gainLoss,
      taxableBase: detailReport.summary.taxableBase,
      nationalTax: detailReport.summary.nationalTax,
      localTax: detailReport.summary.localTax,
      totalTax: detailReport.summary.totalTax,
    }
    stubReportRequests({
      detail: {
        ...detailReport,
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        summary: legacySummary,
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText(
        '이 발행본만으로 계산 계약 확인 불가',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/총평균법 적용 여부를 확인할 수 없습니다/u),
    ).toBeInTheDocument()
    expect(screen.queryByText('연간 총평균법')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '검토용 PDF' })).toBeInTheDocument()
  })

  it('labels an address-scoped calculation rule as a legacy contract', async () => {
    stubReportRequests({
      detail: {
        ...detailReport,
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        summary: {
          ...detailReport.summary,
          calculationContract: 'LEGACY',
          calculationRule: {
            ...detailReport.summary.calculationRule,
            poolScope: 'ADDRESS',
            costMethods: ['MOVING_AVERAGE', 'FIFO'],
            basisAllocationRounding: 'FLOOR_EXCEPT_EXHAUSTED_LAYER',
          },
        },
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText('주소별 이동평균/FIFO 과거 계산본'),
    ).toBeInTheDocument()
    expect(screen.getByText('주소별')).toBeInTheDocument()
    expect(screen.getByText('이동평균법, 선입선출법')).toBeInTheDocument()
    expect(
      screen.getByText(/총평균법 기준 신고 자료로 해석하면 안 됩니다/u),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '검토용 PDF' })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: '신고 준비 자료 PDF' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the current pointer version when history repeats the same report as revision zero', async () => {
    stubReportRequests({
      history: [{ ...partialTaxReport, pointerVersion: 0 }],
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText('revision 2', { selector: 'strong' }),
    ).toHaveTextContent('현재')
    expect(
      screen.queryByRole('button', { name: /revision 0/u }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('이전 발행본')).not.toBeInTheDocument()
  })

  it('renders a large disposal ledger inside the exact report detail', async () => {
    const largeDetail = {
      ...detailReport,
      counts: { ...detailReport.counts, disposals: 120 },
      disposals: Array.from({ length: 120 }, (_, index) => ({
        ...detailReport.disposals[0],
        movementId: `disposal-large-${index}`,
        eventId: `event-large-${index}`,
      })),
    }
    stubReportRequests({ detail: largeDetail })

    render(<ReportWorkspacePage />)

    await screen.findByRole('heading', { name: '장부 계산 요약' })
    fireEvent.click(screen.getByRole('tab', { name: '처분 장부' }))
    expect(await screen.findByText('disposal-large-119')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(121)
    expect(
      screen.getByText('120건', { selector: '.tax-report-detail__section > header p' }),
    ).toBeInTheDocument()
  })

  it('shows explicit empty states for an exact report with no ledger rows', async () => {
    const readySummary = {
      ...detailReport.summary,
      gainLoss: knownAmount('0'),
      taxableBase: knownAmount('0'),
      nationalTax: knownAmount('0'),
      localTax: knownAmount('0'),
      totalTax: knownAmount('0'),
    }
    stubReportRequests({
      detail: {
        ...detailReport,
        status: 'FINAL',
        filingStatus: 'READY',
        finality: 'FINAL',
        taxYearCloseStatus: 'CLOSED',
        summary: readySummary,
        counts: {
          disposals: 0,
          transfers: 0,
          excludedConversions: 0,
          limitations: 0,
        },
        disposals: [],
        assetSummaries: [],
        transfers: [],
        excludedConversions: [],
        limitations: [],
      },
    })

    render(<ReportWorkspacePage />)

    await screen.findByRole('heading', { name: '장부 계산 요약' })
    expect(screen.getByText('연간 마감 확인됨')).toBeInTheDocument()
    expect(screen.getByText('전체 확정')).toBeInTheDocument()
    expect(
      screen.getByText('엔진 판정: 신고 준비 조건 충족'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '신고 준비 자료 PDF' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/artifacts/pdf',
    )
    expect(screen.getByText('요약할 처분 자산이 없습니다.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '처분 장부' }))
    expect(
      await screen.findByText('이 장부에 포함된 처분이 없습니다.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '이체·전환' }))
    expect(
      screen.getByText('이 장부에 포함된 이체가 없습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('과세 대상에서 제외된 동일 자산 전환이 없습니다.'),
    ).toBeInTheDocument()
  })

  it('keeps a contradictory final report with unknown amounts in review', async () => {
    stubReportRequests({
      detail: {
        ...detailReport,
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        taxYearCloseStatus: 'CLOSED',
        counts: { ...detailReport.counts, limitations: 0 },
        limitations: [],
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('link', { name: '검토용 PDF' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: '신고 준비 자료 PDF' }),
    ).not.toBeInTheDocument()
  })

  it('keeps a final report with no applied deduction in review', async () => {
    stubReportRequests({
      detail: {
        ...detailReport,
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        taxYearCloseStatus: 'CLOSED',
        counts: {
          disposals: 0,
          transfers: 0,
          excludedConversions: 0,
          limitations: 0,
        },
        summary: {
          ...detailReport.summary,
          calculationRule: {
            ...detailReport.summary.calculationRule,
            deductionUsedAmount: null,
          },
          gainLoss: knownAmount('0'),
          taxableBase: knownAmount('0'),
          nationalTax: knownAmount('0'),
          localTax: knownAmount('0'),
          totalTax: knownAmount('0'),
        },
        totals: {
          grossProceeds: knownAmount('0'),
          acquisitionCost: knownAmount('0'),
          ancillaryExpense: knownAmount('0'),
          gainLoss: knownAmount('0'),
        },
        assetSummaries: [],
        disposals: [],
        transfers: [],
        excludedConversions: [],
        limitations: [],
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('link', { name: '검토용 PDF' }),
    ).toBeInTheDocument()
  })

  it('keeps a pre-2027 final report as a policy simulation', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2026' })
    stubReportRequests({
      taxYear: 2026,
      detail: {
        ...detailReport,
        taxYear: 2026,
        taxYearCloseStatus: 'CLOSED',
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        counts: {
          disposals: 0,
          transfers: 0,
          excludedConversions: 0,
          limitations: 0,
        },
        summary: {
          ...detailReport.summary,
          gainLoss: knownAmount('0'),
          taxableBase: knownAmount('0'),
          nationalTax: knownAmount('0'),
          localTax: knownAmount('0'),
          totalTax: knownAmount('0'),
        },
        totals: {
          grossProceeds: knownAmount('0'),
          acquisitionCost: knownAmount('0'),
          ancillaryExpense: knownAmount('0'),
          gainLoss: knownAmount('0'),
        },
        assetSummaries: [],
        disposals: [],
        transfers: [],
        excludedConversions: [],
        limitations: [],
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('link', { name: '검토용 PDF' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: '신고 준비 자료 PDF' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the revision visible when exact detail returns 404', async () => {
    stubReportRequests({ detailStatus: 404 })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText(
        '장부 발행 이력은 확인했지만 상세 문서는 아직 준비되지 않았습니다.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '장부 revision' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /PDF/u }),
    ).not.toBeInTheDocument()
  })

  it('isolates an exact detail failure from revision history', async () => {
    stubReportRequests({ detailStatus: 503 })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(
      'revision 이력은 유지되지만 선택한 상세 장부를 불러오지 못했습니다.',
    )
    expect(
      screen.getByRole('heading', { name: '장부 revision' }),
    ).toBeInTheDocument()
  })

  it('isolates an evidence-pack failure from the report detail', async () => {
    stubReportRequests({ evidenceStatus: 503 })

    render(<ReportWorkspacePage />)

    await screen.findByRole('heading', { name: '장부 계산 요약' })
    fireEvent.click(screen.getByRole('tab', { name: '계산 근거' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '계산 근거를 불러오지 못했습니다. 장부 계산 결과 자체의 조회 실패를 뜻하지 않습니다.',
    )
    expect(
      screen.getByRole('heading', { name: '계산 기준과 추적 정보' }),
    ).toBeInTheDocument()
  })

  it('keeps an available provisional ledger visible when the FINAL pointer fails', async () => {
    stubReportRequests({ finalCurrentStatus: 503 })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('heading', { name: '장부 계산 요약' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('revision 2', { selector: 'strong' }),
    ).toHaveTextContent('현재')
    expect(
      screen.getByRole('link', { name: '검토용 PDF' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/artifacts/pdf',
    )
  })

  it('does not present an upstream report failure as an empty ledger', async () => {
    stubReportRequests({
      finalCurrentStatus: 503,
      provisionalCurrentStatus: 404,
      history: [],
    })

    render(<ReportWorkspacePage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '장부를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    )
    expect(
      screen.queryByText('아직 생성된 장부가 없습니다'),
    ).not.toBeInTheDocument()
  })

  it('selects the newest current across FINAL and PROVISIONAL pointers', async () => {
    const olderFinal = {
      ...partialTaxReport,
      reportId: 'tax-report-final',
      finality: 'FINAL',
      status: 'FINAL',
      filingStatus: 'READY',
      pointerVersion: 1,
      issuedAt: '2027-01-01T00:00:00Z',
    } as const
    stubReportRequests({
      finalCurrent: olderFinal,
      history: [olderFinal, partialTaxReport],
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText('revision 2', { selector: 'strong' }),
    ).toHaveTextContent('현재')
    expect(
      await screen.findByRole('link', { name: '검토용 PDF' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/artifacts/pdf',
    )
    expect(
      screen.getByRole('button', { name: /revision 1/u }),
    ).toBeInTheDocument()
  })

  it('loads 2026 and updates the shared tax-year preference', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2026' })
    stubReportRequests({ taxYear: 2026 })

    render(<ReportWorkspacePage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
    expect(
      await screen.findByRole('heading', { name: '장부 계산 요약' }),
    ).toBeInTheDocument()
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/2026/current?finality=PROVISIONAL',
        ),
      ),
    ).toBe(true)
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/tax-reports/2026/history?limit=20'),
      ),
    ).toBe(true)

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2025' },
    })

    expect(loadAppPreferences().year).toBe('2025')
  })

  it('loads 2025 through the same report workspace', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })
    stubReportRequests({ taxYear: 2025 })

    render(<ReportWorkspacePage />)

    expect(
      (await screen.findAllByRole('heading', {
        name: '2025년 가상자산 세무 장부',
      })).length,
    ).toBeGreaterThan(0)
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) =>
        String(url).endsWith(
          '/api/v1/tax-reports/2025/current?finality=PROVISIONAL',
        ),
      ),
    ).toBe(true)
  })

  it('keeps a 2025 history report readable during an older API rollout', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })
    const legacyDetail = {
      ...detailReport,
      taxYear: 2025,
      taxYearCloseStatus: undefined,
      summary: {
        ...detailReport.summary,
        calculationContract: undefined,
        calculationRule: undefined,
      },
    }
    const historyReport = { ...partialTaxReport, taxYear: 2025 }
    stubReportRequests({
      taxYear: 2025,
      provisionalCurrentStatus: 404,
      history: [historyReport],
      detail: legacyDetail,
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('heading', { name: '장부 계산 요약' }),
    ).toBeInTheDocument()
    expect(screen.getByText('연간 마감 미확인')).toBeInTheDocument()
    expect(
      screen.getByText('이 발행본만으로 계산 계약 확인 불가'),
    ).toBeInTheDocument()
  })
})
