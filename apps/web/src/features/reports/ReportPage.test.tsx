import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { ReportPage } from './ReportPage.tsx'

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

const finalTaxReport = {
  ...partialTaxReport,
  reportId: 'tax-report-final-1',
  finality: 'FINAL',
  status: 'FINAL',
  filingStatus: 'READY',
  pointerVersion: 3,
} as const

const enabledPaymentCapability = {
  enabled: true,
  network: 'eip155:91342',
  asset: '0x1ce6222bd60923a9d5209a7e191016294dc2c961',
  amount: '100000',
  payTo: '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0',
  maxTimeoutSeconds: 300,
  tokenName: 'Mock USD',
  tokenVersion: '1',
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubReportRequests(options: {
  capability?: unknown
  capabilityRejects?: boolean
  report?: typeof partialTaxReport | typeof finalTaxReport
} = {}) {
  const report = options.report ?? partialTaxReport
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/report-payments/capabilities')) {
        if (options.capabilityRejects) {
          throw new Error('capability unavailable')
        }
        return jsonResponse(options.capability ?? { enabled: false })
      }
      if (url.includes('/report-attestations/synthetic-publication')) {
        return jsonResponse({
          capability: {
            enabled: false,
            network: 'eip155:91342',
            mode: 'SYNTHETIC_TESTNET',
            explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
            reasonCode: 'NOT_CONFIGURED',
          },
          fixture: {
            taxYear: 2025,
            transactionCount: 12,
            completeCount: 10,
            exceptionCount: 2,
            denomination: 'KRW',
          },
          status: null,
          verification: null,
        })
      }
      if (url.includes('/tax-reports/2027/current')) {
        return jsonResponse({ report })
      }
      if (url.includes('/tax-reports/2027/history')) {
        return jsonResponse({ items: [report] })
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
    render(<ReportPage />)

    expect(
      await screen.findByRole('heading', {
        name: '2027년 현재 세금 계산 결과',
      }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', {
        name: '합성 장부 온체인 증명',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('SYNTHETIC · GIWA SEPOLIA TESTNET'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '장부 생성 및 제출' }),
    ).toBeDisabled()
    expect(
      screen.queryByText('기술 연결 정보'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '발행 산출물 이력' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('PROVISIONAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PARTIAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('BLOCKED').length).toBeGreaterThan(0)
    expect(screen.getAllByText('미확정')).toHaveLength(4)
    expect(screen.queryByText('0 KRW')).not.toBeInTheDocument()
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
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false)
  })

  it('keeps payment hidden when the server capability is disabled', async () => {
    stubReportRequests({ report: finalTaxReport })

    render(<ReportPage />)

    expect(
      await screen.findByRole('heading', {
        name: '2027년 현재 세금 계산 결과',
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Mock USD로 내려받기' }),
    ).not.toBeInTheDocument()
  })

  it('offers payment only for a server-enabled FINAL and READY result', async () => {
    stubReportRequests({
      capability: enabledPaymentCapability,
      report: finalTaxReport,
    })

    render(<ReportPage />)

    expect(
      await screen.findByRole('button', { name: 'Mock USD로 내려받기' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/현재 revision #3의 JSON 다운로드 권한/),
    ).toBeInTheDocument()
  })

  it('isolates a capability failure from the normal report screen', async () => {
    stubReportRequests({
      capabilityRejects: true,
      report: finalTaxReport,
    })

    render(<ReportPage />)

    expect(
      await screen.findByRole('heading', {
        name: '2027년 현재 세금 계산 결과',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '발행 산출물 이력' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Mock USD로 내려받기' }),
    ).not.toBeInTheDocument()
  })

  it('uses and updates the shared tax-year preference', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2026' })

    render(<ReportPage />)

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
