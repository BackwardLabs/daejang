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
export const loadReviews = (signal?: AbortSignal) =>
  requestApi<{ items: ReviewModel[] }>('/reviews', { signal })
export const loadReports = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ items: ReportModel[] }>(`/reports?taxYear=${taxYear}`, { signal })
export const createReport = (taxYear: string) => requestApi<{ report: ReportModel }>('/reports', {
  method: 'POST', body: JSON.stringify({ taxYear: Number(taxYear), intentKey: crypto.randomUUID() }),
})

