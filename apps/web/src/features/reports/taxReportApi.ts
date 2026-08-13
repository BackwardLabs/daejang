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

export type TaxReportGenerationStatusModel = {
  generationId: string | null
  state:
    | 'NOT_STARTED'
    | 'BUILDING'
    | 'ACTIVE'
    | 'REVIEW_REQUIRED'
    | 'FAILED'
    | 'SUPERSEDED'
  taxYear: number
  finality: 'FINAL' | 'PROVISIONAL'
  pointerVersion: number
  outcome: 'REPORT' | 'NO_TAX_EVENTS' | null
  periodStart: string
  periodEnd: string
  coverageFrom: string | null
  coverageThrough: string | null
  calculatedAsOf: string | null
  coverageStatus: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
  coverageAssurance:
    | 'UNKNOWN'
    | 'USER_DECLARED'
    | 'DOCUMENT_METADATA_VERIFIED'
    | 'CHAIN_VERIFIED'
  taxYearCloseStatus: 'OPEN' | 'CLOSED'
  sourceCoverageIntervalCount: number
  sourceCoverageSummaryStatus: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
  sourceCoverage: Array<{
    sourceKind: 'API' | 'FILE' | 'MANUAL' | 'OTHER'
    systemName: string
    declaredFrom: string | null
    declaredThrough: string | null
    completeness: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
    assurance:
      | 'UNKNOWN'
      | 'USER_DECLARED'
      | 'DOCUMENT_METADATA_VERIFIED'
      | 'CHAIN_VERIFIED'
  }>
  createdAt: string | null
  completedAt: string | null
  failedAt: string | null
  failureCode: string | null
  blockedReasonCode:
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
    | null
  hasCurrentReport: boolean
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

export type TaxReportV2CalculationRuleModel = Omit<
  TaxReportCalculationRuleModel,
  'basisAllocationRounding' | 'costMethods' | 'deductionUsedAmount' | 'poolScope'
> & {
  basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL'
  costMethods: ['ANNUAL_TOTAL_AVERAGE']
  deductionUsedAmount: string | null
  poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET'
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

export type TaxReportV2AmountModel = TaxReportDetailAmountModel

export type TaxReportV2IntervalModel = { from: string; through: string }

export type TaxReportV2DetailModel = {
  schemaVersion: 'giwa.tax-report-model.v2'
  reportId: string
  reportModelDigest: string
  inputDigest: string
  evidencePackDigest: string
  taxYear: number
  status: 'FINAL' | 'PARTIAL'
  calculationStatus: 'COMPLETE' | 'BLOCKED'
  taxOutcome: string
  filingAction: string
  filingStatus: 'READY' | 'BLOCKED'
  filingSubmissionStatus: 'UNKNOWN' | 'NOT_APPLICABLE'
  inputPeriod: TaxReportV2IntervalModel
  dataCoverage: {
    status: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
    assurance: string
    from: string
    through: string
    declaration: string | null
    coveredIntervals: TaxReportV2IntervalModel[]
    uncoveredIntervals: TaxReportV2IntervalModel[]
  }
  calculatedAsOf: string
  taxYearCloseStatus: 'OPEN' | 'CLOSED'
  valuationFinality: 'FINAL' | 'PROVISIONAL'
  reportFinality: 'FINAL' | 'PROVISIONAL'
  denominationAssetId: string
  denominationAtomicDecimals: number
  counts: {
    assetSummaries: number
    disposals: number
    feeAssetDisposals: number
    acquisitions: number
    incomeRows: number
    transfers: number
    nonTaxableTransfers: number
    limitations: number
    sourceArtifacts: number
  }
  summary: {
    grossProceeds: TaxReportV2AmountModel
    disposedBasis: TaxReportV2AmountModel
    deductibleExpense: TaxReportV2AmountModel
    incurredExpense: TaxReportV2AmountModel
    disposalGainLoss: TaxReportV2AmountModel
    lendingIncome: TaxReportV2AmountModel
    lendingExpense: TaxReportV2AmountModel
    netLendingIncome: TaxReportV2AmountModel
    taxableIncome: TaxReportV2AmountModel
    taxableBase: TaxReportV2AmountModel
    nationalTax: TaxReportV2AmountModel
    localTax: TaxReportV2AmountModel
    totalTax: TaxReportV2AmountModel
    calculationRule: TaxReportV2CalculationRuleModel
  }
  assetSummaries: Array<{
    taxAssetId: string
    openingQuantity: string
    openingBasis: TaxReportV2AmountModel
    openingBasisProvenance: {
      status: 'NOT_APPLICABLE' | 'UNKNOWN' | 'KNOWN'
      basisRule: string | null
      actualAcquisitionAmount: string | null
      marketValueAt2026End: string | null
      sourceRunId: string | null
    }
    acquiredQuantity: string
    acquisitionCost: TaxReportV2AmountModel
    annualAverage: {
      status: 'KNOWN' | 'UNKNOWN' | 'NOT_APPLICABLE'
      numerator: string | null
      denominator: string | null
      unitCost: string | null
      unitCostNumerator: string | null
      unitCostDenominator: string | null
      rounding: string | null
    }
    disposedQuantity: string
    grossProceeds: TaxReportV2AmountModel
    incurredExpense: TaxReportV2AmountModel
    deductibleExpense: TaxReportV2AmountModel
    disposedBasis: TaxReportV2AmountModel
    gainLoss: TaxReportV2AmountModel
    endingQuantity: string
    endingCost: TaxReportV2AmountModel
    basisMode: 'ACTUAL_TOTAL_AVERAGE' | 'DEEMED_EXPENSE_50'
    basisEvidenceDigest: string | null
  }>
  disposals: TaxReportV2DisposalModel[]
  feeAssetDisposals: TaxReportV2DisposalModel[]
  acquisitions: TaxReportV2AcquisitionModel[]
  incomeRows: TaxReportV2IncomeModel[]
  transfers: TaxReportV2TransferModel[]
  nonTaxableTransfers: Array<{
    transactionType: 'SELF_TRANSFER'
    movementId: string
    eventId: string
    revisionId: string
    fromLegId: string
    toLegId: string
    taxAssetId: string
    quantity: string
    occurredAt: string
    from: TaxReportV2AccountModel
    to: TaxReportV2AccountModel
    sourceEvidence: TaxReportV2SourceEvidenceModel[]
    review: TaxReportV2RowReviewModel
  }>
  excludedConversions: TaxReportExcludedConversionModel[]
  limitations: TaxReportLimitationModel[]
  sourceCoverage: Array<{
    sourceArtifactId: string
    sourceKind: string
    systemName: string | null
    assurance: string
    status: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
    evidenceDigest: string
    fragmentIds: string[]
    coveredIntervals: TaxReportV2IntervalModel[]
    uncoveredIntervals: TaxReportV2IntervalModel[]
  }>
  methodology: {
    taxInventoryRunId: string
    taxEstimateId: string
    lotRunId: string
    sourceLedgerGenerationId: string
    schemaDigest: string
    policy: TaxReportProducerModel & {
      sourceSetDigest: string
      applicationMode: 'ENACTED' | 'SIMULATION'
      effectiveFrom: string
      effectiveThrough: string
      denominationAtomicDecimals: number
      roundingProfileStatus: 'APPROVED' | 'ESTIMATE_ONLY_UNAPPROVED'
      roundingProfileEvidenceDigest: string | null
      legalReferences: Array<{
        law: string
        article: string
        paragraphs: string[]
        purpose: string
        sourceLocators: string[]
        sourceCheckedAt: string | null
      }>
    }
    engine: TaxReportProducerModel
  }
  issuedAt: string
}

export type TaxReportV2DisposalModel = TaxReportDisposalModel & {
  transactionType: 'DISPOSAL' | 'FEE_ASSET_DISPOSAL'
  relatedMovementId: string | null
  incurredExpense: TaxReportV2AmountModel
  basisMode: 'ACTUAL_TOTAL_AVERAGE' | 'DEEMED_EXPENSE_50'
  basisEvidenceDigest: string | null
  costMethod: 'ANNUAL_TOTAL_AVERAGE'
  rounding:
    | 'CUMULATIVE_FLOOR_ANNUAL_POOL'
    | 'CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS'
  occurredAt: string
  account: TaxReportV2AccountModel
  valuation: TaxReportV2ValuationModel
  sourceEvidence: TaxReportV2SourceEvidenceModel[]
  review: TaxReportV2RowReviewModel
}

type TaxReportV2MovementModel = {
  transactionType: string
  movementId: string
  relatedMovementId: string | null
  eventId: string
  revisionId: string
  legId: string
  kind: string
  taxAssetId: string
  ledgerAssetId: string
  quantity: string
  valuationId: string | null
  occurredAt: string
  account: TaxReportV2AccountModel
  valuation: TaxReportV2ValuationModel
  sourceEvidence: TaxReportV2SourceEvidenceModel[]
  review: TaxReportV2RowReviewModel
}

export type TaxReportV2AccountModel = {
  status: 'UNKNOWN' | 'PARTIAL' | 'KNOWN'
  accountId: string | null
  accountKind: string | null
  displayNameStatus: 'UNKNOWN'
  displayName: string | null
}

export type TaxReportV2ValuationModel = {
  status: 'UNKNOWN' | 'PARTIAL' | 'KNOWN'
  valuationId: string | null
  kind: string | null
  effectiveAt: string | null
  quoteId: string | null
  snapshotArtifactDigest: string | null
  baseAtomicUnits: string | null
  quoteAtomicUnits: string | null
  rounding: string | null
  providerStatus: 'UNKNOWN' | 'KNOWN'
  provider: string | null
  datasetVersionStatus: 'UNKNOWN' | 'KNOWN'
  datasetVersion: string | null
  marketStatus: 'UNKNOWN' | 'KNOWN'
  market: string | null
}

export type TaxReportV2SourceEvidenceModel = {
  legId: string | null
  relationId: string | null
  fragmentId: string
  observationId: string
  sourceArtifactBindingStatus: 'BOUND' | 'UNBOUND'
  sourceArtifactIds: string[]
  sourceKinds: string[]
}

export type TaxReportV2RowReviewModel = {
  status: 'CLEAR' | 'REVIEW_REQUIRED'
  limitations: TaxReportLimitationModel[]
}

export type TaxReportV2TransferModel = TaxReportTransferModel & {
  transactionType: 'TRANSFER'
  occurredAt: string
  from: TaxReportV2AccountModel
  to: TaxReportV2AccountModel
  sourceEvidence: TaxReportV2SourceEvidenceModel[]
  review: TaxReportV2RowReviewModel
}

export type TaxReportV2AcquisitionModel = TaxReportV2MovementModel & {
  transactionType: 'ACQUIRE' | 'OTHER_ACQUISITION'
  kind: 'ACQUIRE' | 'OTHER_ACQUISITION'
  consideration: TaxReportV2AmountModel
  acquisitionAncillaryExpense: TaxReportV2AmountModel
  acquisitionCost: TaxReportV2AmountModel
}

export type TaxReportV2IncomeModel = TaxReportV2MovementModel & {
  transactionType: 'LENDING_INCOME_CASH' | 'LENDING_INCOME_ASSET'
  kind: 'LENDING_INCOME_CASH' | 'LENDING_INCOME_ASSET'
  income: TaxReportV2AmountModel
  ancillaryExpense: TaxReportV2AmountModel
}

export type AnyTaxReportDetailModel =
  | TaxReportDetailModel
  | TaxReportV2DetailModel

type CompatibleTaxReportDetailModel = Omit<
  TaxReportDetailModel,
  'summary' | 'taxYearCloseStatus'
> & {
  summary: Omit<
    TaxReportDetailModel['summary'],
    'calculationContract' | 'calculationRule'
  > & {
    calculationContract?: TaxReportDetailModel['summary']['calculationContract']
    calculationRule?: TaxReportCalculationRuleModel | null
  }
  taxYearCloseStatus?: TaxReportDetailModel['taxYearCloseStatus']
}

const normalizeTaxReportDetail = (
  report: CompatibleTaxReportDetailModel,
): TaxReportDetailModel => ({
  ...report,
  summary: {
    ...report.summary,
    calculationContract:
      report.summary.calculationContract ?? 'UNSUPPORTED',
    calculationRule: report.summary.calculationRule ?? null,
  },
  taxYearCloseStatus: report.taxYearCloseStatus ?? 'UNVERIFIED',
})

export const loadCurrentTaxReport = (
  taxYear: string,
  finality: 'FINAL' | 'PROVISIONAL',
  signal?: AbortSignal,
) =>
  requestApi<{ report: TaxReportModel }>(
    `/tax-reports/${encodeURIComponent(taxYear)}/current?finality=${finality}`,
    { signal },
  )

export const loadTaxReportGenerationStatus = (
  taxYear: string,
  finality: 'FINAL' | 'PROVISIONAL',
  signal?: AbortSignal,
) => requestApi<{ status: TaxReportGenerationStatusModel }>(
  `/tax-reports/${encodeURIComponent(taxYear)}/status?finality=${finality}`,
  { signal },
)

export const loadTaxReportHistory = (
  taxYear: string,
  signal?: AbortSignal,
) => requestApi<{ items: TaxReportModel[] }>(
  `/tax-reports/${encodeURIComponent(taxYear)}/history?limit=20`,
  { signal },
)

export const loadTaxReportDetail = async (
  reportId: string,
  signal?: AbortSignal,
) => {
  const response = await requestApi<{
    report: CompatibleTaxReportDetailModel | TaxReportV2DetailModel
  }>(
    `/tax-reports/${encodeURIComponent(reportId)}`,
    { signal },
  )

  return response.report.schemaVersion === 'giwa.tax-report-model.v2'
    ? { report: response.report }
    : { report: normalizeTaxReportDetail(response.report) }
}

export const loadTaxReportEvidence = (
  reportId: string,
  signal?: AbortSignal,
) => requestApi<{ evidencePack: TaxEvidencePackModel }>(
  `/tax-reports/${encodeURIComponent(reportId)}/evidence`,
  { signal },
)
