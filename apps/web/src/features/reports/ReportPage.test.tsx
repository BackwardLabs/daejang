import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportPage } from './ReportPage.tsx'
import type { ReportModel } from '../../api/productApi.ts'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))) })

const report: ReportModel = {
  id: 'report-2027-001',
  taxYear: 2027,
  status: 'FINAL',
  inputDigest: '0xinput',
  resultDigest: '0xresult',
  schemaDigest: '0xschema',
  transactionCount: 3,
  completeCount: 3,
  exceptionCount: 0,
  profitAmount: '910',
  denomination: 'KRW',
  manifestDigest: '0xmanifest',
  rowDigest: '0xrow',
  issuedAt: '2026-07-28T00:00:00.000Z',
}

describe('ReportPage', () => {
  it('shows an honest empty state', async () => {
    render(<ReportPage />)
    expect(
      await screen.findByRole('heading', { name: '아직 발행된 보고서가 없습니다' }),
    ).toBeInTheDocument()
  })

  it('links a selected report to the GIWA Sepolia x402 payment demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [report] }), { status: 200, headers: { 'content-type': 'application/json' } })))

    render(<ReportPage />)

    expect(
      await screen.findByRole('link', { name: 'GIWA Sepolia 결제 데모' }),
    ).toHaveAttribute('href', '/reports/x402-payment')
  })
})
