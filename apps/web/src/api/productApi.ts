import { requestApi } from './client.ts'

export type DashboardModel = {
  sourceCount: number | string
  transactionCount: number | string
  openReviewCount: number | string
  completedCount: number | string
  exceptionCount: number | string
  lastSyncState: string
  lastSyncUpdatedAt?: string
}

export type LedgerPostingModel = {
  legId: string
  accountId: string
  accountKind?: string
  accountLocator?: string
  accountLabel?: string
  accountChainId?: string
  accountVenue?: string
  assetId: string
  occurredAt: string
  direction: string
  quantity: string
  role: string
  fairValue: string
  costBasis: string
  denomination: string
  assetSymbol?: string
  assetDecimals?: number
  hasAssetDecimals?: boolean
  assetVenue?: string
}

export type LedgerTransferEndpointModel = {
  resolution: string
  kind: string
  display: string
  addressFamily: string
  walletSourceId: string
  chainCandidates: string[]
  connectionStatus: string
  reviewRequired: boolean
}

export type LedgerEventModel = {
  eventId: string
  revisionId: string
  revisionNumber: number
  eventType: string
  flowShape: string
  subtype?: string
  resolution: string
  // 검토 워크플로 상태: OPEN | RESOLVED | 빈 값(검토 없음)
  reviewState?: string
  // 확정 시 검토자가 고른 선택지 (코드와 당시 화면 라벨)
  reviewResolutionCode?: string
  reviewResolutionLabel?: string
  interpretationSupport: string
  effectiveAt: string
  postings: LedgerPostingModel[]
  transferEndpoint?: LedgerTransferEndpointModel
  chainId?: string
  transactionHash?: string
  transactionCoordinate?: string
  actionProofId?: string
  actionProfileId?: string
  actionProfileVersion?: string
  actionBindingId?: string
  projectionKey?: string
  sourceEvents?: Array<{ eventId: string; revisionId: string }>
  projectedActions?: Array<{
    eventId: string
    eventType: string
    flowShape: string
    subtype?: string
    actionProofId: string
    actionProfileId?: string
    actionProfileVersion?: string
    actionBindingId?: string
  }>
}

export type ReviewModel = {
  id: string
  executionId: string
  revisionId: string
  pointerVersion: number | string
  status: string
  reasonCodes: string[]
  createdAt: string
}

export type ReviewOptionModel = {
  code: string
  label: string
  requiresEvidence: boolean
}

export type ReviewObservationModel = {
  fragmentId: string
  observationId: string
  ordinal: number
  domain: string
  kind: string
  nativeId: string
  occurredAt?: string
  accountLocator: string
  accountLabel: string
  accountChainId: string
  assetSymbol: string
  assetLocator: string
  assetDecimals: number
  hasAssetDecimals: boolean
  quantity: string
  originKind: string
  originLinkId: string
}

export type ReviewDetailModel = ReviewModel & {
  revisionNumber: number
  inputDigest: string
  options: ReviewOptionModel[]
  observations: ReviewObservationModel[]
  revisionCreatedAt?: string
  resolutionCode?: string
  resolutionNote?: string
}

export type ReportModel = {
  id: string
  taxYear: number
  status: 'FINAL' | 'PARTIAL'
  inputDigest: string
  resultDigest: string
  schemaDigest: string
  transactionCount: number | string
  completeCount: number | string
  exceptionCount: number | string
  profitAmount: string
  denomination: string
  manifestDigest: string
  rowDigest: string
  issuedAt: string
}

export type LedgerLotLinkModel = {
  kind: string
  legId: string
  lotId: string
  quantity: string
  basisStatus: string
  basisAmount: string
  basisDenomination: string
  sourceEventId: string
  sourceLegId: string
  sourceOccurredAt?: string
  sourceQuantity: string
  remainingQuantity: string
}

export type LedgerLotLineageModel = {
  runId: string
  coverage: string
  links: LedgerLotLinkModel[]
}

export const loadDashboard = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ dashboard: DashboardModel }>(`/dashboard?taxYear=${taxYear}`, { signal })
export const loadLedger = (taxYear: string, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}) => {
  const cursor = options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''
  const limit = `&limit=${options.limit ?? 200}`
  return requestApi<{ items: LedgerEventModel[]; nextCursor?: string }>(
    `/ledger?taxYear=${taxYear}${limit}${cursor}`,
    { signal: options.signal },
  )
}

export async function loadAllLedger(
  taxYear: string,
  options: { signal?: AbortSignal } = {},
) {
  const items: LedgerEventModel[] = []
  const seenItems = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await loadLedger(taxYear, {
      ...(cursor ? { cursor } : {}),
      limit: 200,
      signal: options.signal,
    })
    for (const item of page.items) {
      const key = `${item.eventId}\u0000${item.revisionId}`
      if (!seenItems.has(key)) {
        seenItems.add(key)
        items.push(item)
      }
    }
    if (!page.nextCursor) return { items }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('장부 목록이 동일한 페이지를 반복해서 반환했습니다')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error('장부 목록의 페이지 수가 허용 범위를 초과했습니다')
}
export const loadActivities = (taxYear: string, options: { cursor?: string; signal?: AbortSignal } = {}) => {
  const cursor = options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''
  return requestApi<{ items: LedgerEventModel[]; nextCursor?: string }>(
    `/activities?taxYear=${taxYear}${cursor}`,
    { signal: options.signal },
  )
}
export const loadLedgerEventLots = (eventId: string, revisionId: string, signal?: AbortSignal) =>
  requestApi<LedgerLotLineageModel>(
    `/ledger/lots?eventId=${encodeURIComponent(eventId)}&revisionId=${encodeURIComponent(revisionId)}`,
    { signal },
  )
export const loadReviews = (taxYear: string, options: { cursor?: string; signal?: AbortSignal } = {}) => {
  const cursor = options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''
  return requestApi<{ items: ReviewModel[]; nextCursor?: string }>(`/reviews?taxYear=${taxYear}${cursor}`, {
    signal: options.signal,
  })
}
export const loadReview = (reviewId: string, signal?: AbortSignal) =>
  requestApi<{ review: ReviewDetailModel }>(`/reviews/${encodeURIComponent(reviewId)}`, { signal })
export const resolveReview = (reviewId: string, input: {
  expectedRevisionId: string
  expectedPointerVersion: string
  resolutionCode: string
  resolutionNote: string
  intentKey: string
}) => requestApi<{ review: ReviewDetailModel; replayed: boolean }>(
  `/reviews/${encodeURIComponent(reviewId)}/resolutions`,
  { method: 'POST', body: JSON.stringify(input) },
)
export const loadReports = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ items: ReportModel[] }>(`/reports?taxYear=${taxYear}`, { signal })
export const createReport = (taxYear: string) => requestApi<{ report: ReportModel }>('/reports', {
  method: 'POST', body: JSON.stringify({ taxYear: Number(taxYear), intentKey: crypto.randomUUID() }),
})
