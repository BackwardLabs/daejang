import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAppYear } from '../../components/AppSidebar.tsx'
import {
  appPreferencesStorageKey,
  loadAppPreferences,
} from '../../preferences/appPreferences.ts'
import { formatReviewQuantity, LedgerPage } from './LedgerPage.tsx'

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const reviewSummary = {
  id: 'review-1',
  executionId: 'execution-1',
  revisionId: 'revision-1',
  pointerVersion: '3',
  status: 'OPEN',
  reasonCodes: ['UNKNOWN_TRANSACTION'],
  createdAt: '2027-01-01T00:00:00.000Z',
}

const reviewDetail = {
  ...reviewSummary,
  revisionNumber: 1,
  inputDigest: 'a'.repeat(64),
  options: [
    { code: 'PERSONAL', label: '개인 거래', requiresEvidence: false },
    { code: 'PROVIDE_CONTEXT', label: '추가 맥락 제공', requiresEvidence: true },
  ],
  observations: [{
    fragmentId: 'fragment-1',
    observationId: 'observation-1',
    ordinal: 0,
    domain: 'EVM',
    kind: 'TRANSFER',
    nativeId: '0xabc123',
    occurredAt: '2027-01-01T00:00:00.000Z',
    accountLocator: '0xwallet',
    accountLabel: '주 지갑',
    accountChainId: '1',
    assetSymbol: 'ETH',
    assetLocator: 'eip155:1/slip44:60',
    assetDecimals: 18,
    hasAssetDecimals: true,
    quantity: '1250000000000000000',
    originKind: 'TRANSACTION',
    originLinkId: 'transaction-link-1',
  }],
  revisionCreatedAt: '2027-01-01T00:00:00.000Z',
}

const secondReviewSummary = {
  ...reviewSummary,
  id: 'review-2',
  executionId: 'execution-2',
  revisionId: 'revision-b1',
  pointerVersion: '1',
  reasonCodes: ['NEEDS_CONTEXT'],
}

const secondReviewDetail = {
  ...reviewDetail,
  ...secondReviewSummary,
}

