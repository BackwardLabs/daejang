import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRouter } from './AppRouter.tsx'

afterEach(() => {
  window.history.pushState({}, '', '/')
})

describe('AppRouter', () => {
  it('keeps the existing landing page at the root path', () => {
    window.history.pushState({}, '', '/')

    render(<AppRouter />)

    expect(
      screen.getByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('renders the dashboard', () => {
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      screen.getByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    expect(screen.getByText('₩84,270,000')).toBeInTheDocument()
  })

  it('renders the ledger workspace', () => {
    window.history.pushState({}, '', '/ledger')

    render(<AppRouter />)

    expect(
      screen.getByRole('heading', { name: '2027 장부 만들기' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Mock 검증 도구')).not.toBeInTheDocument()
  })

  it('renders the data-linked report workspace', () => {
    window.history.pushState({}, '', '/reports')

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: '보고서' })).toBeInTheDocument()
    expect(screen.getByText('24건')).toBeInTheDocument()
    expect(screen.getByText('완전 10 · 예외 14')).toBeInTheDocument()
  })

  it('logs the mock user out from the shared sidebar', () => {
    window.history.pushState({}, '', '/dashboard')
    render(<AppRouter />)

    fireEvent.click(screen.getByRole('button', { name: /김대장/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '로그아웃' }))

    expect(window.location.pathname).toBe('/')
    expect(
      screen.getByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('renders the source management page', () => {
    window.history.pushState({}, '', '/sources')

    render(<AppRouter />)

    expect(
      screen.getByRole('heading', { name: '데이터 소스 관리' }),
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
      await screen.findByRole('heading', { name: heading }),
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

  it('renders the settings product page', () => {
    window.history.pushState({}, '', '/settings')

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: '설정' })).toBeInTheDocument()
  })
})
