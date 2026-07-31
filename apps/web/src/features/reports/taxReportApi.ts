import { requestApi } from '../../api/client.ts'

export type TaxAmountModel =
  | {
      amount: string
      hasAmount: true
      status: 'KNOWN'
    }
  | {
      amount?: null
      hasAmount: false
      status: 'UNKNOWN'
    }

export type TaxReportDetailAmountModel =
  | Extract<TaxAmountModel, { status: 'KNOWN' }>
  | {
      amount: null
      hasAmount: false
      status: 'UNKNOWN'
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

export type TaxReportProducerModel = {
  artifactDigest: string
  name: string
  version: string
}

export type TaxReportDisposalModel = {
  ancillaryExpense: TaxReportDetailAmountModel
  basis: TaxReportDetailAmountModel
  costMethod: string
  eventId: string
  gainLoss: TaxReportDetailAmountModel
  grossProceeds: TaxReportDetailAmountModel
  ledgerAssetId: string
  legId: string
  movementId: string
  quantity: string
  revisionId: string
  rounding: string | null
  taxAddressId: string
  taxAssetId: string
  valuationId: string | null
}

export type TaxReportTransferModel = {
  basis: TaxReportDetailAmountModel
  eventId: string
  fromAddressId: string
  fromCostMethod: string
  fromLegId: string
  movementId: string
  quantity: string
  revisionId: string
  taxAssetId: string
  toAddressId: string
  toCostMethod: string
  toLegId: string
}

export type TaxReportExcludedConversionModel = {
  eventId: string
  fromLegId: string
  fromQuantity: string
  relationId: string
  revisionId: string
  taxAddressId: string
  taxAssetId: string
  toLegId: string
  toQuantity: string
}

export type TaxReportLimitationModel = {
  code: string
  movementId: string | null
  reason: string
  reviewId: string | null
  reviewRevisionId: string | null
  taxAddressId: string | null
  taxAssetId: string | null
}

export type TaxReportDetailModel = {
  counts: TaxReportModel['counts']
  denominationAssetId: string
  disposals: TaxReportDisposalModel[]
  evidencePackDigest: string
  excludedConversions: TaxReportExcludedConversionModel[]
  filingStatus: TaxReportModel['filingStatus']
  finality: TaxReportModel['finality']
  inputDigest: string
  issuedAt: string
  limitations: TaxReportLimitationModel[]
  methodology: {
    engine: TaxReportProducerModel
    generationId: string
    lotRunId: string
    policy: TaxReportProducerModel
    schemaDigest: string
    taxEstimateId: string
    taxInventoryRunId: string
  }
  reportId: string
  reportModelDigest: string
  schemaVersion: 'giwa.tax-report-model.v1'
  status: TaxReportModel['status']
  summary: {
    gainLoss: TaxReportDetailAmountModel
    localTax: TaxReportDetailAmountModel
    nationalTax: TaxReportDetailAmountModel
    taxableBase: TaxReportDetailAmountModel
    totalTax: TaxReportDetailAmountModel
  }
  taxYear: number
  transfers: TaxReportTransferModel[]
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

export const loadTaxReportDetail = (
  reportId: string,
  signal?: AbortSignal,
) => requestApi<{ report: TaxReportDetailModel }>(
  `/tax-reports/${encodeURIComponent(reportId)}`,
  { signal },
)
