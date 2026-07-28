export type TaxAmount = {
  status: 'KNOWN' | 'UNKNOWN'
  amount?: string
}

export type TaxReportCounts = {
  disposals: number
  transfers: number
  excludedConversions: number
  limitations: number
}

export type TaxDisposal = {
  movementId: string
  eventId: string
  revisionId: string
  legId: string
  taxAddressId: string
  taxAssetId: string
  ledgerAssetId: string
  quantity: string
  grossProceeds: TaxAmount
  ancillaryExpense: TaxAmount
  basis: TaxAmount
  gainLoss: TaxAmount
  valuationId?: string
  costMethod: string
  rounding?: string
}

export type TaxTransfer = {
  movementId: string
  eventId: string
  revisionId: string
  fromLegId: string
  toLegId: string
  fromAddressId: string
  toAddressId: string
  taxAssetId: string
  quantity: string
  basis: TaxAmount
  fromCostMethod: string
  toCostMethod: string
}

export type ExcludedTaxConversion = {
  eventId: string
  revisionId: string
  relationId: string
  taxAddressId: string
  taxAssetId: string
  fromLegId: string
  toLegId: string
  fromQuantity: string
  toQuantity: string
}

export type TaxLimitation = {
  code: string
  taxAddressId?: string
  taxAssetId?: string
  movementId?: string
  reason: string
}

export type CurrentTaxReport = {
  schemaVersion: 'giwa.web.tax-report.v1'
  reportId: string
  residentId: string
  taxYear: number
  finality: 'FINAL' | 'PROVISIONAL'
  status: 'FINAL' | 'PARTIAL'
  filingStatus: 'READY' | 'BLOCKED'
  taxInventoryRunId: string
  taxEstimateId: string
  lotRunId: string
  inputDigest: string
  schemaDigest: string
  denominationAssetId: string
  reportArtifactDigest: string
  evidencePackDigest: string
  pointerVersion: number
  issuedAt: string
  counts: TaxReportCounts
  summary: {
    gainLoss: TaxAmount
    taxableBase: TaxAmount
    nationalTax: TaxAmount
    localTax: TaxAmount
    totalTax: TaxAmount
  }
  disposals: TaxDisposal[]
  transfers: TaxTransfer[]
  excludedConversions: ExcludedTaxConversion[]
  limitations: TaxLimitation[]
}

export type TaxReportFinality = CurrentTaxReport['finality']

export interface TaxReportReader {
  readonly durable: boolean
  getCurrent(
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ): Promise<CurrentTaxReport | undefined>
}
