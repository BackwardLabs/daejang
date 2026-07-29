import type { KeyObject } from 'node:crypto'

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

export type ReportPaymentTaxReport = {
  report: CurrentTaxReport
  residentId: string
  reportArtifactDigest: string
}

export interface TaxReportReader {
  readonly durable: boolean
  getCurrent(
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ): Promise<CurrentTaxReport | undefined>
}

export interface ReportPaymentTaxReportReader {
  readonly durable: boolean
  getCurrentForPayment(
    subjectId: string,
    taxYear: number,
    finality: 'FINAL',
    residentId?: string,
  ): Promise<ReportPaymentTaxReport | undefined>
}
export type CorrectionQuarantineScope = {
  subjectId: string
  taxYear: number
  finality: TaxReportFinality
  residentId?: string
}

export type CorrectionQuarantinePayload = CorrectionQuarantineScope & {
  artifactVersion: 1
  status: 'PENDING' | 'RELEASED'
  candidateEpoch: number
  correctionEpoch: number
  expiresAt: string
  expectedCurrentPointerVersion: number
  finalCorrectionReceiptDigest?: string
  reportId: string
}

export type CorrectionCurrentPointerPayload = CorrectionQuarantineScope & {
  artifactVersion: 1
  candidateEpoch: number
  correctionEpoch: number
  pointerVersion: number
  finalCorrectionReceiptDigest?: string
  reportId: string
}

export type SignedCorrectionArtifact<T> = {
  keyId: string
  payload: T
  signature: string
}

export type CorrectionQuarantineSnapshot = {
  quarantine: SignedCorrectionArtifact<CorrectionQuarantinePayload>
  currentPointer: SignedCorrectionArtifact<CorrectionCurrentPointerPayload>
}

export interface CorrectionQuarantineStore {
  get(scope: CorrectionQuarantineScope): Promise<CorrectionQuarantineSnapshot | undefined>
}

export type CorrectionQuarantineTrust = {
  publicKeys: ReadonlyMap<string, string | Buffer | KeyObject>
  now?: () => Date
}
