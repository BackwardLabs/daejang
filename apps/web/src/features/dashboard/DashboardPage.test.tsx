import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage.tsx'

afterEach(() => {
  vi.useRealTimers()
})

describe('DashboardPage', () => {
  it('renders the Figma ledger overview hierarchy', () => {
    render(<DashboardPage />)

    expect(screen.getByText('김대장')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '대시보드' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    expect(screen.getByText('1,284건')).toBeInTheDocument()
    expect(screen.getAllByText('12건')).toHaveLength(2)
    expect(screen.getByText('₩84,270,000')).toBeInTheDocument()
    expect(screen.getByText('92.4%')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '월별 거래 흐름' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '검토 큐' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '최근 거래' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /12.18 14:22 매도 ETH/ })).toBeInTheDocument()
  })

  it('uses mock snapshots for year changes and synchronization', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 24, 9, 7))
    const { unmount } = render(<DashboardPage />)

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2026' },
    })
    expect(screen.getByText('₩71,640,000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '마감된 연도' })).toBeDisabled()
    expect(screen.getByText(/2026년은 마감된 과세연도/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2027' },
    })
    fireEvent.click(screen.getByRole('button', { name: '방금 동기화' }))
    expect(screen.getByRole('button', { name: '동기화 중…' })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(screen.getByText('₩84,590,000')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('동기화가 완료되었습니다')
    expect(screen.getByTitle('2026-07-24 09:07 기준')).toBeInTheDocument()

    unmount()
    render(<DashboardPage />)

    expect(screen.getByText('₩84,590,000')).toBeInTheDocument()
    expect(screen.getByTitle('2026-07-24 09:07 기준')).toBeInTheDocument()
  })

  it('links dashboard actions and sidebar items to product routes', () => {
    render(<DashboardPage />)

    expect(screen.getByRole('link', { name: '장부 작업' })).toHaveAttribute(
      'href',
      '/ledger',
    )
    expect(screen.getByRole('link', { name: '보고서 보기' })).toHaveAttribute(
      'href',
      '/reports',
    )
    expect(screen.getByRole('link', { name: '거래 추가' })).toHaveAttribute(
      'href',
      '/sources',
    )
    expect(screen.getByRole('link', { name: '거래소·지갑' })).toHaveAttribute(
      'href',
      '/sources',
    )
  })
})
