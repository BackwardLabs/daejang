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

export type TaxReportRateModel = {
  denominator: string
  numerator: string
}

export type TaxReportCalculationRuleModel = {
  basisAllocationRounding:
    | ''
    | 'FLOOR_EXCEPT_EXHAUSTED_LAYER'
    | 'CUMULATIVE_FLOOR_ANNUAL_POOL'
    | 'MIXED'
  basicDeductionAmount: string
  costMethods: Array<'MOVING_AVERAGE' | 'FIFO' | 'ANNUAL_TOTAL_AVERAGE'>
  deductionUsedAmount?: string | null
  localRate: TaxReportRateModel
  nationalRate: TaxReportRateModel
  poolScope: 'ADDRESS' | 'RESIDENT_TAX_YEAR_TAX_ASSET'
  taxRounding: 'FLOOR'
}

export type TaxEvidenceCoordinateModel = {
  eventId: string | null
  fragmentId: string | null
  generationId: string | null
  kind: string
  legId: string | null
  movementId: string | null
  observationId: string | null
  relationId: string | null
  reviewId: string | null
  reviewRevisionId: string | null
  revisionId: string | null
  schemaDigest: string | null
  valuationId: string | null
}

export type TaxEvidencePackModel = {
  artifactDigest: string
  artifactRoots: Array<{
    digest: string
    kind: string
  }>
  evidenceCoordinates: TaxEvidenceCoordinateModel[]
  issuedAt: string
  manifestId: string
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
  schemaVersion: 'giwa.tax-evidence-pack.v1'
  taxYear: number
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
  assetSummaries: Array<{
    acquisitionCost: TaxReportDetailAmountModel
    ancillaryExpense: TaxReportDetailAmountModel
    disposalCount: number
    gainLoss: TaxReportDetailAmountModel
    grossProceeds: TaxReportDetailAmountModel
    quantity: string
    taxAssetId: string
  }>
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
    calculationContract: 'ANNUAL_TOTAL_AVERAGE' | 'LEGACY' | 'UNSUPPORTED'
    calculationRule: TaxReportCalculationRuleModel | null
    gainLoss: TaxReportDetailAmountModel
    localTax: TaxReportDetailAmountModel
    nationalTax: TaxReportDetailAmountModel
    taxableBase: TaxReportDetailAmountModel
    totalTax: TaxReportDetailAmountModel
  }
  taxYear: number
  taxYearCloseStatus: 'CLOSED' | 'UNVERIFIED'
  totals: {
    acquisitionCost: TaxReportDetailAmountModel
    ancillaryExpense: TaxReportDetailAmountModel
    gainLoss: TaxReportDetailAmountModel
    grossProceeds: TaxReportDetailAmountModel
  }
  transfers: TaxReportTransferModel[]
}

export const loadCurrentTaxReport = (
  taxYear: string,
  finality: 'FINAL' | 'PROVISIONAL',
  signal?: AbortSignal,
) =>
  requestApi<{ report: TaxReportModel }>(
    `/tax-reports/${encodeURIComponent(taxYear)}/current?finality=${finality}`,
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

export const loadTaxReportEvidence = (
  reportId: string,
  signal?: AbortSignal,
) => requestApi<{ evidencePack: TaxEvidencePackModel }>(
  `/tax-reports/${encodeURIComponent(reportId)}/evidence`,
  { signal },
)
