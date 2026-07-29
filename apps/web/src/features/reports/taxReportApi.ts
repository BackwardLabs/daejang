import { requestApi } from '../../api/client.ts'

export type TaxAmountModel = {
  amount?: string
  hasAmount: boolean
  status: 'KNOWN' | 'UNKNOWN'
}

export type TaxReportModel = {
  counts: {
    disposals: number
    excludedConversions: number
    limitations: number
    transfers: number
  }
  denominationAssetId: string
  filingStatus: 'BLOCKED' | 'READY'
  finality: 'FINAL' | 'PROVISIONAL'
  gainLoss: TaxAmountModel
  issuedAt: string
  localTax: TaxAmountModel
  nationalTax: TaxAmountModel
  pointerVersion: number | string
  reportId: string
  status: 'FINAL' | 'PARTIAL'
  taxYear: number
  taxableBase: TaxAmountModel
  totalTax: TaxAmountModel
  updatedAt?: string
}

export const loadCurrentTaxReport = (taxYear: string, signal?: AbortSignal) =>
  requestApi<{ report: TaxReportModel }>(
    `/tax-reports/${encodeURIComponent(taxYear)}/current`,
    { signal },
  )

export const loadTaxReportHistory = (
  taxYear: string,
  signal?: AbortSignal,
) => requestApi<{ items: TaxReportModel[] }>(
  `/tax-reports/${encodeURIComponent(taxYear)}/history?limit=20`,
  { signal },
)
