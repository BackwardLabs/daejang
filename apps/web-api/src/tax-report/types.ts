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

export type TaxReportGenerationState =
  | 'NOT_STARTED'
  | 'BUILDING'
  | 'ACTIVE'
  | 'REVIEW_REQUIRED'
  | 'FAILED'
  | 'SUPERSEDED'

export type TaxReportGenerationOutcome = 'REPORT' | 'NO_TAX_EVENTS'

export type TaxReportGenerationBlockedReason =
  | 'NOT_STARTED'
  | 'APPLICATION_PENDING'
  | 'GENERATION_BUILDING'
  | 'GENERATION_FAILED'
  | 'GENERATION_NOT_ACTIVE'
  | 'LEDGER_STALE'
  | 'SOURCE_COVERAGE_INVALID'
  | 'TAX_RESULT_STALE'
  | 'REVIEW_REQUIRED'
  | 'GENERATION_INCOMPLETE'
  | 'NO_TAX_EVENTS'
  | 'REPORT_NOT_CURRENT'

export type TaxReportCoverageStatus = 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'

export type TaxReportCoverageAssurance =
  | 'UNKNOWN'
  | 'USER_DECLARED'
  | 'DOCUMENT_METADATA_VERIFIED'
  | 'CHAIN_VERIFIED'

export type TaxReportSourceCoverageSnapshot = {
  fragmentId: string
  sourceArtifactId: string
  coverageOrdinal: number
  sourceKind: 'API' | 'FILE' | 'MANUAL' | 'OTHER'
  systemName: string
  declaredFrom: string | null
  declaredThrough: string | null
  completeness: TaxReportCoverageStatus
  assurance: TaxReportCoverageAssurance
}

export type TaxReportGenerationStatus = {
  generationId: string | null
  state: TaxReportGenerationState
  taxYear: 2025 | 2026 | 2027
  finality?: TaxReportFinality
  pointerVersion?: number
  outcome: TaxReportGenerationOutcome | null
  periodStart?: string
  periodEnd?: string
  coverageFrom?: string | null
  coverageThrough?: string | null
  calculatedAsOf?: string | null
  coverageStatus?: TaxReportCoverageStatus
  coverageAssurance?: TaxReportCoverageAssurance
  coverageDeclarationId?: string | null
  taxYearCloseStatus?: 'OPEN' | 'CLOSED'
  sourceCoverageIntervalCount?: number
  sourceCoverageSummaryStatus?: TaxReportCoverageStatus
  sourceCoverageSnapshot?: TaxReportSourceCoverageSnapshot[]
  createdAt: string | null
  completedAt: string | null
  failedAt?: string | null
  failureCode?: string | null
  blockedReasonCode: TaxReportGenerationBlockedReason | null
  hasCurrentReport: boolean
}

export interface TaxReportGenerationStatusReader {
  readonly durable: boolean
  getGenerationStatus(
    subjectId: string,
    taxYear: 2025 | 2026 | 2027,
    finality?: TaxReportFinality,
    residentId?: string,
  ): Promise<TaxReportGenerationStatus | undefined>
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
