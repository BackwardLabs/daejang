import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultAppYear,
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { DashboardPage } from './DashboardPage.tsx'

const dashboardPayload = {
  dashboard: {
    sourceCount: 2,
    transactionCount: 1,
    openReviewCount: 0,
    completedCount: 1,
    exceptionCount: 0,
    lastSyncState: 'SUCCEEDED',
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('/dashboard')
      ? dashboardPayload
      : { items: [] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DashboardPage', () => {
  it('renders actual API metrics and empty queues', async () => {
    render(<DashboardPage />)
    expect((await screen.findAllByText('1건')).length).toBeGreaterThan(0)
    expect(screen.getByText('2개')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '월별 거래 흐름' })).toBeInTheDocument()
    expect(screen.getByText('검토가 모두 완료되었습니다')).toBeInTheDocument()
    expect(
      screen.getByText('검토 대기 항목이 없습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('검토 현황'),
    ).toHaveAttribute('data-state', 'complete')
    expect(screen.getByRole('link', { name: '데이터 소스 추가' })).toHaveAttribute(
      'href',
      '/sources/new',
    )
    expect(screen.getByRole('link', { name: '보고서 보기' })).toHaveClass(
      'dashboard-action--primary',
    )
    expect(screen.queryByText('거래 추가')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '필터' })).not.toBeInTheDocument()
    const reviewMetric = screen.getByText('검토 완료').closest('article')
    expect(reviewMetric).not.toHaveClass('is-review')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`taxYear=${defaultAppYear()}`),
      expect.anything(),
    )
  })

  it('replaces review and source metrics when the tax year changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard')) {
        const is2027 = url.includes('taxYear=2027')
        return new Response(JSON.stringify({
          dashboard: {
            ...dashboardPayload.dashboard,
            sourceCount: is2027 ? 1 : 2,
            openReviewCount: is2027 ? 0 : 4,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    render(<DashboardPage />)
    await screen.findByText('2개')
    expect(screen.getAllByText('4건')).toHaveLength(2)

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), { target: { value: '2027' } })

    expect(await screen.findByText('1개')).toBeInTheDocument()
    expect(await screen.findByText('검토가 모두 완료되었습니다')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('taxYear=2027'), expect.anything())
    expect(loadAppPreferences().year).toBe('2027')
  })

  it('does not claim review completion before the dashboard is ready', async () => {
    let resolveDashboard: ((value: Response) => void) | undefined
    const pendingDashboard = new Promise<Response>((resolve) => {
      resolveDashboard = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/dashboard')) return pendingDashboard
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    render(<DashboardPage />)

    expect(screen.getByText('검토 현황을 불러오는 중입니다.')).toBeInTheDocument()
    expect(
      screen.queryByText('검토 대기 항목이 없습니다.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('검토가 모두 완료되었습니다'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('검토 현황을 불러오는 중입니다'),
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('검토 현황'),
    ).toHaveAttribute('data-state', 'loading')

    resolveDashboard?.(
      new Response(JSON.stringify(dashboardPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(
      await screen.findByText('검토 대기 항목이 없습니다.'),
    ).toBeInTheDocument()
  })

  it('reports manual refresh failure and success honestly', async () => {
    let dashboardReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/dashboard')) {
          dashboardReads += 1
          if (dashboardReads === 2) {
            return new Response(
              JSON.stringify({ error: { code: 'UNAVAILABLE' } }),
              {
                status: 503,
                headers: { 'content-type': 'application/json' },
              },
            )
          }
          return new Response(JSON.stringify(dashboardPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    render(<DashboardPage />)
    await screen.findByText('검토 대기 항목이 없습니다.')

    fireEvent.click(screen.getByRole('button', { name: '새로고침' }))
    expect(
      await screen.findByText(
        '최신 처리 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
      ),
    ).toHaveAttribute('role', 'alert')
    expect(
      screen.queryByText('최신 처리 상태를 불러왔습니다.'),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '새로고침' }))
    expect(
      await screen.findByText('최신 처리 상태를 불러왔습니다.'),
    ).toHaveAttribute('role', 'status')
  })

  it('starts from the saved year and keeps later page visits consistent', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })

    render(<DashboardPage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2025',
    )
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('taxYear=2025'),
        expect.anything(),
      )
    })
  })

  it('keeps the selected-year review summary and asset labels user-facing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const payload = url.includes('/dashboard')
          ? {
              dashboard: {
                ...dashboardPayload.dashboard,
                openReviewCount: 1,
              },
            }
          : {
                items: [{
                  eventId: 'event-1',
                  revisionId: 'revision-1',
                  revisionNumber: 1,
                  eventType: 'TRANSFER',
                  flowShape: 'EXTERNAL_IN',
                  resolution: 'RESOLVED',
                  interpretationSupport: 'SUPPORTED',
                  effectiveAt: '2026-07-30T00:00:00Z',
                  postings: [{
                    legId: 'leg-1',
                    accountId: 'upbit-account',
                    assetId: 'cex-document-asset:upbit:decimal8:usdt',
                    occurredAt: '2026-07-30T00:00:00Z',
                    direction: 'IN',
                    quantity: '125000000',
                    role: 'PRINCIPAL',
                    fairValue: '',
                    costBasis: '',
                    denomination: 'KRW',
                  }],
                }],
              }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    render(<DashboardPage />)

    expect(
      await screen.findByText('확인이 필요한 검토 항목이 1건 있습니다'),
    ).toBeInTheDocument()
    expect(screen.getByText('1.25 USDT')).toBeInTheDocument()
    expect(screen.getByText('Upbit · 입금')).toBeInTheDocument()
    expect(screen.getByText('환산 금액 없음')).toBeInTheDocument()
    expect(
      screen.queryByText('cex-document-asset:upbit:decimal8:usdt'),
    ).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/reviews'),
      expect.anything(),
    )
  })

  it('shows six recent transactions with compact source, asset, value, and status information', async () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })
    const event = {
      eventId: 'event-upbit-trade',
      revisionId: 'revision-upbit-trade',
      revisionNumber: 1,
      eventType: 'TRADE',
      flowShape: 'EXCHANGE',
      resolution: 'RESOLVED',
      interpretationSupport: 'FULL',
      effectiveAt: '2025-11-24T23:11:35Z',
      postings: [
        {
          legId: 'leg-usdt',
          accountId: 'cex-account:upbit:account',
          assetId: 'asset-usdt-upbit',
          occurredAt: '2025-11-24T23:11:35Z',
          direction: 'IN',
          quantity: '180108722461',
          role: 'PRINCIPAL',
          fairValue: '270190116000000',
          costBasis: '',
          denomination: 'asset-krw-upbit',
          assetSymbol: 'USDT',
          assetDecimals: 8,
          hasAssetDecimals: true,
          assetVenue: 'UPBIT',
        },
        {
          legId: 'leg-krw',
          accountId: 'cex-account:upbit:account',
          assetId: 'asset-krw-upbit',
          occurredAt: '2025-11-24T23:11:35Z',
          direction: 'OUT',
          quantity: '270163100000000',
          role: 'PRINCIPAL',
          fairValue: '270163100000000',
          costBasis: '',
          denomination: 'asset-krw-upbit',
          assetSymbol: 'KRW',
          assetDecimals: 8,
          hasAssetDecimals: true,
          assetVenue: 'UPBIT',
        },
      ],
    }
    const events = Array.from({ length: 7 }, (_, index) => ({
      ...event,
      eventId: `event-upbit-trade-${index + 1}`,
      revisionId: `revision-upbit-trade-${index + 1}`,
      effectiveAt: `2025-11-${String(24 - index).padStart(2, '0')}T23:11:35Z`,
      postings: event.postings.map((posting) => ({
        ...posting,
        legId: `${posting.legId}-${index + 1}`,
        ...(index === 6 && posting.legId === 'leg-usdt'
          ? {
              assetId: 'asset-btc-upbit',
              assetSymbol: 'BTC',
              quantity: '100000000',
            }
          : {}),
      })),
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard')) return new Response(JSON.stringify({ dashboard: { sourceCount: 2, transactionCount: 7, openReviewCount: 0, completedCount: 7, exceptionCount: 0, lastSyncState: 'SUCCEEDED' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/ledger?')) return new Response(JSON.stringify({ items: [...events].reverse() }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    render(<DashboardPage />)

    expect(await screen.findAllByText('1,801.08722461 USDT')).toHaveLength(6)
    expect(screen.getAllByText('Upbit · 거래')).toHaveLength(6)
    expect(screen.getAllByText('2,701,901.16 KRW')).toHaveLength(6)
    expect(screen.getAllByText('완료')).toHaveLength(6)
    expect(screen.getByTitle('11월 거래 7건')).toHaveTextContent('7건')
    expect(screen.queryByText(/BTC/)).not.toBeInTheDocument()
    expect(screen.queryByText('asset-usdt-upbit')).not.toBeInTheDocument()
    expect(screen.queryByText('FULL')).not.toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
  })

  it('replaces spam-like token labels in the dashboard while keeping normal values visible', async () => {
    const event = {
      eventId: 'event-spam-token',
      revisionId: 'revision-spam-token',
      revisionNumber: 1,
      eventType: 'TRANSFER',
      flowShape: 'EXTERNAL_IN',
      resolution: 'PARTIAL',
      interpretationSupport: 'DETECTED_ONLY',
      effectiveAt: '2026-07-30T00:00:00Z',
      postings: [{
        legId: 'leg-spam',
        accountId: 'wallet-account',
        accountKind: 'WALLET',
        accountLocator: '0x1234',
        accountChainId: 'eip155:10',
        assetId: 'asset-spam',
        assetSymbol: 'www.poxa.club 🎁',
        assetDecimals: 0,
        hasAssetDecimals: true,
        occurredAt: '2026-07-30T00:00:00Z',
        direction: 'IN',
        quantity: '2215',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard')) return new Response(JSON.stringify(dashboardPayload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/ledger?')) return new Response(JSON.stringify({ items: [event] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    render(<DashboardPage />)

    expect(
      await screen.findByText('2,215 미확인 토큰(스팸 의심)'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/poxa\.club/)).not.toBeInTheDocument()
  })

  it('formats one-leg CEX valuations using the canonical KRW denomination', async () => {
    const events = [
      {
        eventId: 'event-upbit-usdt-withdrawal',
        revisionId: 'revision-upbit-usdt-withdrawal',
        revisionNumber: 1,
        eventType: 'TRANSFER',
        flowShape: 'EXTERNAL_OUT',
        resolution: 'PARTIAL',
        interpretationSupport: 'DETECTED_ONLY',
        effectiveAt: '2025-11-25T06:00:34Z',
        postings: [{
          legId: 'leg-usdt',
          accountId: 'cex-account:upbit:account',
          assetId: 'asset-usdt-upbit',
          occurredAt: '2025-11-25T06:00:34Z',
          direction: 'OUT',
          quantity: '180108722500',
          role: 'PRINCIPAL',
          fairValue: '270163083750000',
          costBasis: '',
          denomination: 'asset-krw-upbit',
          assetSymbol: 'USDT',
          assetDecimals: 8,
          hasAssetDecimals: true,
          assetVenue: 'UPBIT',
        }],
      },
      {
        eventId: 'event-upbit-mon-deposit',
        revisionId: 'revision-upbit-mon-deposit',
        revisionNumber: 1,
        eventType: 'TRANSFER',
        flowShape: 'EXTERNAL_IN',
        resolution: 'PARTIAL',
        interpretationSupport: 'DETECTED_ONLY',
        effectiveAt: '2025-11-24T21:21:26Z',
        postings: [{
          legId: 'leg-mon',
          accountId: 'cex-account:upbit:account',
          assetId: 'asset-mon-upbit',
          occurredAt: '2025-11-24T21:21:26Z',
          direction: 'IN',
          quantity: '4210025064636',
          role: 'PRINCIPAL',
          fairValue: '221447318399853',
          costBasis: '',
          denomination: 'asset-krw-upbit',
          assetSymbol: 'MON',
          assetDecimals: 8,
          hasAssetDecimals: true,
          assetVenue: 'UPBIT',
        }],
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard')) return new Response(JSON.stringify({ dashboard: dashboardPayload.dashboard }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/ledger?')) return new Response(JSON.stringify({ items: events }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    render(<DashboardPage />)

    expect(await screen.findByText(/2,701,630\.8375 KRW/)).toBeInTheDocument()
    expect(screen.getByText(/2,214,473\.18399853 KRW/)).toBeInTheDocument()
    expect(screen.queryByText(/단위 확인 필요/)).not.toBeInTheDocument()
    expect(screen.queryByText(/자산 확인 필요/)).not.toBeInTheDocument()
  })
})
