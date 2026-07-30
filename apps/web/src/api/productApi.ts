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
  resolution: string
  interpretationSupport: string
  effectiveAt: string
  postings: LedgerPostingModel[]
  transferEndpoint?: LedgerTransferEndpointModel
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

export const loadDashboard = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ dashboard: DashboardModel }>(`/dashboard?taxYear=${taxYear}`, { signal })
export const loadLedger = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ items: LedgerEventModel[] }>(`/ledger?taxYear=${taxYear}`, { signal })
export const loadActivities = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ items: LedgerEventModel[] }>(`/activities?taxYear=${taxYear}`, { signal })
export const loadReviews = (options: { cursor?: string; signal?: AbortSignal } = {}) => {
  const query = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''
  return requestApi<{ items: ReviewModel[]; nextCursor?: string }>(`/reviews${query}`, {
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
