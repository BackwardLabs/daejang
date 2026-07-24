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
      screen.getByRole('heading', { name: '흩어진 거래 기록을검토 가능한 장부로' }),
    ).toBeInTheDocument()
  })

  it.each(['/app/dashboard', '/features/dashboard/'])(
    'renders the dashboard at %s',
    (path) => {
      window.history.pushState({}, '', path)

      render(<AppRouter />)

      expect(screen.getByRole('heading', { name: '대시보드' })).toBeInTheDocument()
      expect(screen.getByText('₩66,350,000')).toBeInTheDocument()
    },
  )

  it.each(['/app/ledger', '/features/ledger/'])(
    'renders the ledger workspace at %s',
    (path) => {
      window.history.pushState({}, '', path)

      render(<AppRouter />)

      expect(
        screen.getByRole('heading', { name: '2027 장부 만들기' }),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('Mock 검증 도구'),
      ).not.toBeInTheDocument()
    },
  )

  it('renders the data-linked report workspace', () => {
    window.history.pushState({}, '', '/app/reports')

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: '보고서' })).toBeInTheDocument()
    expect(screen.getByText('24건')).toBeInTheDocument()
    expect(screen.getByText('완전 10 · 예외 14')).toBeInTheDocument()
  })

  it('logs the mock user out from the shared sidebar', () => {
    window.history.pushState({}, '', '/app/dashboard')
    render(<AppRouter />)

    fireEvent.click(screen.getByRole('button', { name: /김지우/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '로그아웃' }))

    expect(window.location.pathname).toBe('/')
    expect(
      screen.getByRole('heading', { name: '흩어진 거래 기록을검토 가능한 장부로' }),
    ).toBeInTheDocument()
  })

  it('renders the source management page', () => {
    window.history.pushState({}, '', '/app/sources')

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
    ['/app/sources/new', '데이터 소스 추가'],
    ['/app/sources/new/upbit', 'Upbit PDF 등록'],
    ['/app/sources/new/wallet', 'EVM 공개 주소 등록'],
  ])('renders the source flow page at %s', (path, heading) => {
    window.history.pushState({}, '', path)

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('renders the settings product page', () => {
    window.history.pushState({}, '', '/app/settings')

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: '설정' })).toBeInTheDocument()
  })
})
