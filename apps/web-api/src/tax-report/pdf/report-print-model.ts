import type {
  PublicAmount,
  PublicTaxReportDetail,
} from '../public-model.js'
import type {
  PublicTaxReportV2Amount,
  PublicTaxReportV2Detail,
} from '../public-model-v2.js'

export type ReportPrintAmountV1 =
  | {
      status: 'KNOWN'
      amount: string
    }
  | {
      status: 'UNKNOWN'
    }

export type ReportPrintCountsV1 = {
  disposals: number
  transfers: number
  excludedConversions: number
  limitations: number
}

export type ReportPrintAssetSummaryV1 = {
  taxAssetId: string
  disposalCount: number
  quantity: string
  grossProceeds: ReportPrintAmountV1
  acquisitionCost: ReportPrintAmountV1
  ancillaryExpense: ReportPrintAmountV1
  gainLoss: ReportPrintAmountV1
}

export type ReportPrintProducerV1 = {
  name: string
  version: string
  artifactDigest: string
}

export type ReportPrintCalculationRateV1 = {
  numerator: string
  denominator: string
}

export type ReportPrintCalculationRuleV1 = {
  poolScope: 'ADDRESS' | 'RESIDENT_TAX_YEAR_TAX_ASSET'
  costMethods: ReadonlyArray<
    'MOVING_AVERAGE' | 'FIFO' | 'ANNUAL_TOTAL_AVERAGE'
  >
  basicDeductionAmount: string
  deductionUsedAmount?: string
  nationalRate: ReportPrintCalculationRateV1
  localRate: ReportPrintCalculationRateV1
  taxRounding: 'FLOOR'
  basisAllocationRounding:
    | ''
    | 'FLOOR_EXCEPT_EXHAUSTED_LAYER'
    | 'CUMULATIVE_FLOOR_ANNUAL_POOL'
    | 'MIXED'
}

export type ReportPrintCalculationContractV1 =
  | 'ANNUAL_TOTAL_AVERAGE'
  | 'LEGACY'
  | 'UNSUPPORTED'

export type ReportPrintDisposalV1 = {
  movementId: string
  eventId: string
  taxAssetId: string
  ledgerAssetId: string
  quantity: string
  grossProceeds: ReportPrintAmountV1
  ancillaryExpense: ReportPrintAmountV1
  basis: ReportPrintAmountV1
  gainLoss: ReportPrintAmountV1
  costMethod: string
  valuationId?: string
}

export type ReportPrintTransferV1 = {
  movementId: string
  eventId: string
  taxAssetId: string
  quantity: string
  basis: ReportPrintAmountV1
  fromCostMethod: string
  toCostMethod: string
}

export type ReportPrintExcludedConversionV1 = {
  eventId: string
  relationId: string
  taxAssetId: string
  fromQuantity: string
  toQuantity: string
}

export type ReportPrintLimitationV1 = {
  code: string
  reason: string
  taxAddressId?: string
  taxAssetId?: string
  movementId?: string
  reviewId?: string
  reviewRevisionId?: string
}

/**
 * PDF 전용 allowlist입니다.
 *
 * 이 타입에는 EAS UID, transaction hash, network/contract 주소, x402 결제
 * 상태를 추가하지 않습니다. PDF renderer는 이 모델 외의 런타임 상태를
 * 조회하지 않으므로 장부 내용과 온체인 publication 상태를 혼동하지 않습니다.
 */
