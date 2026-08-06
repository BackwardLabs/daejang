import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAppYear } from '../../components/AppSidebar.tsx'
import {
  appPreferencesStorageKey,
  loadAppPreferences,
} from '../../preferences/appPreferences.ts'
import {
  formatReviewDisplayQuantity,
  formatReviewQuantity,
  LedgerPage,
} from './LedgerPage.tsx'

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const isReviewListRequest = (value: string, cursor?: string) => {
  const url = new URL(value, window.location.origin)
  return url.pathname.endsWith('/reviews') &&
    Boolean(url.searchParams.get('taxYear')) &&
    url.searchParams.get('cursor') === (cursor ?? null)
}

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

const dashboardResponse = (transactionCount: number, openReviewCount: number) => jsonResponse({
  dashboard: {
    sourceCount: 2,
    transactionCount,
    openReviewCount,
    completedCount: Math.max(transactionCount - openReviewCount, 0),
    exceptionCount: openReviewCount,
    lastSyncState: 'SUCCEEDED',
  },
})

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
    expect(formatReviewDisplayQuantity({
      ...reviewDetail.observations[0]!,
      domain: 'CEX',
      kind: 'WITHDRAWAL',
      assetSymbol: 'KRW',
      assetLocator: 'cex://upbit/document-asset/krw',
      assetDecimals: 0,
      hasAssetDecimals: false,
      quantity: '-5000000',
    })).toBe('-5,000,000 KRW')
  })

  it('identifies an Upbit withdrawal and formats its KRW amount for review', async () => {
    const cexReviewDetail = {
      ...reviewDetail,
      observations: [{
        ...reviewDetail.observations[0]!,
        domain: 'CEX',
        kind: 'WITHDRAWAL',
        nativeId: 'upbit-withdrawal-1',
        accountLocator: 'cex://upbit/account/primary',
        accountLabel: '',
        accountChainId: '',
        assetSymbol: 'KRW',
        assetLocator: 'cex://upbit/document-asset/krw',
        assetDecimals: 0,
        hasAssetDecimals: false,
        quantity: '-5000000',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: cexReviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))

    expect(await screen.findByRole('heading', { name: 'Upbit · 출금' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upbit · 출금/ })).toHaveTextContent('-5,000,000 KRW')
    expect(screen.getAllByText('-5,000,000 KRW')).toHaveLength(2)
    const rawQuantity = screen.getByText('-5000000')
    expect(rawQuantity.closest('details')).not.toHaveAttribute('open')
  })

  it('shows an explicit review preview error instead of an indefinite loading label', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        return jsonResponse({ error: { code: 'REVIEW_UNAVAILABLE' } }, 503)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))

    expect(await screen.findByText('원본 거래를 확인하지 못했습니다')).toBeInTheDocument()
    expect(screen.getByText('원본 조회 실패')).toBeInTheDocument()
    expect(screen.queryByText('거래 정보를 불러오는 중입니다')).not.toBeInTheDocument()
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect(await screen.findByText('표시 1건 · 장부 항목 3개')).toBeInTheDocument()
    expect(await screen.findAllByText('1,801.08722461 USDT')).toHaveLength(1)
    expect(screen.getAllByText('27.016 KRW')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: '자산 변동과 세무 입력' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '거래 거래 상세 보기' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: '거래 거래 상세 보기' }))

    expect(screen.getAllByText('1,801.08722461 USDT')).toHaveLength(2)
    expect(screen.getAllByText('27.016 KRW')).toHaveLength(3)
    expect(screen.getAllByText('Upbit · 소수점 8자리')).toHaveLength(3)
    expect(screen.getAllByText('Upbit').length).toBeGreaterThan(0)
    expect(screen.getByText('처리 완료')).toBeInTheDocument()
    expect(screen.getByLabelText(/처리 완료.*평가 완료/)).toBeInTheDocument()
    expect(screen.getAllByText('증가').length).toBeGreaterThan(0)
    expect(screen.getAllByText('감소').length).toBeGreaterThan(0)
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

  it('toggles the transaction detail from anywhere in the row, not only the toggle control', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [ledgerEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    const toggle = await screen.findByRole('button', { name: '거래 거래 상세 보기' })
    const rowTime = toggle.closest('tr')?.querySelector('time')
    if (!rowTime) throw new Error('ledger row time is missing')

    fireEvent.click(rowTime)

    expect(screen.getByRole('heading', { name: '자산 변동과 세무 입력' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '거래 거래 상세 접기' })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(rowTime)

    expect(screen.queryByRole('heading', { name: '자산 변동과 세무 입력' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '거래 거래 상세 보기' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the persisted lot lineage of a disposal without touching the tax basis column', async () => {
    const sellEvent = {
      ...ledgerEvent,
      eventId: 'sell-event',
      revisionId: 'sell-revision',
      postings: [{
        legId: 'leg-out',
        accountId: 'cex-account:upbit:1',
        assetId: 'cex-document-asset:upbit:decimal8:usdt',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'OUT',
        quantity: '90000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: 'asset-krw-upbit',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger/lots?')) return jsonResponse({
        runId: 'lot-run:1',
        coverage: 'PARTIAL',
        links: [{
          kind: 'DISPOSE', legId: 'leg-out', lotId: 'lot:1', quantity: '90000000',
          basisStatus: 'KNOWN', basisAmount: '152474700000000', basisDenomination: 'asset-krw-upbit',
          sourceEventId: 'buy-event', sourceLegId: 'leg-in',
          sourceOccurredAt: '2026-03-26T13:41:49.000Z', sourceQuantity: '100000000',
          remainingQuantity: '',
        }],
      })
      if (url.includes('/ledger?')) return jsonResponse({ items: [sellEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /거래 상세 보기/ }))

    expect(await screen.findByText('취득 1건에서 소진')).toBeInTheDocument()
    expect(screen.getByText('0.9 USDT 소진')).toBeInTheDocument()
    expect(screen.getByText(/취득 수량 1 USDT · Lot 전체 취득원가 1,524,747 KRW/)).toBeInTheDocument()
    expect(screen.getByText(/2026\..*취득분/)).toBeInTheDocument()
    expect(screen.queryByText('산정 대기')).not.toBeInTheDocument()
  })

  it('reports a missing lot run instead of inferring one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger/lots?')) return jsonResponse({ runId: '', coverage: '', links: [] })
      if (url.includes('/ledger?')) return jsonResponse({ items: [ledgerEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /거래 상세 보기/ }))

    expect(await screen.findByText('이 계정에는 아직 Lot 계보가 산출되지 않았습니다.')).toBeInTheDocument()
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
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

  it('shows the source transaction time on review cards instead of the review creation time', async () => {
    const sourceEvent = {
      ...ledgerEvent,
      eventId: reviewSummary.executionId,
      effectiveAt: '2025-09-26T00:13:26+09:00',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(1, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [sourceEvent] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))

    const reviewCard = screen.getByRole('button', { name: /거래 유형 확인 필요/ })
    expect(reviewCard).toHaveTextContent('2025')
    expect(reviewCard).not.toHaveTextContent('2027')
  })

  it('opens the matching review from a review-required ledger transfer across cursor pages', async () => {
    const transferEvent = {
      ...ledgerEvent,
      eventId: secondReviewSummary.executionId,
      revisionId: 'transfer-review-revision',
      eventType: 'TRANSFER',
      flowShape: 'EXTERNAL_OUT',
      resolution: 'PARTIAL',
      postings: [{
        legId: 'transfer-review-leg',
        accountId: 'account-upbit',
        assetId: 'cex-document-asset:upbit:decimal8:usdt',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'OUT',
        quantity: '180108722500',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
        assetSymbol: 'USDT',
        assetDecimals: 8,
        hasAssetDecimals: true,
        assetVenue: 'upbit',
      }],
      transferEndpoint: {
        resolution: 'UNKNOWN',
        kind: 'UNKNOWN',
        display: '',
        addressFamily: '',
        walletSourceId: '',
        chainCandidates: [],
        connectionStatus: 'COUNTERPARTY_REVIEW_REQUIRED',
        reviewRequired: true,
      },
    }
    const reviewRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [transferEvent] })
      if (isReviewListRequest(url) && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [reviewSummary], nextCursor: 'page-2' })
      }
      if (isReviewListRequest(url, 'page-2') && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-2') && !init?.method) return jsonResponse({ review: secondReviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '출금 거래 상세 보기' }))
    expect(screen.getByText('송신자·수신자 확인 필요')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '검토하러 가기' }))

    expect(await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })).toBeInTheDocument()
    expect(await screen.findByText(/1번 · revision-b1/)).toBeInTheDocument()
    expect(reviewRequests).toHaveLength(2)
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
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
        accountId: 'account:opaque-wallet',
        accountKind: 'WALLET',
        accountLocator: '0x16512376e2ea3c7b464cedeea3dce9b8a590fd80',
        accountChainId: 'eip155:10',
        assetId: 'asset:opaque-native',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'OUT',
        quantity: '200000000000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
        assetSymbol: 'ETH',
        assetDecimals: 18,
        hasAssetDecimals: true,
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [walletEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect((await screen.findAllByText('Optimism')).length).toBeGreaterThan(0)
    expect(screen.queryByText('출처 확인 중')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /거래 상세 보기/ }))

    expect(screen.queryByRole('list', { name: '거래 처리 계보' })).not.toBeInTheDocument()
    expect(screen.queryByText('ActionProof')).not.toBeInTheDocument()
    expect(screen.queryByText('거래소 자료 해석')).not.toBeInTheDocument()
    expect(screen.getByText('처리 완료')).toBeInTheDocument()
    expect(screen.getAllByText('0.0002 ETH')).toHaveLength(2)
  })

  it('filters ledger rows by CEX and EVM source while preserving transaction numbers', async () => {
    const cexEvent = {
      ...ledgerEvent,
      eventId: 'cex-event',
      revisionId: 'cex-revision',
      postings: [{
        legId: 'cex-leg',
        accountId: 'account-upbit',
        assetId: 'cex-document-asset:upbit:decimal8:krw',
        occurredAt: ledgerEvent.effectiveAt,
        direction: 'IN',
        quantity: '100000000',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
      }],
    }
    const walletEvent = {
      ...ledgerEvent,
      eventId: 'wallet-event',
      revisionId: 'wallet-revision',
      effectiveAt: '2027-01-02T00:00:00.000Z',
      postings: [{
        legId: 'wallet-leg',
        accountId: 'wallet-account',
        accountKind: 'WALLET',
        accountLocator: '0x1234',
        accountChainId: 'eip155:10',
        assetId: 'asset:eth',
        occurredAt: '2027-01-02T00:00:00.000Z',
        direction: 'IN',
        quantity: '1',
        role: 'PRINCIPAL',
        fairValue: '',
        costBasis: '',
        denomination: '',
        assetSymbol: 'ETH',
        assetDecimals: 18,
        hasAssetDecimals: true,
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: [walletEvent, cexEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect((await screen.findAllByText('Optimism')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Upbit').length).toBeGreaterThan(0)
    expect(screen.getByText('No. 1')).toBeInTheDocument()
    expect(screen.getByText('No. 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '거래소 · CEX' }))
    expect(screen.getAllByText('Upbit').length).toBeGreaterThan(0)
    expect(screen.queryByText('Optimism')).not.toBeInTheDocument()
    expect(screen.getByText('No. 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '지갑 · EVM' }))
    expect(screen.getAllByText('Optimism').length).toBeGreaterThan(0)
    expect(screen.queryByText('Upbit')).not.toBeInTheDocument()
    expect(screen.getByText('No. 1')).toBeInTheDocument()
  })

  it('paginates ledger rows from the header without rendering the old bottom control', async () => {
    const ledgerItems = Array.from({ length: 21 }, (_, index) => ({
      ...ledgerEvent,
      eventId: `event-${String(index + 1).padStart(2, '0')}`,
      revisionId: `revision-${String(index + 1).padStart(2, '0')}`,
      effectiveAt: `2027-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ledger?')) return jsonResponse({ items: ledgerItems })
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect(await screen.findByText('No. 1')).toBeInTheDocument()
    expect(screen.getByText('No. 20')).toBeInTheDocument()
    expect(screen.queryByText('No. 21')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '이전 거래 더 보기' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다음 거래 페이지' }))

    expect(screen.getByText('No. 21')).toBeInTheDocument()
    expect(screen.queryByText('No. 20')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '거래 페이지' })).toHaveTextContent('2 / 2')

    fireEvent.click(screen.getByRole('button', { name: '이전 거래 페이지' }))
    expect(screen.getByText('No. 1')).toBeInTheDocument()
  })

  it('shows the real empty state when the API has no events', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 0)
      return jsonResponse({ items: [] })
    }))
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

  it('shows selected-year totals instead of the first loaded page lengths', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(141, 37)
      if (url.includes('/ledger?')) return jsonResponse({ items: [ledgerEvent] })
      if (isReviewListRequest(url)) return jsonResponse({ items: [reviewSummary], nextCursor: 'review-page-2' })
      if (url.endsWith('/reviews/review-1')) return jsonResponse({ review: reviewDetail })
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)

    expect(await screen.findByRole('button', { name: '전체 거래 141건' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 필요 37건' })).toBeInTheDocument()
  })

  it('keeps a healthy ledger visible when the Review list fails', async () => {
    let reviewListReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(1, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [ledgerEvent] })
      if (isReviewListRequest(url)) {
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

    fireEvent.click(screen.getByRole('button', { name: '검토 필요 1건' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('검토 목록을 불러오지 못했습니다')
    fireEvent.click(screen.getByRole('button', { name: '검토 다시 불러오기' }))
    expect(await screen.findByRole('button', { name: /거래 유형 확인 필요/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '전체 거래 1건' }))
    expect(screen.getByText('event-2027')).toBeInTheDocument()
  })

  it('keeps a healthy Review surface usable when the ledger fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) {
        return jsonResponse({ error: { code: 'ENGINE_UNAVAILABLE', message: 'ledger unavailable' } }, 503)
      }
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
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
    expect(await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })).toBeInTheDocument()
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
      if (isReviewListRequest(url)) return jsonResponse({ items: [] })
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

  it('reloads both ledger rows and reviews for the selected year', async () => {
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
      if (url.includes('/dashboard?')) return dashboardResponse(1, 1)
      if (url.includes(`/ledger?taxYear=${initialYear}`)) return oldLedger
      if (url.includes(`/ledger?taxYear=${nextYear}`)) return jsonResponse({ items: [nextEvent] })
      if (isReviewListRequest(url) && !init?.method) {
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
        '선택한 연도에 발생한 검토 필요 거래를 보여줍니다',
      ),
    ).toBeInTheDocument()

    resolveOldLedger?.(jsonResponse({ items: [ledgerEvent] }))
    fireEvent.click(screen.getByRole('button', { name: '전체 거래 1건' }))
    expect(screen.getByText(`event-${nextYear}`)).toBeInTheDocument()
    expect(screen.queryByText('event-2027')).not.toBeInTheDocument()
    expect(reviewListReads).toBe(2)
  })

  it('submits the current revision and shows ledger application is still pending', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000099' })
    let resolutionBody: Record<string, unknown> | undefined
    let dashboardReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) {
        dashboardReads++
        return dashboardResponse(0, dashboardReads === 1 ? 1 : 0)
      }
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
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
    expect(await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })).toBeInTheDocument()
    expect(screen.getAllByText('1.25 ETH')).toHaveLength(2)
    const reasonCode = screen.getByText('UNKNOWN_TRANSACTION')
    expect(reasonCode.closest('details')).not.toHaveAttribute('open')
    const nativeId = screen.getByText('0xabc123')
    expect(nativeId.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('ETH · eip155:1/slip44:60')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('판단 근거나 거래 맥락을 남겨 주세요.'), {
      target: { value: '사용자가 개인 거래로 확인' },
    })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))

    expect(await screen.findByText('검토 응답 저장 완료 · 장부 반영 대기')).toBeInTheDocument()
    expect(screen.getByText('‘개인 거래’ 응답을 저장했습니다')).toBeInTheDocument()
    expect(screen.queryByText(/장부에 반영했습니다/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '열린 검토가 없습니다' })).toBeInTheDocument()
    expect(screen.queryByLabelText('검토 항목 목록')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /거래 유형 확인 필요/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '검토 필요 0건' })).toBeInTheDocument()
    expect(dashboardReads).toBe(2)
    await waitFor(() => expect(resolutionBody).toMatchObject({
      expectedRevisionId: 'revision-1',
      expectedPointerVersion: '3',
      resolutionCode: 'PERSONAL',
      resolutionNote: '사용자가 개인 거래로 확인',
      intentKey: '00000000-0000-4000-8000-000000000099',
    }))
  })

  it('keeps reviews loaded while a resolution request is still in flight', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000105' })
    let completeResolution: ((response: Response) => void) | undefined
    const pendingResolution = new Promise<Response>((resolve) => {
      completeResolution = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) {
        return jsonResponse({ items: [reviewSummary], nextCursor: 'page-2' })
      }
      if (isReviewListRequest(url, 'page-2') && !init?.method) {
        return jsonResponse({ items: [secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-2') && !init?.method) return jsonResponse({ review: secondReviewDetail })
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') return pendingResolution
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: '검토 더 보기' }))
    expect(await screen.findByRole('button', { name: /추가 정보 필요/ })).toBeInTheDocument()

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

    expect(await screen.findByText('검토 응답 저장 완료 · 장부 반영 대기')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /거래 유형 확인 필요/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /추가 정보 필요/ })).toBeInTheDocument()
    expect(await screen.findByText('review-2')).toBeInTheDocument()
  })

  it('loads every open review through the opaque next cursor', async () => {
    const reviewRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/dashboard?')) return dashboardResponse(0, 2)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [reviewSummary], nextCursor: 'page-2' })
      }
      if (isReviewListRequest(url, 'page-2') && !init?.method) {
        reviewRequests.push(url)
        return jsonResponse({ items: [secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) {
        return jsonResponse({ review: reviewDetail })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 2건' }))
    expect(screen.getByLabelText('검토 항목 목록')).toHaveAttribute('tabindex', '0')
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
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
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
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
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
      if (url.includes('/dashboard?')) return dashboardResponse(0, 2)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) {
        return jsonResponse({ items: [reviewSummary, secondReviewSummary] })
      }
      if (url.endsWith('/reviews/review-1') && !init?.method) return jsonResponse({ review: reviewDetail })
      if (url.endsWith('/reviews/review-2') && !init?.method) return jsonResponse({ review: secondReviewDetail })
      if (url.endsWith('/reviews/review-1/resolutions') && init?.method === 'POST') return pendingResolution
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<LedgerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 2건' }))
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /추가 정보 필요/ }))
    expect(await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })).toBeInTheDocument()

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
    expect(screen.getByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /거래 유형 확인 필요/ })).not.toBeInTheDocument()
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
      if (url.includes('/dashboard?')) return dashboardResponse(0, 2)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) {
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
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /추가 정보 필요/ }))
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
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
      if (url.includes('/dashboard?')) return dashboardResponse(0, 1)
      if (url.includes('/ledger?')) return jsonResponse({ items: [] })
      if (isReviewListRequest(url) && !init?.method) return jsonResponse({ items: [reviewSummary] })
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
    await screen.findByRole('heading', { name: 'Ethereum 지갑 · 자산 이동' })
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
