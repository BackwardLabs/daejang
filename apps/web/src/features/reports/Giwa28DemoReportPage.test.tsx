import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { saveAppPreferences } from '../../preferences/appPreferences.ts'
import { ReportPage } from './Giwa28DemoReportPage.tsx'

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  saveAppPreferences({ currency: 'KRW', year: '2027' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/report-attestations/synthetic-publication')) {
        return jsonResponse({
          capability: {
            enabled: false,
            network: 'eip155:91342',
            mode: 'SYNTHETIC_TESTNET',
            explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
            reasonCode: 'NOT_CONFIGURED',
          },
          fixture: {
            taxYear: 2025,
            transactionCount: 12,
            completeCount: 10,
            exceptionCount: 2,
            denomination: 'KRW',
          },
          status: null,
          verification: null,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }),
  )
})

describe('Giwa28DemoReportPage', () => {
  it('shows only the isolated synthetic GIWA-28 report demo', async () => {
    render(<ReportPage />)

    expect(
      await screen.findByRole('heading', {
        name: '합성 장부 온체인 증명',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '보고서 데모' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '현재 세금 계산' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '발행 산출물 이력' }),
    ).not.toBeInTheDocument()

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      '/report-attestations/synthetic-publication',
    )
  })
})
