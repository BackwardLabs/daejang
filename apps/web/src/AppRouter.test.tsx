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

  it.each(['/dashboard', '/app/dashboard', '/features/dashboard/'])(
    'renders the dashboard at %s',
    (path) => {
      window.history.pushState({}, '', path)

      render(<AppRouter />)

      expect(
        screen.getByRole('heading', { name: '세무 장부 요약' }),
      ).toBeInTheDocument()
      expect(screen.getByText('₩84,270,000')).toBeInTheDocument()
    },
  )

  it.each(['/ledger', '/app/ledger', '/features/ledger/'])(
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

  it.each([
    ['/sources', '데이터 소스'],
    ['/settings', '설정'],
  ])('renders the product page at %s', (path, heading) => {
    window.history.pushState({}, '', path)

    render(<AppRouter />)

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it.each([
    ['/app/dashboard', '/dashboard'],
    ['/app/ledger', '/ledger'],
    ['/app/reports', '/reports'],
    ['/app/sources', '/sources'],
    ['/app/settings', '/settings'],
  ])('redirects the legacy route %s to %s', (legacyPath, canonicalPath) => {
    window.history.pushState({}, '', legacyPath)

    render(<AppRouter />)

    expect(window.location.pathname).toBe(canonicalPath)
  })
})
