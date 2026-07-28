import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { X402PaymentPage } from './X402PaymentPage.tsx'
import type {
  X402PaymentClient,
  X402PaymentQuote,
  X402PaymentResult,
} from './x402PaymentApi.ts'

const quote: X402PaymentQuote = {
  resourceUrl: 'https://x402.test/api/demo/x402/synthetic-report',
  required: {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:91342',
        asset: '0x1ce6222bd60923a9d5209a7e191016294dc2c961',
        amount: '100000',
        payTo: '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0',
        maxTimeoutSeconds: 300,
        extra: { name: 'Mock USD', version: '1' },
      },
    ],
    resource: {
      url: 'https://x402.test/api/demo/x402/synthetic-report',
    },
  },
  requirement: {
    scheme: 'exact',
    network: 'eip155:91342',
    asset: '0x1ce6222bd60923a9d5209a7e191016294dc2c961',
    amount: '100000',
    payTo: '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0',
    maxTimeoutSeconds: 300,
    extra: { name: 'Mock USD', version: '1' },
  },
}

const delivered: X402PaymentResult = {
  report: {
    kind: 'synthetic-report',
    environment: 'giwa-sepolia',
    fixture: true,
    productionReport: false,
    reportId: 'synthetic-giwa-001',
    revision: 1,
    summary: {
      transactions: 3,
      income: '1250.00',
      expense: '340.00',
      net: '910.00',
    },
  },
  paymentResponse: {
    success: true,
    transaction: `0x${'a'.repeat(64)}`,
    network: 'eip155:91342',
    payer: '0x25638B5B5c7C7747c7554A41713E418815EEa774',
  },
  explorerUrl: `https://sepolia-explorer.giwa.io/tx/0x${'a'.repeat(64)}`,
}

function createClient(
  overrides: Partial<X402PaymentClient> = {},
): X402PaymentClient {
  return {
    loadQuote: vi.fn(async () => quote),
    executePayment: vi.fn(async () => delivered),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('X402PaymentPage', () => {
  it('shows a stable state when the x402 demo API base URL is missing', async () => {
    const client = createClient({
      loadQuote: vi.fn(async () => {
        throw new Error('데모 API 연결 필요: VITE_X402_DEMO_API_BASE_URL 설정이 필요합니다.')
      }),
    })

    render(<X402PaymentPage client={client} />)

    expect(
      await screen.findByText(/VITE_X402_DEMO_API_BASE_URL/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '지갑에서 x402 payload 서명' }),
    ).toBeDisabled()
  })

  it('renders the 402 quote and GIWA Sepolia payment requirements', async () => {
    render(<X402PaymentPage client={createClient()} />)

    expect(
      await screen.findByRole('heading', { name: 'mock payment payload 서명이 필요합니다' }),
    ).toBeInTheDocument()
    expect(screen.getByText('0.1 mUSD')).toBeInTheDocument()
    expect(screen.getByText('eip155:91342')).toBeInTheDocument()
    expect(screen.getByText('100000 atomic')).toBeInTheDocument()
  })

  it('keeps the resource locked when the wallet signature is cancelled', async () => {
    const client = createClient({
      executePayment: vi.fn(async () => {
        throw new Error('사용자가 지갑 서명을 취소했습니다.')
      }),
    })

    render(<X402PaymentPage client={client} />)
    fireEvent.click(
      await screen.findByRole('button', { name: '지갑에서 x402 payload 서명' }),
    )

    expect(
      await screen.findByRole('heading', { name: '서명이 취소되었습니다' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('synthetic-giwa-001')).not.toBeInTheDocument()
  })

  it('shows settlement pending while the facilitator request is in flight', async () => {
    const pending = deferred<X402PaymentResult>()
    const client = createClient({
      executePayment: vi.fn((_loadedQuote, _signal, onPhaseChange) => {
        onPhaseChange?.('settling')
        return pending.promise
      }),
    })

    render(<X402PaymentPage client={client} />)
    fireEvent.click(
      await screen.findByRole('button', { name: '지갑에서 x402 payload 서명' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'facilitator가 GIWA Sepolia에서 정산하고 있습니다',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '정산 확인 중' })).toBeDisabled()

    pending.resolve(delivered)
  })

  it('renders the delivered report and payment response evidence', async () => {
    const client = createClient({
      executePayment: vi.fn(async (_loadedQuote, _signal, onPhaseChange) => {
        onPhaseChange?.('signing')
        onPhaseChange?.('settling')
        return delivered
      }),
    })

    render(<X402PaymentPage client={client} />)
    fireEvent.click(
      await screen.findByRole('button', { name: '지갑에서 x402 payload 서명' }),
    )

    expect(
      await screen.findByRole('heading', { name: '정산 증빙과 synthetic report를 받았습니다' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'synthetic-giwa-001' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /0xaaaa/ })).toHaveAttribute(
      'href',
      delivered.explorerUrl,
    )
  })

  it('shows a failed payment state without exposing the report', async () => {
    const client = createClient({
      executePayment: vi.fn(async (_loadedQuote, _signal, onPhaseChange) => {
        onPhaseChange?.('settling')
        throw new Error('정산 요청이 HTTP 402로 실패했습니다.')
      }),
    })

    render(<X402PaymentPage client={client} />)
    fireEvent.click(
      await screen.findByRole('button', { name: '지갑에서 x402 payload 서명' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'x402 mock payment 흐름을 완료하지 못했습니다' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('synthetic-giwa-001')).not.toBeInTheDocument()
  })
})
