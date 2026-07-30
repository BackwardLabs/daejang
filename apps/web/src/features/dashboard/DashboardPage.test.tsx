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
})