export type ReportPrintModelV1 = {
  schemaVersion: 'giwa.tax-report-print-model.v1'
  reportId: string
  reportModelDigest: string
  inputDigest: string
  evidencePackDigest: string
  taxYear: number
  taxYearCloseStatus: 'CLOSED' | 'UNVERIFIED'
  finality: 'FINAL' | 'PROVISIONAL'
  status: 'FINAL' | 'PARTIAL'
  filingStatus: 'READY' | 'BLOCKED'
  denominationAssetId: string
  denominationAtomicDecimals: number | null
  issuedAt: string
  counts: ReportPrintCountsV1
  summary: {
    gainLoss: ReportPrintAmountV1
    taxableBase: ReportPrintAmountV1
    nationalTax: ReportPrintAmountV1
    localTax: ReportPrintAmountV1
    totalTax: ReportPrintAmountV1
    calculationRule?: ReportPrintCalculationRuleV1
    calculationContract?: ReportPrintCalculationContractV1
  }
  totals: {
    grossProceeds: ReportPrintAmountV1
    acquisitionCost: ReportPrintAmountV1
    ancillaryExpense: ReportPrintAmountV1
    gainLoss: ReportPrintAmountV1
  }
  assetSummaries: ReadonlyArray<ReportPrintAssetSummaryV1>
  disposals: ReadonlyArray<ReportPrintDisposalV1>
  transfers: ReadonlyArray<ReportPrintTransferV1>
  excludedConversions: ReadonlyArray<ReportPrintExcludedConversionV1>
  limitations: ReadonlyArray<ReportPrintLimitationV1>
  methodology: {
    taxInventoryRunId: string
    taxEstimateId: string
    lotRunId: string
    generationId?: string
    sourceLedgerGenerationId?: string
    schemaDigest: string
    policy: ReportPrintProducerV1
    engine: ReportPrintProducerV1
  }
  v2?: {
    calculationStatus: PublicTaxReportV2Detail['calculationStatus']
    taxOutcome: PublicTaxReportV2Detail['taxOutcome']
    filingAction: PublicTaxReportV2Detail['filingAction']
    filingStatus: PublicTaxReportV2Detail['filingStatus']
    filingSubmissionStatus: PublicTaxReportV2Detail['filingSubmissionStatus']
    calculatedAsOf: string
    inputPeriod: PublicTaxReportV2Detail['inputPeriod']
    dataCoverage: PublicTaxReportV2Detail['dataCoverage']
    summary: PublicTaxReportV2Detail['summary']
    assetSummaries: PublicTaxReportV2Detail['assetSummaries']
    feeAssetDisposals: PublicTaxReportV2Detail['feeAssetDisposals']
    acquisitions: PublicTaxReportV2Detail['acquisitions']
    incomeRows: PublicTaxReportV2Detail['incomeRows']
    nonTaxableTransfers: PublicTaxReportV2Detail['nonTaxableTransfers']
    sourceCoverage: PublicTaxReportV2Detail['sourceCoverage']
    disposals: PublicTaxReportV2Detail['disposals']
    transfers: PublicTaxReportV2Detail['transfers']
    policy: PublicTaxReportV2Detail['methodology']['policy']
  }
}

const printAmount = (value: PublicAmount): ReportPrintAmountV1 =>
  value.status === 'KNOWN'
    ? { status: 'KNOWN', amount: value.amount }
    : { status: 'UNKNOWN' }

const printAmountV2 = (
  value: PublicTaxReportV2Amount,
): ReportPrintAmountV1 =>
  value.status === 'KNOWN'
    ? { status: 'KNOWN', amount: value.amount }
    : { status: 'UNKNOWN' }

const printCalculationRule = (
  value: NonNullable<
    PublicTaxReportDetail['summary']['calculationRule']
  >,
): ReportPrintCalculationRuleV1 => ({
  poolScope: value.poolScope,
  costMethods: value.costMethods.map((method) => method),
  basicDeductionAmount: value.basicDeductionAmount,
  ...(value.deductionUsedAmount == null
    ? {}
    : { deductionUsedAmount: value.deductionUsedAmount }),
  nationalRate: {
    numerator: value.nationalRate.numerator,
    denominator: value.nationalRate.denominator,
  },
  localRate: {
    numerator: value.localRate.numerator,
    denominator: value.localRate.denominator,
  },
  taxRounding: value.taxRounding,
  basisAllocationRounding: value.basisAllocationRounding,
})

/**
 * 인증된 public detail projection에서 PDF가 허용한 필드만 다시 고릅니다.
 * 구조적 타입 호환이나 object spread를 사용하지 않아, public model에 추후
 * publication/payment 필드가 추가되더라도 PDF로 자동 유입되지 않습니다.
 */
