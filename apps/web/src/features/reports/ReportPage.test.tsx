import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportPage } from './ReportPage.tsx'

const taxReport = {
  reportId: 'tax-report-1',
  taxYear: 2027,
  finality: 'PROVISIONAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  pointerVersion: '2',
  denominationAssetId: 'KRW',
  issuedAt: '2027-02-01T00:00:00Z',
  counts: { disposals: 3, transfers: 2, excludedConversions: 1, limitations: 1 },
  gainLoss: { status: 'KNOWN', amount: '125000', hasAmount: true },
  taxableBase: { status: 'UNKNOWN', hasAmount: false },
  nationalTax: { status: 'UNKNOWN', hasAmount: false },
  localTax: { status: 'UNKNOWN', hasAmount: false },
  totalTax: { status: 'UNKNOWN', amount: '', hasAmount: false },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const payload = url.includes('/tax-reports/2027/current')
      ? { report: taxReport }
      : url.includes('/tax-reports/2027/history')
        ? { items: [taxReport] }
        : { items: [] }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
})

describe('ReportPage', () => {
  it('keeps canonical tax results separate from immutable artifact history', async () => {
    render(<ReportPage />)

    expect(await screen.findByRole('heading', { name: '2027년 현재 세금 계산 결과' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '발행 산출물 이력' })).toBeInTheDocument()
    expect(screen.getAllByText('PROVISIONAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PARTIAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('BLOCKED').length).toBeGreaterThan(0)
    expect(screen.getAllByText('미확정')).toHaveLength(4)
    expect(screen.queryByText('0 KRW')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '아직 발행된 산출물이 없습니다' })).toBeInTheDocument()

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/reports?taxYear=2027'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/tax-reports/2027/current'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/tax-reports/2027/history?limit=20'))).toBe(true)
  })
})
