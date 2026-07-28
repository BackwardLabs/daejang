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

export type CurrentTaxReport = {
  reportId: string
  taxYear: number
  finality: 'FINAL' | 'PROVISIONAL'
  status: 'FINAL' | 'PARTIAL'
  filingStatus: 'READY' | 'BLOCKED'
  denominationAssetId: string
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
