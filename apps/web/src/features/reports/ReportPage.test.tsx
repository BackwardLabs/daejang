import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportPage } from './ReportPage.tsx'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))) })
describe('ReportPage', () => {
  it('shows an honest empty state', async () => {
    render(<ReportPage />)
    expect(await screen.findByRole('heading', { name: '아직 발행된 보고서가 없습니다' })).toBeInTheDocument()
  })

  it('offers x402 download only for a FINAL report', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/tax-reports/') ? {
      report: {
        schemaVersion: 'giwa.web.tax-report.v1', reportId: 'tax-report-final-1', residentId: 'resident-1',
        taxYear: 2027, finality: 'FINAL', status: 'FINAL', filingStatus: 'READY', pointerVersion: 3,
        reportArtifactDigest: 'f'.repeat(64),
      },
    } : {
      items: [{
        id: 'report-final-1', taxYear: 2027, status: 'FINAL', inputDigest: 'a'.repeat(64),
        resultDigest: 'b'.repeat(64), schemaDigest: 'c'.repeat(64), transactionCount: 1,
        completeCount: 1, exceptionCount: 0, profitAmount: '1000', denomination: 'KRW',
        manifestDigest: 'd'.repeat(64), rowDigest: 'e'.repeat(64), issuedAt: '2028-01-01T00:00:00.000Z',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    render(<ReportPage />)
    expect(await screen.findByRole('button', { name: 'Mock USD로 내려받기' })).toBeInTheDocument()
    expect(screen.getByText(/신고용 보고서 revision #3의 JSON 다운로드 권한/)).toBeInTheDocument()
  })
})