export const createReportPrintModel = (
  report: PublicTaxReportDetail | PublicTaxReportV2Detail,
): ReportPrintModelV1 => report.schemaVersion === 'giwa.tax-report-model.v2'
  ? createReportPrintModelV2(report)
  : ({
  schemaVersion: 'giwa.tax-report-print-model.v1',
  reportId: report.reportId,
  reportModelDigest: report.reportModelDigest,
  inputDigest: report.inputDigest,
  evidencePackDigest: report.evidencePackDigest,
  taxYear: report.taxYear,
  taxYearCloseStatus: report.taxYearCloseStatus,
  finality: report.finality,
  status: report.status,
  filingStatus: report.filingStatus,
  denominationAssetId: report.denominationAssetId,
  denominationAtomicDecimals:
    report.denominationAssetId === 'asset-krw-upbit' ? 8 : null,
  issuedAt: report.issuedAt,
  counts: {
    disposals: report.counts.disposals,
    transfers: report.counts.transfers,
    excludedConversions: report.counts.excludedConversions,
    limitations: report.counts.limitations,
  },
  summary: {
    gainLoss: printAmount(report.summary.gainLoss),
    taxableBase: printAmount(report.summary.taxableBase),
    nationalTax: printAmount(report.summary.nationalTax),
    localTax: printAmount(report.summary.localTax),
    totalTax: printAmount(report.summary.totalTax),
    ...(report.summary.calculationRule == null
      ? {}
      : {
          calculationRule: printCalculationRule(
            report.summary.calculationRule,
          ),
        }),
    ...(report.summary.calculationContract == null
      ? {}
      : {
          calculationContract: report.summary.calculationContract,
        }),
  },
  totals: {
    grossProceeds: printAmount(report.totals.grossProceeds),
    acquisitionCost: printAmount(report.totals.acquisitionCost),
    ancillaryExpense: printAmount(report.totals.ancillaryExpense),
    gainLoss: printAmount(report.totals.gainLoss),
  },
  assetSummaries: report.assetSummaries.map((row) => ({
    taxAssetId: row.taxAssetId,
    disposalCount: row.disposalCount,
    quantity: row.quantity,
    grossProceeds: printAmount(row.grossProceeds),
    acquisitionCost: printAmount(row.acquisitionCost),
    ancillaryExpense: printAmount(row.ancillaryExpense),
    gainLoss: printAmount(row.gainLoss),
  })),
  disposals: report.disposals.map((row) => ({
    movementId: row.movementId,
    eventId: row.eventId,
    taxAssetId: row.taxAssetId,
    ledgerAssetId: row.ledgerAssetId,
    quantity: row.quantity,
    grossProceeds: printAmount(row.grossProceeds),
    ancillaryExpense: printAmount(row.ancillaryExpense),
    basis: printAmount(row.basis),
    gainLoss: printAmount(row.gainLoss),
    costMethod: row.costMethod,
    ...(row.valuationId === null
      ? {}
      : { valuationId: row.valuationId }),
  })),
  transfers: report.transfers.map((row) => ({
    movementId: row.movementId,
    eventId: row.eventId,
    taxAssetId: row.taxAssetId,
    quantity: row.quantity,
    basis: printAmount(row.basis),
    fromCostMethod: row.fromCostMethod,
    toCostMethod: row.toCostMethod,
  })),
  excludedConversions: report.excludedConversions.map((row) => ({
    eventId: row.eventId,
    relationId: row.relationId,
    taxAssetId: row.taxAssetId,
    fromQuantity: row.fromQuantity,
    toQuantity: row.toQuantity,
  })),
  limitations: report.limitations.map((row) => ({
    code: row.code,
    reason: row.reason,
    ...(row.taxAddressId === null
      ? {}
      : { taxAddressId: row.taxAddressId }),
    ...(row.taxAssetId === null ? {} : { taxAssetId: row.taxAssetId }),
    ...(row.movementId === null ? {} : { movementId: row.movementId }),
    ...(row.reviewId === null ? {} : { reviewId: row.reviewId }),
    ...(row.reviewRevisionId === null
      ? {}
      : { reviewRevisionId: row.reviewRevisionId }),
  })),
  methodology: {
    taxInventoryRunId: report.methodology.taxInventoryRunId,
    taxEstimateId: report.methodology.taxEstimateId,
    lotRunId: report.methodology.lotRunId,
    generationId: report.methodology.generationId,
    schemaDigest: report.methodology.schemaDigest,
    policy: {
      name: report.methodology.policy.name,
      version: report.methodology.policy.version,
      artifactDigest: report.methodology.policy.artifactDigest,
    },
    engine: {
      name: report.methodology.engine.name,
      version: report.methodology.engine.version,
      artifactDigest: report.methodology.engine.artifactDigest,
    },
  },
})

