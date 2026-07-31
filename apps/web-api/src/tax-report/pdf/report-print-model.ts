import type {
  PublicAmount,
  PublicTaxReportDetail,
} from '../public-model.js'

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
  finality: 'FINAL' | 'PROVISIONAL'
  status: 'FINAL' | 'PARTIAL'
  filingStatus: 'READY' | 'BLOCKED'
  denominationAssetId: string
  issuedAt: string
  counts: ReportPrintCountsV1
  summary: {
    gainLoss: ReportPrintAmountV1
    taxableBase: ReportPrintAmountV1
    nationalTax: ReportPrintAmountV1
    localTax: ReportPrintAmountV1
    totalTax: ReportPrintAmountV1
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
    generationId: string
    schemaDigest: string
    policy: ReportPrintProducerV1
    engine: ReportPrintProducerV1
  }
}

export const reportPolicySimulationNotice = (taxYear: number) => {
  if (!Number.isInteger(taxYear) || taxYear < 2025) {
    throw new Error('Report taxYear must be an integer greater than or equal to 2025')
  }
  return taxYear < 2027
    ? 'POLICY_SIMULATION · 2027.1.1 시행 예정 기준 · 신고용 아님'
    : undefined
}

const printAmount = (value: PublicAmount): ReportPrintAmountV1 =>
  value.status === 'KNOWN'
    ? { status: 'KNOWN', amount: value.amount }
    : { status: 'UNKNOWN' }

/**
 * 인증된 public detail projection에서 PDF가 허용한 필드만 다시 고릅니다.
 * 구조적 타입 호환이나 object spread를 사용하지 않아, public model에 추후
 * publication/payment 필드가 추가되더라도 PDF로 자동 유입되지 않습니다.
 */
export const createReportPrintModel = (
  report: PublicTaxReportDetail,
): ReportPrintModelV1 => ({
  schemaVersion: 'giwa.tax-report-print-model.v1',
  reportId: report.reportId,
  reportModelDigest: report.reportModelDigest,
  inputDigest: report.inputDigest,
  evidencePackDigest: report.evidencePackDigest,
  taxYear: report.taxYear,
  finality: report.finality,
  status: report.status,
  filingStatus: report.filingStatus,
  denominationAssetId: report.denominationAssetId,
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