const ledgerEvent = {
  eventId: 'event-2027',
  revisionId: 'ledger-revision-2027',
  revisionNumber: 1,
  eventType: 'TRADE',
  flowShape: 'INFLOW_OUTFLOW',
  resolution: 'RESOLVED',
  interpretationSupport: 'SUPPORTED',
  effectiveAt: '2027-01-01T00:00:00.000Z',
  postings: [],
}

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LedgerPage', () => {
  it('starts from the current supported calendar year', () => {
    expect(defaultAppYear(new Date('2025-07-30T00:00:00Z'))).toBe('2025')
    expect(defaultAppYear(new Date('2026-07-30T00:00:00Z'))).toBe('2026')
    expect(defaultAppYear(new Date('2027-07-30T00:00:00Z'))).toBe('2027')
    expect(defaultAppYear(new Date('2024-07-30T00:00:00Z'))).toBe('2025')
    expect(defaultAppYear(new Date('2028-07-30T00:00:00Z'))).toBe('2027')
  })

  it('formats canonical integer quantities without losing precision', () => {
    expect(formatReviewQuantity('1250000000000000000', 18)).toBe('1.25')
    expect(formatReviewQuantity('9007199254740993')).toBe(
      '9007199254740993 (단위 확인 필요)',
    )
    expect(formatReviewQuantity('-1', 18)).toBe('-0.000000000000000001')
  })

  it('shows parsed CEX assets, decimal quantities, and posting role explanations', async () => {
    const cexEvent = {
      ...ledgerEvent,
      postings: [
        {
          legId: 'leg-principal',
          accountId: 'account-upbit',
          assetId: 'cex-document-asset:upbit:decimal8:usdt',
          occurredAt: ledgerEvent.effectiveAt,
          direction: 'IN',
          quantity: '180108722461',
          role: 'PRINCIPAL',
          fairValue: '270190116000000',
          costBasis: '',
          denomination: 'cex-document-asset:upbit:decimal8:krw',
        },
        {
          legId: 'leg-quote',
          accountId: 'account-upbit',
          assetId: 'cex-document-asset:upbit:decimal8:krw',
          occurredAt: ledgerEvent.effectiveAt,
          direction: 'OUT',
          quantity: '270163100000000',
          role: 'PRINCIPAL',
          fairValue: '270163100000000',
          costBasis: '',
          denomination: 'cex-document-asset:upbit:decimal8:krw',
        },
        {
          legId: 'leg-fee',
          accountId: 'account-upbit',
          assetId: 'cex-document-asset:upbit:decimal8:krw',
          occurredAt: ledgerEvent.effectiveAt,
          direction: 'OUT',
          quantity: '2701600000',
          role: 'FEE',
          fairValue: '2701600000',
          costBasis: '',
          denomination: 'cex-document-asset:upbit:decimal8:krw',
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [cexEvent] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect(await screen.findAllByText('1,801.08722461 USDT')).toHaveLength(1)
    expect(screen.getAllByText('27.016 KRW')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: '자산 변동과 세무 입력' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '거래 거래 상세 보기' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: '거래 거래 상세 보기' }))

    expect(screen.getAllByText('1,801.08722461 USDT')).toHaveLength(2)
    expect(screen.getAllByText('27.016 KRW')).toHaveLength(3)
    expect(screen.getAllByText('Upbit · 소수점 8자리')).toHaveLength(3)
    expect(screen.getAllByText('Upbit').length).toBeGreaterThan(0)
    expect(screen.getByText('장부 확정')).toBeInTheDocument()
    expect(screen.getAllByText('평가 완료').length).toBeGreaterThan(0)
    expect(screen.getAllByText('들어옴').length).toBeGreaterThan(0)
    expect(screen.getAllByText('나감').length).toBeGreaterThan(0)
    expect(screen.getAllByText('매수·매도·입출금의 본체가 되는 자산 변동')).toHaveLength(2)
    expect(screen.getByText('거래소나 서비스에 지불한 처리 비용')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '당시 취득·처분 금액' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '평균 단가' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '세무 취득원가' })).toBeInTheDocument()
    expect(screen.getByText('2,701,901.16 KRW')).toBeInTheDocument()
    expect(screen.getByText('1,500 KRW / USDT')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '거래 처리 계보' })).not.toBeInTheDocument()
    expect(screen.queryByText(/원시값/)).not.toBeInTheDocument()
    const rawQuantity = screen.getByText('원본 수량')
    expect(rawQuantity.closest('details')).not.toHaveAttribute('open')
  })

  it('explains pending tax basis for a pre-2027 digital-asset acquisition', async () => {
    const airdropEvent = {
      ...ledgerEvent,
      eventId: 'airdrop-event',
      revisionId: 'airdrop-revision',
      eventType: 'REWARD',
      flowShape: 'INCOME',
      effectiveAt: '2025-11-05T13:23:07.000Z',
      postings: [{
        legId: 'airdrop-leg',
        accountId: 'account-upbit',
        assetId: 'asset-trust-upbit',
        occurredAt: '2025-11-05T13:23:07.000Z',
        direction: 'IN',
        quantity: '2500000000',
        role: 'PRINCIPAL',
        fairValue: '1397500000000',
        costBasis: '',
        denomination: 'asset-krw-upbit',
        assetSymbol: 'TRUST',
        assetDecimals: 8,
        hasAssetDecimals: true,
        assetVenue: 'upbit',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [airdropEvent] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /거래 상세 보기/ }))

    expect(screen.getByText('13,975 KRW')).toBeInTheDocument()
    expect(screen.getByText('559 KRW / TRUST')).toBeInTheDocument()
    expect(screen.getByText('산정 대기')).toBeInTheDocument()
    expect(screen.getByText('2026.12.31 기준 적용 예정')).toBeInTheDocument()
  })

  it('presents external transfers as deposits and withdrawals', async () => {
    const depositEvent = {
      ...ledgerEvent,
      eventId: 'deposit-event',
      revisionId: 'deposit-revision',
      eventType: 'TRANSFER',
      flowShape: 'EXTERNAL_IN',
      postings: [{
        legId: 'deposit-leg',
        accountId: 'account-upbit',
        assetId: 'cex-document-asset:upbit:decimal8:krw',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'IN',
        quantity: '100000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
        assetSymbol: 'KRW',
        assetDecimals: 8,
        hasAssetDecimals: true,
        assetVenue: 'upbit',
      }],
      transferEndpoint: {
        resolution: 'EXTERNAL_KNOWN',
        kind: 'WALLET_ADDRESS',
        display: '0x123456…abcdef',
        addressFamily: 'EVM',
        walletSourceId: '',
        chainCandidates: ['eip155:10'],
        connectionStatus: 'COUNTERPARTY_REVIEW_REQUIRED',
        reviewRequired: true,
      },
    }
    const withdrawalEvent = {
      ...depositEvent,
      eventId: 'withdrawal-event',
      revisionId: 'withdrawal-revision',
      flowShape: 'EXTERNAL_OUT',
      postings: [{
        ...depositEvent.postings[0],
        legId: 'withdrawal-leg',
        direction: 'OUT',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [depositEvent, withdrawalEvent] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect((await screen.findAllByText('입금')).length).toBeGreaterThan(0)
    expect(screen.getByText('출금')).toBeInTheDocument()
    expect(screen.queryByText('전송')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '입금 거래 상세 보기' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '출금 거래 상세 보기' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '입금 거래 상세 보기' }))

    expect(screen.getByText('보낸 곳')).toBeInTheDocument()
    expect(screen.getByText('외부 지갑')).toBeInTheDocument()
    expect(screen.getByText('거래 목적 확인 필요')).toBeInTheDocument()
  })

  it('renders normalized Upbit postings with decimal quantities, source, and action tones', async () => {
    const depositEvent = {
      ...ledgerEvent,
      eventId: 'normalized-deposit',
      revisionId: 'normalized-deposit-revision',
      eventType: 'TRANSFER',
      flowShape: 'UNKNOWN',
      resolution: 'PARTIAL',
      postings: [{
        legId: 'normalized-leg',
        accountId: 'cex-account:upbit:acb59c011f',
        assetId: 'asset-krw-upbit',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'IN',
        quantity: '298100000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
        assetSymbol: 'KRW',
        assetDecimals: 8,
        hasAssetDecimals: true,
        assetVenue: 'upbit',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [depositEvent] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect(await screen.findByText('2,981 KRW')).toBeInTheDocument()
    expect(screen.getByText('Upbit')).toBeInTheDocument()
    expect(screen.queryByText(/raw units/)).not.toBeInTheDocument()
    expect(screen.queryByText('출처 확인 중')).not.toBeInTheDocument()
    expect(screen.getByText('입금').closest('.ledger-explorer__action')).toHaveAttribute('data-action', '입금')
  })

  it('shows a registered counterpart as a pending owned-wallet movement', async () => {
    const ownedTransfer = {
      ...ledgerEvent,
      eventId: 'owned-transfer-event',
      revisionId: 'owned-transfer-revision',
      eventType: 'TRANSFER',
      flowShape: 'SELF_TRANSFER',
      postings: [{
        legId: 'owned-transfer-leg',
        accountId: 'account-upbit',
        assetId: 'cex-document-asset:upbit:decimal8:usdt',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'IN',
        quantity: '100000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
      }],
      transferEndpoint: {
        resolution: 'OWNED_REGISTERED',
        kind: 'WALLET_ADDRESS',
        display: '0x123456…abcdef',
        addressFamily: 'EVM',
        walletSourceId: 'wallet-source-1',
        chainCandidates: ['eip155:10'],
        connectionStatus: 'WALLET_OBSERVATION_PENDING',
        reviewRequired: true,
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [ownedTransfer] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect((await screen.findAllByText('내 계정 이동')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '내 계정 이동 거래 상세 보기' }))

    expect(screen.getByText('보낸 곳')).toBeInTheDocument()
    expect(screen.getByText('내 등록 지갑')).toBeInTheDocument()
    expect(screen.getByText('반대편 지갑 장부 확인 대기')).toBeInTheDocument()
  })

  it('shows wallet postings without an intermediate processing step bar', async () => {
    const walletEvent = {
      ...ledgerEvent,
      eventType: 'SWAP',
      flowShape: 'EXCHANGE',
      postings: [{
        legId: 'leg-native',
        accountId: 'wallet-1',
        assetId: 'asset:eip155:10:native',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'OUT',
        quantity: '200000000000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [walletEvent] })
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect((await screen.findAllByText('Optimism')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /거래 상세 보기/ }))

    expect(screen.queryByRole('list', { name: '거래 처리 계보' })).not.toBeInTheDocument()
    expect(screen.queryByText('ActionProof')).not.toBeInTheDocument()
    expect(screen.queryByText('거래소 자료 해석')).not.toBeInTheDocument()
    expect(screen.getByText('장부 확정')).toBeInTheDocument()
    expect(screen.getAllByText('0.0002 ETH')).toHaveLength(2)
  })

  it('shows the real empty state when the API has no events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))
    render(<LedgerPage />)
    const emptyHeading = await screen.findByRole('heading', {
      name: '아직 처리된 거래가 없습니다',
    })
    expect(emptyHeading.closest('section')).toHaveClass(
      'ledger-state-card',
      'ledger-state-card--empty',
    )
    expect(screen.getByRole('button', { name: '전체 거래 0건' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 필요 0건' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/ledger?taxYear=${defaultAppYear()}`),
      expect.anything(),
    )
  })

  it('uses and updates the shared browser year preference', async () => {
    window.localStorage.setItem(
      appPreferencesStorageKey,
      JSON.stringify({ currency: 'KRW', year: '2025' }),
    )
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))

    render(<LedgerPage />)

    const period = screen.getByRole('combobox', { name: '조회 기간' })
    expect(period).toHaveValue('2025')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ledger?taxYear=2025'),
        expect.anything(),
      ),
    )

    fireEvent.change(period, { target: { value: '2026' } })

    expect(loadAppPreferences().year).toBe('2026')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ledger?taxYear=2026'),
        expect.anything(),
      ),
    )
  })

  it('does not present unknown counts as zero while data is loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    render(<LedgerPage />)

    expect(screen.getByRole('button', { name: '전체 거래 —' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 필요 —' })).toBeInTheDocument()
  })

  it('keeps a healthy ledger visible when the Review list fails', async () => {
    let reviewListReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [ledgerEvent] })
      if (url.endsWith('/reviews')) {
        reviewListReads++
        if (reviewListReads > 1) return jsonResponse({ items: [reviewSummary] })
        return jsonResponse({ error: { code: 'ENGINE_UNAVAILABLE', message: 'review unavailable' } }, 503)
      }
      if (url.endsWith('/reviews/review-1')) return jsonResponse({ review: reviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    const ledgerDetailButton = await screen.findByRole('button', { name: '거래 거래 상세 보기' })
    expect(ledgerDetailButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(ledgerDetailButton)
    expect(screen.getByText('event-2027')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '검토 필요 —' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('검토 목록을 불러오지 못했습니다')
    fireEvent.click(screen.getByRole('button', { name: '검토 다시 불러오기' }))
    expect(await screen.findByRole('button', { name: /거래 유형 확인 필요/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '전체 거래 1건' }))
    expect(screen.getByText('event-2027')).toBeInTheDocument()
  })

  it('keeps a healthy Review surface usable when the ledger fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) {
        return jsonResponse({ error: { code: 'ENGINE_UNAVAILABLE', message: 'ledger unavailable' } }, 503)
      }
      if (url.endsWith('/reviews') && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    const ledgerError = await screen.findByRole('alert')
    expect(ledgerError).toHaveClass(
      'ledger-state-card',
      'ledger-state-card--error',
    )
    expect(ledgerError).toHaveTextContent('장부를 불러오지 못했습니다')

    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    expect(await screen.findByRole('heading', { name: '거래 유형 확인 필요' })).toBeInTheDocument()
    expect(screen.queryByText('장부를 불러오지 못했습니다')).not.toBeInTheDocument()
  })

  it('retries the ledger request from the neutral error card', async () => {
    let ledgerReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) {
        ledgerReads++
        if (ledgerReads === 1) {
          return jsonResponse({
            error: { code: 'ENGINE_UNAVAILABLE', message: 'ledger unavailable' },
          }, 503)
        }
        return jsonResponse({ items: [ledgerEvent] })
      }
      if (url.endsWith('/reviews')) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    const errorCard = await screen.findByRole('alert')
    expect(errorCard).toHaveClass('ledger-state-card', 'ledger-state-card--error')
    expect(errorCard).toHaveTextContent('잠시 후 다시 시도해 주세요')
    fireEvent.click(screen.getByRole('button', { name: '장부 다시 불러오기' }))

    expect(
      await screen.findByRole('button', { name: '거래 거래 상세 보기' }),
    ).toBeInTheDocument()
    expect(ledgerReads).toBe(2)
  })

  it('changes only year-scoped ledger data while keeping reviews global', async () => {
    let resolveOldLedger: ((response: Response) => void) | undefined
    let reviewListReads = 0
    const oldLedger = new Promise<Response>((resolve) => { resolveOldLedger = resolve })
    const initialYear = defaultAppYear()
    const nextYear = initialYear === '2025' ? '2026' : '2025'
    const nextEvent = {
      ...ledgerEvent,
      eventId: `event-${nextYear}`,
      revisionId: `ledger-revision-${nextYear}`,
      effectiveAt: `${nextYear}-01-01T00:00:00.000Z`,
    }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(`/ledger?taxYear=${initialYear}`)) return oldLedger
      if (url.includes(`/ledger?taxYear=${nextYear}`)) return jsonResponse({ items: [nextEvent] })
      if (url.endsWith('/reviews') && !init?.method) {
        reviewListReads++
        return jsonResponse({ items: [secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-2') && !init?.method) {
        return jsonResponse({ review: secondReviewDetail })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        return jsonResponse({ review: reviewDetail })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.change(screen.getByLabelText('조회 기간'), { target: { value: nextYear } })

    const nextLedgerDetailButton = await screen.findByRole('button', { name: '거래 거래 상세 보기' })
    expect(nextLedgerDetailButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(nextLedgerDetailButton)
    expect(screen.getByText(`event-${nextYear}`)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    expect(await screen.findByRole('button', { name: /추가 정보 필요/ })).toBeInTheDocument()
    expect(
      screen.getByText(
        '검토 목록은 조회 연도와 관계없이 전체 기간의 열린 항목을 보여줍니다',
      ),
    ).toBeInTheDocument()

    resolveOldLedger?.(jsonResponse({ items: [ledgerEvent] }))
    fireEvent.click(screen.getByRole('button', { name: '전체 거래 1건' }))
    expect(screen.getByText(`event-${nextYear}`)).toBeInTheDocument()
    expect(screen.queryByText('event-2027')).not.toBeInTheDocument()
    expect(reviewListReads).toBe(1)
  })

  it('submits the current revision and shows durable resolution completion', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000099' })
    let resolutionBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') {
        resolutionBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return jsonResponse({
          review: {
            ...reviewDetail,
            revisionId: 'revision-2',
            revisionNumber: 2,
            pointerVersion: '4',
            status: 'RESOLVED',
            resolutionCode: 'PERSONAL',
          },
          replayed: false,
        }, 201)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    expect(await screen.findByRole('heading', { name: '거래 유형 확인 필요' })).toBeInTheDocument()
    expect(screen.getByText('1.25 ETH')).toBeInTheDocument()
    const reasonCode = screen.getByText('UNKNOWN_TRANSACTION')
    expect(reasonCode.closest('details')).not.toHaveAttribute('open')
    const nativeId = screen.getByText('0xabc123')
    expect(nativeId.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('ETH · eip155:1/slip44:60')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('판단 근거나 거래 맥락을 남겨 주세요.'), {
      target: { value: '사용자가 개인 거래로 확인' },
    })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))

    expect(await screen.findByText('검토가 완료되었습니다. (개인 거래)')).toBeInTheDocument()
    await waitFor(() => expect(resolutionBody).toMatchObject({
      expectedRevisionId: 'revision-1',
      expectedPointerVersion: '3',
      resolutionCode: 'PERSONAL',
      resolutionNote: '사용자가 개인 거래로 확인',
      intentKey: '00000000-0000-4000-8000-000000000099',
    }))
  })

  it('loads every open review through the opaque next cursor', async () => {
    const reviewRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [reviewSummary], nextCursor: 'page-2' })
      }
      if (url.endsWith('/reviews?cursor=page-2') && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        return jsonResponse({ review: reviewDetail })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    fireEvent.click(await screen.findByRole('button', { name: '검토 더 보기' }))

    expect(await screen.findByRole('button', { name: /추가 정보 필요/ })).toBeInTheDocument()
    expect(reviewRequests).toHaveLength(2)
  })

  it('reloads the latest review and asks for confirmation after a stale CAS', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000100' })
    let detailReads = 0
    let resolutionPosts = 0
    let completeReload: ((response: Response) => void) | undefined
    const pendingReload = new Promise<Response>((resolve) => {
      completeReload = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        detailReads++
        if (detailReads === 1) return jsonResponse({ review: reviewDetail })
        return pendingReload
      }
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') {
        resolutionPosts++
        return jsonResponse({ error: { code: 'REVIEW_STALE', message: 'stale' } }, 409)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    await screen.findByRole('heading', { name: '거래 유형 확인 필요' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))

    const refreshButton = await screen.findByRole('button', { name: '최신 응답 불러오는 중…' })
    expect(refreshButton).toBeDisabled()
    fireEvent.click(refreshButton)
    expect(resolutionPosts).toBe(1)
    completeReload?.(jsonResponse({ review: {
      ...reviewDetail,
      revisionId: 'revision-new',
      pointerVersion: '4',
    } }))

    expect(await screen.findByRole('alert')).toHaveTextContent('최신 내용을 다시 불러왔습니다')
    expect(screen.getByText(/1번 · revision-new/)).toBeInTheDocument()
    expect(detailReads).toBe(2)
  })

  it('does not replace a newly selected review with an older submission response', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000101' })
    let completeResolution: ((response: Response) => void) | undefined
    const pendingResolution = new Promise<Response>((resolve) => {
      completeResolution = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) {
        return jsonResponse({ items: [reviewSummary, secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-2') && !init?.method) return jsonResponse({ review: secondReviewDetail })
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') return pendingResolution
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 2건' }))
    await screen.findByRole('heading', { name: '거래 유형 확인 필요' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /추가 정보 필요/ }))
    expect(await screen.findByRole('heading', { name: '추가 정보 필요' })).toBeInTheDocument()

    completeResolution?.(jsonResponse({
      review: {
        ...reviewDetail,
        revisionId: 'revision-2',
        revisionNumber: 2,
        pointerVersion: '4',
        status: 'RESOLVED',
        resolutionCode: 'PERSONAL',
      },
      replayed: false,
    }, 201))

    await waitFor(() => expect(screen.getByText('review-2')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: '추가 정보 필요' })).toBeInTheDocument()
    expect(screen.queryByText('review-1')).not.toBeInTheDocument()
  })

  it('does not apply an old response after selecting the same review again', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000104' })
    let firstReviewReads = 0
    let completeResolution: ((response: Response) => void) | undefined
    const pendingResolution = new Promise<Response>((resolve) => {
      completeResolution = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) {
        return jsonResponse({ items: [reviewSummary, secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        firstReviewReads++
        return jsonResponse({ review: firstReviewReads === 1 ? reviewDetail : {
          ...reviewDetail,
          revisionId: 'revision-a2',
          pointerVersion: '4',
        } })
      }
      if (url.endsWith('/reviews/review-2') && !init?.method) {
        return jsonResponse({ review: secondReviewDetail })
      }
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') {
        return pendingResolution
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 2건' }))
    await screen.findByRole('heading', { name: '거래 유형 확인 필요' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /추가 정보 필요/ }))
    await screen.findByRole('heading', { name: '추가 정보 필요' })
    fireEvent.click(screen.getByRole('button', { name: /거래 유형 확인 필요/ }))
    expect(await screen.findByText(/1번 · revision-a2/)).toBeInTheDocument()

    completeResolution?.(jsonResponse({
      review: {
        ...reviewDetail,
        revisionId: 'revision-old-response',
        revisionNumber: 2,
        pointerVersion: '4',
        status: 'RESOLVED',
        resolutionCode: 'PERSONAL',
      },
      replayed: false,
    }, 201))

    await waitFor(() => expect(screen.getByText(/1번 · revision-a2/)).toBeInTheDocument())
    expect(screen.queryByText(/revision-old-response/)).not.toBeInTheDocument()
  })

  it('creates a new intent key after the user edits a failed resolution', async () => {
    const intentKeys = [
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ]
    vi.stubGlobal('crypto', { randomUUID: () => intentKeys.shift() })
    const resolutionBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (url.endsWith('/reviews') && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') {
        resolutionBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        if (resolutionBodies.length === 1) {
          return jsonResponse({ error: { code: 'ENGINE_UNAVAILABLE', message: 'retry' } }, 503)
        }
        return jsonResponse({
          review: {
            ...reviewDetail,
            revisionId: 'revision-2',
            revisionNumber: 2,
            pointerVersion: '4',
            status: 'RESOLVED',
            resolutionCode: 'PERSONAL',
          },
          replayed: false,
        }, 201)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    await screen.findByRole('heading', { name: '거래 유형 확인 필요' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 요청으로 다시 시도')

    fireEvent.change(screen.getByPlaceholderText('판단 근거나 거래 맥락을 남겨 주세요.'), {
      target: { value: '응답 내용을 수정함' },
    })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))

    await waitFor(() => expect(resolutionBodies).toHaveLength(2))
    expect(resolutionBodies.map((body) => body.intentKey)).toEqual([
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ])
  })
})