const createReportPrintModelV2 = (
  report: PublicTaxReportV2Detail,
): ReportPrintModelV1 => ({
  schemaVersion: 'giwa.tax-report-print-model.v1',
  reportId: report.reportId,
  reportModelDigest: report.reportModelDigest,
  inputDigest: report.inputDigest,
  evidencePackDigest: report.evidencePackDigest,
  taxYear: report.taxYear,
  taxYearCloseStatus:
    report.taxYearCloseStatus === 'CLOSED' ? 'CLOSED' : 'UNVERIFIED',
  finality: report.reportFinality,
  status: report.status,
  filingStatus: report.filingStatus,
  denominationAssetId: report.denominationAssetId,
  denominationAtomicDecimals: report.denominationAtomicDecimals,
  issuedAt: report.issuedAt,
  counts: {
    disposals: report.counts.disposals + report.counts.feeAssetDisposals,
    transfers: report.counts.transfers,
    excludedConversions: report.excludedConversions.length,
    limitations: report.counts.limitations,
  },
  summary: {
    gainLoss: printAmountV2(report.summary.disposalGainLoss),
    taxableBase: printAmountV2(report.summary.taxableBase),
    nationalTax: printAmountV2(report.summary.nationalTax),
    localTax: printAmountV2(report.summary.localTax),
    totalTax: printAmountV2(report.summary.totalTax),
    calculationRule: {
      poolScope: report.summary.calculationRule.poolScope,
      costMethods: report.summary.calculationRule.costMethods,
      basicDeductionAmount:
        report.summary.calculationRule.basicDeductionAmount,
      ...(report.summary.calculationRule.deductionUsedAmount === null
        ? {}
        : {
            deductionUsedAmount:
              report.summary.calculationRule.deductionUsedAmount,
          }),
      nationalRate: report.summary.calculationRule.nationalRate,
      localRate: report.summary.calculationRule.localRate,
      taxRounding: report.summary.calculationRule.taxRounding,
      basisAllocationRounding:
        report.summary.calculationRule.basisAllocationRounding,
    },
    calculationContract: 'ANNUAL_TOTAL_AVERAGE',
  },
  // V2 supplies these annual aggregates as Tax Engine-owned values. Never
  // reconstruct them from asset/disposal rows in the BFF.
  totals: {
    grossProceeds: printAmountV2(report.summary.grossProceeds),
    acquisitionCost: printAmountV2(report.summary.disposedBasis),
    ancillaryExpense: printAmountV2(report.summary.deductibleExpense),
    gainLoss: printAmountV2(report.summary.disposalGainLoss),
  },
  assetSummaries: report.assetSummaries.map((row) => ({
    taxAssetId: row.taxAssetId,
    disposalCount: [
      ...report.disposals,
      ...report.feeAssetDisposals,
    ].filter((disposal) => disposal.taxAssetId === row.taxAssetId).length,
    quantity: row.disposedQuantity,
    grossProceeds: printAmountV2(row.grossProceeds),
    acquisitionCost: printAmountV2(row.disposedBasis),
    ancillaryExpense: printAmountV2(row.deductibleExpense),
    gainLoss: printAmountV2(row.gainLoss),
  })),
  disposals: [...report.disposals, ...report.feeAssetDisposals].map((row) => ({
    movementId: row.movementId,
    eventId: row.eventId,
    taxAssetId: row.taxAssetId,
    ledgerAssetId: row.ledgerAssetId,
    quantity: row.quantity,
    grossProceeds: printAmountV2(row.grossProceeds),
    ancillaryExpense: printAmountV2(row.ancillaryExpense),
    basis: printAmountV2(row.basis),
    gainLoss: printAmountV2(row.gainLoss),
    costMethod: row.costMethod,
    ...(row.valuationId === null ? {} : { valuationId: row.valuationId }),
  })),
  transfers: report.transfers.map((row) => ({
    movementId: row.movementId,
    eventId: row.eventId,
    taxAssetId: row.taxAssetId,
    quantity: row.quantity,
    basis: printAmountV2(row.basis),
    fromCostMethod: row.fromCostMethod,
    toCostMethod: row.toCostMethod,
  })),
  excludedConversions: report.excludedConversions.map((row) => ({
    eventId: row.eventId,
    relationId: row.relationId,
    taxAssetId: row.taxAssetId,
    fromQuantity: row.fromQuantity,
    toQuantity: row.toQuantity,
  })),
  limitations: report.limitations.map((row) => ({
    code: row.code,
    reason: row.reason,
    ...(row.taxAddressId === null ? {} : { taxAddressId: row.taxAddressId }),
    ...(row.taxAssetId === null ? {} : { taxAssetId: row.taxAssetId }),
    ...(row.movementId === null ? {} : { movementId: row.movementId }),
    ...(row.reviewId === null ? {} : { reviewId: row.reviewId }),
    ...(row.reviewRevisionId === null
      ? {}
      : { reviewRevisionId: row.reviewRevisionId }),
  })),
  methodology: {
    taxInventoryRunId: report.methodology.taxInventoryRunId,
    taxEstimateId: report.methodology.taxEstimateId,
    lotRunId: report.methodology.lotRunId,
    sourceLedgerGenerationId: report.methodology.sourceLedgerGenerationId,
    schemaDigest: report.methodology.schemaDigest,
    policy: {
      name: report.methodology.policy.name,
      version: report.methodology.policy.version,
      artifactDigest: report.methodology.policy.artifactDigest,
    },
    engine: report.methodology.engine,
  },
  v2: {
    calculationStatus: report.calculationStatus,
    taxOutcome: report.taxOutcome,
    filingAction: report.filingAction,
    filingStatus: report.filingStatus,
    filingSubmissionStatus: report.filingSubmissionStatus,
    calculatedAsOf: report.calculatedAsOf,
    inputPeriod: report.inputPeriod,
    dataCoverage: report.dataCoverage,
    summary: report.summary,
    assetSummaries: report.assetSummaries,
    feeAssetDisposals: report.feeAssetDisposals,
    acquisitions: report.acquisitions,
    incomeRows: report.incomeRows,
    nonTaxableTransfers: report.nonTaxableTransfers,
    sourceCoverage: report.sourceCoverage,
    disposals: report.disposals,
    transfers: report.transfers,
    policy: report.methodology.policy,
  },
})
