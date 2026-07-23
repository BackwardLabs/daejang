import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage.tsx'

afterEach(() => {
  vi.useRealTimers()
})

describe('DashboardPage', () => {
  it('renders the Figma portfolio summary, sources, and holdings', () => {
    render(<DashboardPage />)

    expect(screen.getByText('김지우')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '대시보드' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: '장부 작업' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(screen.getByText('총 보유자산 (KRW 환산)')).toBeInTheDocument()
    expect(screen.getByText('연결 소스 4곳')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '소스별 보유 현황' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Upbit' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ethereum 지갑' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Base 지갑' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bithumb' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /ETHEthereum 4.58 ETH/ })).toBeInTheDocument()
  })

  it('switches the holdings table to the source view', () => {
    render(<DashboardPage />)

    fireEvent.click(screen.getByRole('tab', { name: '소스별' }))

    expect(screen.getByRole('tab', { name: '소스별' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('columnheader', { name: '연결 정보' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /CEXUpbit 3개 자산/ })).toBeInTheDocument()
  })

  it('uses mock snapshots for year changes and synchronization', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 24, 9, 7))
    const { unmount } = render(<DashboardPage />)

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2026' },
    })
    expect(screen.getByText('₩52,780,000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '동기화 불가' })).toBeDisabled()
    expect(screen.getByText(/2026년은 마감된 과세연도/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2027' },
    })
    fireEvent.click(screen.getByRole('button', { name: '동기화' }))
    expect(screen.getByRole('button', { name: '동기화 중…' })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(screen.getByText('₩66,670,000')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('동기화가 완료되었습니다')
    expect(screen.getByText('2026-07-24 09:07 기준')).toBeInTheDocument()

    unmount()
    render(<DashboardPage />)

    expect(screen.getByText('2026-07-24 09:07 기준')).toBeInTheDocument()
    expect(screen.getByText('₩66,670,000')).toBeInTheDocument()
  })

  it('links the dashboard actions and sidebar to product routes', () => {
    render(<DashboardPage />)

    expect(screen.getByRole('link', { name: '장부 작업' })).toHaveAttribute(
      'href',
      '/app/ledger',
    )
    expect(screen.getByRole('link', { name: '소스 연결' })).toHaveAttribute(
      'href',
      '/app/sources',
    )
  })
})
