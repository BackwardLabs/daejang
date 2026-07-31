import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { ReportWorkspacePage } from './ReportPage.tsx'

const partialTaxReport = {
  reportId: 'tax-report-1',
  taxYear: 2027,
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
  finality: 'PROVISIONAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  denominationAssetId: 'KRW',
  issuedAt: '2027-02-01T00:00:00Z',
  counts: partialTaxReport.counts,
  summary: {
    gainLoss: knownAmount('125000'),
    taxableBase: unknownAmount,
    nationalTax: unknownAmount,
    localTax: unknownAmount,
    totalTax: unknownAmount,
  },
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
      costMethod: 'MOVING_AVERAGE',
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

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubReportRequests(options: {
  detail?: unknown
  detailStatus?: number
} = {}) {
  const detail = options.detail ?? detailReport
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/tax-reports/2027/current')) {
        return jsonResponse({ report: partialTaxReport })
      }
      if (url.includes('/tax-reports/2027/history')) {
        return jsonResponse({ items: [partialTaxReport] })
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
  it('keeps canonical tax results separate from immutable artifact history', async () => {
    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('heading', {
        name: '2027년 현재 세금 계산 결과',
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name: '합성 장부 온체인 증명',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '발행 산출물 이력' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('PROVISIONAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PARTIAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('BLOCKED').length).toBeGreaterThan(0)
    expect(screen.getAllByText('미확정').length).toBeGreaterThanOrEqual(4)
    expect(screen.queryByText('0 KRW')).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: '2027년 세무 장부 상세' }),
    ).toBeInTheDocument()
    expect(screen.getByText('0 KRW')).toBeInTheDocument()
    expect(screen.getAllByText('미확정').length).toBeGreaterThanOrEqual(8)
    expect(
      screen.getByRole('heading', { name: '처분 장부' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '이체' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '과세 제외 전환' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '제한사항' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '계산 기준과 추적 정보' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'PDF 내려받기' }),
    ).toHaveAttribute(
      'href',
      '/api/v1/tax-reports/tax-report-1/artifacts/pdf',
    )
    expect(
      screen.getByRole('link', { name: 'PDF 내려받기' }),
    ).toHaveAttribute('download')
    expect(screen.getByText('BASIS_UNKNOWN')).toBeInTheDocument()
    expect(screen.getByText(/리뷰 review-1/u)).toBeInTheDocument()
    expect(screen.getByText(/review-revision-1/u)).toBeInTheDocument()
    expect(screen.getByText(/leg-2-out/u)).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', {
        name: '아직 발행된 산출물이 없습니다',
      }),
    ).toBeInTheDocument()

    const fetchMock = vi.mocked(fetch)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/reports?taxYear=2027'),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/tax-reports/tax-report-1'),
      ),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/v1/tax-reports/2027/current'),
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

    expect(await screen.findByText('disposal-large-119')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(125)
    expect(
      screen.getByText('120건', { selector: '.tax-report-detail__section > header p' }),
    ).toBeInTheDocument()
  })

  it('shows explicit empty states for an exact report with no ledger rows', async () => {
    stubReportRequests({
      detail: {
        ...detailReport,
        status: 'FINAL',
        filingStatus: 'READY',
        finality: 'FINAL',
        counts: {
          disposals: 0,
          transfers: 0,
          excludedConversions: 0,
          limitations: 0,
        },
        disposals: [],
        transfers: [],
        excludedConversions: [],
        limitations: [],
      },
    })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText('이 장부에 포함된 처분이 없습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('이 장부에 포함된 이체가 없습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('과세 대상에서 제외된 동일 자산 전환이 없습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('현재 장부 결과를 제한하는 항목이 없습니다.'),
    ).toBeInTheDocument()
  })

  it('keeps the current summary visible when exact detail returns 404', async () => {
    stubReportRequests({ detailStatus: 404 })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByText(
        '현재 세금 계산은 확인했지만 상세 장부는 아직 준비되지 않았습니다.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '2027년 현재 세금 계산 결과' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'PDF 내려받기' }),
    ).not.toBeInTheDocument()
  })

  it('isolates an exact detail failure from summary and history', async () => {
    stubReportRequests({ detailStatus: 503 })

    render(<ReportWorkspacePage />)

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(
      '현재 세금 계산은 유지되지만 상세 장부를 불러오지 못했습니다.',
    )
    expect(
      screen.getByRole('heading', { name: '세금 계산 이력' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '발행 산출물 이력' }),
    ).toBeInTheDocument()
  })

  it('uses and updates the shared tax-year preference', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2026' })

    render(<ReportWorkspacePage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
    expect(
      await screen.findByText(
        '현재 세금 계산 결과는 2027년 이후 과세연도부터 제공됩니다.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) =>
          String(url).endsWith('/api/v1/reports?taxYear=2026'),
        ),
      ).toBe(true)
    })

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2025' },
    })

    expect(loadAppPreferences().year).toBe('2025')
  })
})
