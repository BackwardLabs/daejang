import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppYear } from '../../components/AppSidebar.tsx'
import { DashboardPage } from './DashboardPage.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('/dashboard') ? { dashboard: { sourceCount: 2, transactionCount: 1, openReviewCount: 0, completedCount: 1, exceptionCount: 0, lastSyncState: 'SUCCEEDED' } } : { items: [] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

describe('DashboardPage', () => {
  it('renders actual API metrics and empty queues', async () => {
    render(<DashboardPage />)
    expect((await screen.findAllByText('1건')).length).toBeGreaterThan(0)
    expect(screen.getByText('2개')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '월별 거래 흐름' })).toBeInTheDocument()
    expect(screen.getByText('열린 검토가 없습니다')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`taxYear=${defaultAppYear()}`),
      expect.anything(),
    )
  })

  it('reloads when the tax year changes', async () => {
    render(<DashboardPage />)
    await screen.findByText('2개')
    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), { target: { value: '2026' } })
    expect(await screen.findByText('2개')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('taxYear=2026'), expect.anything())
  })

  it('normalizes recent transaction assets, quantities, valuations, and support labels', async () => {
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard')) return new Response(JSON.stringify({ dashboard: { sourceCount: 2, transactionCount: 1, openReviewCount: 0, completedCount: 1, exceptionCount: 0, lastSyncState: 'SUCCEEDED' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/ledger?')) return new Response(JSON.stringify({ items: [event] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    render(<DashboardPage />)

    expect(await screen.findByText('USDT')).toBeInTheDocument()
    expect(screen.getByText('외 1개 자산')).toBeInTheDocument()
    expect(screen.getByText('1,801.08722461 USDT')).toBeInTheDocument()
    expect(screen.getByText('2,701,901.16 KRW')).toBeInTheDocument()
    expect(screen.getByText('근거 확인 완료')).toBeInTheDocument()
    expect(screen.queryByText('asset-usdt-upbit')).not.toBeInTheDocument()
    expect(screen.queryByText('FULL')).not.toBeInTheDocument()
  })
})
