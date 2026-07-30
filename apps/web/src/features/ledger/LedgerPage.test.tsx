import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LedgerPage', () => {
  it('formats canonical integer quantities without losing precision', () => {
    expect(formatReviewQuantity('1250000000000000000', 18)).toBe('1.25')
    expect(formatReviewQuantity('9007199254740993')).toBe('9007199254740993 raw units')
    expect(formatReviewQuantity('-1', 18)).toBe('-0.000000000000000001')
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
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/ledger?taxYear=2027'), expect.anything())
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
    expect(await screen.findByText('event-2027')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '검토 필요 —' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('검토 목록을 불러오지 못했습니다')
    fireEvent.click(screen.getByRole('button', { name: '검토 다시 불러오기' }))
    expect(await screen.findByRole('button', { name: /UNKNOWN_TRANSACTION/ })).toBeInTheDocument()

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
    expect(await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })).toBeInTheDocument()
    expect(screen.queryByText('장부를 불러오지 못했습니다')).not.toBeInTheDocument()
  })

  it('ignores stale ledger and Review responses after the year changes', async () => {
    let resolveOldLedger: ((response: Response) => void) | undefined
    let resolveOldReviews: ((response: Response) => void) | undefined
    let reviewListReads = 0
    const oldLedger = new Promise<Response>((resolve) => { resolveOldLedger = resolve })
    const oldReviews = new Promise<Response>((resolve) => { resolveOldReviews = resolve })
    const event2026 = {
      ...ledgerEvent,
      eventId: 'event-2026',
      revisionId: 'ledger-revision-2026',
      effectiveAt: '2026-01-01T00:00:00.000Z',
    }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/ledger?taxYear=2027')) return oldLedger
      if (url.includes('/ledger?taxYear=2026')) return jsonResponse({ items: [event2026] })
      if (url.endsWith('/reviews') && !init?.method) {
        reviewListReads++
        return reviewListReads === 1 ? oldReviews : jsonResponse({ items: [secondReviewSummary] })
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
    fireEvent.change(screen.getByLabelText('조회 기간'), { target: { value: '2026' } })

    expect(await screen.findByText('event-2026')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '검토 필요 1건' }))
    expect(await screen.findByRole('button', { name: /NEEDS_CONTEXT/ })).toBeInTheDocument()

    resolveOldLedger?.(jsonResponse({ items: [ledgerEvent] }))
    resolveOldReviews?.(jsonResponse({ items: [reviewSummary] }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /UNKNOWN_TRANSACTION/ })).not.toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '전체 거래 1건' }))
    expect(screen.getByText('event-2026')).toBeInTheDocument()
    expect(screen.queryByText('event-2027')).not.toBeInTheDocument()
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
    expect(await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })).toBeInTheDocument()
    expect(screen.getByText('0xabc123')).toBeInTheDocument()
    expect(screen.getByText('1.25 ETH')).toBeInTheDocument()
    expect(screen.getByText('ETH · eip155:1/slip44:60')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('판단 근거나 거래 맥락을 남겨 주세요.'), {
      target: { value: '사용자가 개인 거래로 확인' },
    })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))

    expect(await screen.findByText('응답 revision과 발행 대기열 저장이 완료되었습니다. (PERSONAL)')).toBeInTheDocument()
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

    expect(await screen.findByRole('button', { name: /NEEDS_CONTEXT/ })).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })
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

    expect(await screen.findByRole('alert')).toHaveTextContent('최신 revision을 다시 불러왔습니다')
    expect(screen.getByText(/rev\.1 · revision-new/)).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /NEEDS_CONTEXT/ }))
    expect(await screen.findByRole('heading', { name: 'NEEDS_CONTEXT' })).toBeInTheDocument()

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
    expect(screen.getByRole('heading', { name: 'NEEDS_CONTEXT' })).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })
    fireEvent.click(screen.getByRole('button', { name: '이 응답으로 검토 완료' }))
    fireEvent.click(screen.getByRole('button', { name: /NEEDS_CONTEXT/ }))
    await screen.findByRole('heading', { name: 'NEEDS_CONTEXT' })
    fireEvent.click(screen.getByRole('button', { name: /UNKNOWN_TRANSACTION/ }))
    expect(await screen.findByText(/rev\.1 · revision-a2/)).toBeInTheDocument()

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

    await waitFor(() => expect(screen.getByText(/rev\.1 · revision-a2/)).toBeInTheDocument())
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
    await screen.findByRole('heading', { name: 'UNKNOWN_TRANSACTION' })
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
