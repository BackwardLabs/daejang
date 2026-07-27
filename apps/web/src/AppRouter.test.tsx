import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRouter } from './AppRouter.tsx'

afterEach(() => {
  window.history.pushState({}, '', '/')
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.endsWith('/me')
      ? { user: { id: '00000000-0000-4000-8000-000000000001', displayName: '김대장' } }
      : url.includes('/dashboard')
        ? { dashboard: { sourceCount: 0, transactionCount: 0, openReviewCount: 0, completedCount: 0, exceptionCount: 0, lastSyncState: '' } }
        : { items: [] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

describe('AppRouter', () => {
  it('keeps the existing landing page at the root path', () => {
    window.history.pushState({}, '', '/')

    render(<AppRouter />)

    expect(
      screen.getByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('renders the dashboard', async () => {
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
  })

  it('renders the ledger workspace', async () => {
    window.history.pushState({}, '', '/ledger')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '거래 장부' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Mock 검증 도구')).not.toBeInTheDocument()
  })

  it('renders the data-linked report workspace', async () => {
    window.history.pushState({}, '', '/reports')

    render(<AppRouter />)

    expect(await screen.findByRole('heading', { name: '보고서' })).toBeInTheDocument()
  })

  it('logs the mock user out from the shared sidebar', async () => {
    window.history.pushState({}, '', '/dashboard')
    render(<AppRouter />)

    fireEvent.click(await screen.findByRole('button', { name: /김대장/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '로그아웃' }))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(
      screen.getByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('renders the source management page', async () => {
    window.history.pushState({}, '', '/sources')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '데이터 소스 관리' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
  })

  it.each([
    ['/sources/new', '데이터 소스 추가'],
    ['/sources/new/upbit', 'Upbit PDF 등록'],
    ['/sources/new/upbit/upload', 'Upbit PDF 등록'],
    ['/sources/new/wallet', 'EVM Wallet 연결'],
    ['/sources/new/wallet/connect', 'EVM Wallet 연결'],
  ])('renders the source flow page at %s', async (path, heading) => {
    window.history.pushState({}, '', path)

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: heading }, { timeout: 3_000 }),
    ).toBeInTheDocument()
  })

  it('fails closed when the Reown project ID is not configured', async () => {
    window.history.pushState({}, '', '/sources/new/wallet/connect')

    render(<AppRouter />)

    fireEvent.click(
      await screen.findByRole('radio', { name: 'WalletConnect (Reown)' }),
    )
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    expect(
      await screen.findByText('선택한 지갑을 사용할 수 없어요'),
    ).toBeInTheDocument()
  })

  it('renders the settings product page', async () => {
    window.history.pushState({}, '', '/settings')

    render(<AppRouter />)

    expect(await screen.findByRole('heading', { name: '설정' })).toBeInTheDocument()
  })
})
