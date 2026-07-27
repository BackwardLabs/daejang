import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LedgerPage } from './LedgerPage.tsx'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ items: String(input).includes('/reviews') ? [] : [] }), { status: 200, headers: { 'content-type': 'application/json' } }))) })

describe('LedgerPage', () => {
  it('shows the real empty state when the API has no events', async () => {
    render(<LedgerPage />)
    expect(await screen.findByRole('heading', { name: '아직 처리된 거래가 없습니다' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/ledger?taxYear=2027'), expect.anything())
  })
})
