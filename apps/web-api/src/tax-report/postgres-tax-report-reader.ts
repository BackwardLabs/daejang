import { verify } from 'node:crypto'
import type { Pool } from 'pg'

import type {
  CorrectionCurrentPointerPayload,
  CorrectionQuarantinePayload,
  CorrectionQuarantineScope,
  CorrectionQuarantineStore,
  CorrectionQuarantineTrust,
  CurrentTaxReport,
  ReportPaymentTaxReport,
  ReportPaymentTaxReportReader,
  SignedCorrectionArtifact,
  TaxAmount,
  TaxReportFinality,
  TaxReportReader,
} from './types.js'

export class AmbiguousCurrentTaxReportError extends Error {}
export class InconsistentTaxReportError extends Error {}
export class CorrectionPendingError extends Error {}

export type CorrectionQuarantineOptions = {
  store: CorrectionQuarantineStore
  trust: CorrectionQuarantineTrust
}

const digestPattern = /^[a-f0-9]{64}$/
const base64UrlPattern = /^[A-Za-z0-9_-]+$/

export const canonicalCorrectionArtifact = (
  payload: CorrectionQuarantinePayload | CorrectionCurrentPointerPayload,
) => {
  const scope = {
    subjectId: payload.subjectId,
    taxYear: payload.taxYear,
    finality: payload.finality,
    ...(payload.residentId === undefined ? {} : { residentId: payload.residentId }),
  }
  if ('status' in payload) {
    return JSON.stringify({
      artifactVersion: payload.artifactVersion,
      ...scope,
      reportId: payload.reportId,
      status: payload.status,
      candidateEpoch: payload.candidateEpoch,
      correctionEpoch: payload.correctionEpoch,
      expiresAt: payload.expiresAt,
      expectedCurrentPointerVersion: payload.expectedCurrentPointerVersion,
      ...(payload.finalCorrectionReceiptDigest === undefined
        ? {}
        : { finalCorrectionReceiptDigest: payload.finalCorrectionReceiptDigest }),
    })
  }
  return JSON.stringify({
    artifactVersion: payload.artifactVersion,
    ...scope,
    reportId: payload.reportId,
    candidateEpoch: payload.candidateEpoch,
    correctionEpoch: payload.correctionEpoch,
    pointerVersion: payload.pointerVersion,
    ...(payload.finalCorrectionReceiptDigest === undefined
      ? {}
      : { finalCorrectionReceiptDigest: payload.finalCorrectionReceiptDigest }),
  })
}

const sameScope = (
  payload: CorrectionQuarantineScope,
  scope: CorrectionQuarantineScope,
) =>
  payload.subjectId === scope.subjectId &&
  payload.taxYear === scope.taxYear &&
  payload.finality === scope.finality &&
  payload.residentId === scope.residentId

const validEpoch = (value: number) =>
  Number.isSafeInteger(value) && value >= 1

const validPointerVersion = (value: number) =>
  Number.isSafeInteger(value) && value >= 1

const validDigest = (value: string | undefined) =>
  typeof value === 'string' && digestPattern.test(value)

const validSignature = (value: string) =>
  typeof value === 'string' && base64UrlPattern.test(value)
const hasExactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

const canonicalScopeKeys = (payload: CorrectionQuarantineScope) => [
  'artifactVersion',
  'subjectId',
  'taxYear',
  'finality',
  ...(payload.residentId === undefined ? [] : ['residentId']),
  'reportId',
]

const validQuarantinePayload = (
  payload: CorrectionQuarantinePayload,
  scope: CorrectionQuarantineScope,
  report: ReportRow,
  now: Date,
) => {
  const expiresAt = new Date(payload.expiresAt)
  return (
    hasExactKeys(payload, [
      ...canonicalScopeKeys(payload),
      'status',
      'candidateEpoch',
      'correctionEpoch',
      'expiresAt',
      'expectedCurrentPointerVersion',
      ...(payload.finalCorrectionReceiptDigest === undefined
        ? []
        : ['finalCorrectionReceiptDigest']),
    ]) &&
    payload.artifactVersion === 1 &&
    (payload.status === 'PENDING' || payload.status === 'RELEASED') &&
    sameScope(payload, scope) &&
    payload.reportId === report.report_id &&
    validEpoch(payload.candidateEpoch) &&
    validEpoch(payload.correctionEpoch) &&
    validPointerVersion(payload.expectedCurrentPointerVersion) &&
    payload.expectedCurrentPointerVersion === Number(report.pointer_version) &&
    !Number.isNaN(expiresAt.getTime()) &&
    expiresAt > now &&
    (payload.status === 'PENDING' || validDigest(payload.finalCorrectionReceiptDigest))
  )
}

const validCurrentPointerPayload = (
  payload: CorrectionCurrentPointerPayload,
  scope: CorrectionQuarantineScope,
  report: ReportRow,
) =>
  hasExactKeys(payload, [
    ...canonicalScopeKeys(payload),
    'candidateEpoch',
    'correctionEpoch',
    'pointerVersion',
    ...(payload.finalCorrectionReceiptDigest === undefined
      ? []
      : ['finalCorrectionReceiptDigest']),
  ]) &&
  payload.artifactVersion === 1 &&
  sameScope(payload, scope) &&
  payload.reportId === report.report_id &&
  validEpoch(payload.candidateEpoch) &&
  validEpoch(payload.correctionEpoch) &&
  validPointerVersion(payload.pointerVersion) &&
  payload.pointerVersion === Number(report.pointer_version)

const hasVerifiedSignature = <T extends CorrectionQuarantinePayload | CorrectionCurrentPointerPayload>(
  artifact: SignedCorrectionArtifact<T>,
  trust: CorrectionQuarantineTrust,
) => {
  const key = trust.publicKeys.get(artifact.keyId)
  if (!key || !validSignature(artifact.signature)) return false
  try {
    return verify(
      null,
      Buffer.from(canonicalCorrectionArtifact(artifact.payload), 'utf8'),
      key,
      Buffer.from(artifact.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

type ReportRow = {
  report_id: string
  resident_id: string
  tax_year: number
  finality: TaxReportFinality
  status: CurrentTaxReport['status']
  filing_status: CurrentTaxReport['filingStatus']
  denomination_asset_id: string
  report_artifact_digest: string
  pointer_version: string
  issued_at: Date
  disposal_count: number
  transfer_count: number
  excluded_conversion_count: number
  limitation_count: number
  gain_loss_status: TaxAmount['status']
  gain_loss_amount: string | null
  taxable_base_status: TaxAmount['status']
  taxable_base_amount: string | null
  national_tax_status: TaxAmount['status']
  national_tax_amount: string | null
  local_tax_status: TaxAmount['status']
  local_tax_amount: string | null
  total_tax_status: TaxAmount['status']
  total_tax_amount: string | null
}

const amount = (status: TaxAmount['status'], value: string | null): TaxAmount => {
  if ((status === 'KNOWN') !== (value !== null)) {
    throw new InconsistentTaxReportError('Tax amount status and value disagree')
  }
  return status === 'KNOWN' ? { status, amount: value as string } : { status }
}

export class PostgresTaxReportReader
  implements TaxReportReader, ReportPaymentTaxReportReader
{
  readonly durable = true

  constructor(
    private readonly pool: Pool,
    private readonly correctionQuarantine?: CorrectionQuarantineOptions,
  ) {}

  async getCurrent(
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ): Promise<CurrentTaxReport | undefined> {
    const report = await this.getCurrentRow(
      subjectId,
      taxYear,
      finality,
      residentId,
    )
    if (!report) return undefined
    return this.toCurrentTaxReport(report)
  }

  async getCurrentForPayment(
    subjectId: string,
    taxYear: number,
    finality: 'FINAL',
    residentId?: string,
  ): Promise<ReportPaymentTaxReport | undefined> {
    const report = await this.getCurrentRow(
      subjectId,
      taxYear,
      finality,
      residentId,
    )
    if (!report) return undefined

    return {
      report: this.toCurrentTaxReport(report),
      residentId: report.resident_id,
      reportArtifactDigest: report.report_artifact_digest,
    }
  }

  private async getCurrentRow(
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ) {
    const result = await this.pool.query<ReportRow>(
      `
        SELECT
          report.report_id,
          report.resident_id,
          report.tax_year,
          report.finality,
          report.status,
          report.filing_status,
          report.denomination_asset_id,
          report.report_artifact_digest,
          current.pointer_version::text,
          report.issued_at,
          report.disposal_count,
          report.transfer_count,
          report.excluded_conversion_count,
          report.limitation_count,
          report.gain_loss_status,
          report.gain_loss_amount::text,
          report.taxable_base_status,
          report.taxable_base_amount::text,
          report.national_tax_status,
          report.national_tax_amount::text,
          report.local_tax_status,
          report.local_tax_amount::text,
          report.total_tax_status,
          report.total_tax_amount::text
        FROM reporting.current_tax_report AS current
        JOIN reporting.tax_report AS report
          ON report.subject_id = current.subject_id
         AND report.report_id = current.report_id
        WHERE current.subject_id = $1
          AND current.tax_year = $2
          AND current.finality = $3
          AND ($4::text IS NULL OR current.resident_id = $4)
        ORDER BY current.resident_id
        LIMIT 2
      `,
      [subjectId, taxYear, finality, residentId ?? null],
    )
    if (result.rows.length > 1) {
      throw new AmbiguousCurrentTaxReportError(
        'More than one resident has a current report for this subject and tax year',
      )
    }
    const report = result.rows[0]
    if (report) {
      await this.assertCorrectionClear({
        subjectId,
        taxYear,
        finality,
        residentId: report.resident_id,
      }, report)
    }
    return report
  }

  private async assertCorrectionClear(
    scope: CorrectionQuarantineScope,
    report: ReportRow,
  ) {
    if (!this.correctionQuarantine) return

    try {
      const snapshot = await this.correctionQuarantine.store.get(scope)
      if (!snapshot) return

      const { quarantine, currentPointer } = snapshot
      const { trust } = this.correctionQuarantine
      if (
        !hasVerifiedSignature(quarantine, trust) ||
        !hasVerifiedSignature(currentPointer, trust) ||
        !validQuarantinePayload(quarantine.payload, scope, report, trust.now?.() ?? new Date()) ||
        !validCurrentPointerPayload(currentPointer.payload, scope, report) ||
        quarantine.payload.candidateEpoch !== currentPointer.payload.candidateEpoch ||
        quarantine.payload.correctionEpoch !== currentPointer.payload.correctionEpoch ||
        quarantine.payload.expectedCurrentPointerVersion !== currentPointer.payload.pointerVersion ||
        quarantine.payload.status === 'PENDING' ||
        quarantine.payload.finalCorrectionReceiptDigest !==
          currentPointer.payload.finalCorrectionReceiptDigest
      ) {
        throw new CorrectionPendingError('Correction quarantine is not clear')
      }
    } catch (error) {
      if (error instanceof CorrectionPendingError) throw error
      throw new CorrectionPendingError('Correction quarantine is unavailable')
    }
  }
  private toCurrentTaxReport(report: ReportRow): CurrentTaxReport {
    const pointerVersion = Number(report.pointer_version)
    if (!Number.isSafeInteger(pointerVersion) || pointerVersion < 1) {
      throw new InconsistentTaxReportError('Tax report pointer version is invalid')
    }

    return {
      reportId: report.report_id,
      taxYear: report.tax_year,
      finality: report.finality,
      status: report.status,
      filingStatus: report.filing_status,
      denominationAssetId: report.denomination_asset_id,
      pointerVersion,
      issuedAt: report.issued_at.toISOString(),
      counts: {
        disposals: report.disposal_count,
        transfers: report.transfer_count,
        excludedConversions: report.excluded_conversion_count,
        limitations: report.limitation_count,
      },
      summary: {
        gainLoss: amount(report.gain_loss_status, report.gain_loss_amount),
        taxableBase: amount(report.taxable_base_status, report.taxable_base_amount),
        nationalTax: amount(report.national_tax_status, report.national_tax_amount),
        localTax: amount(report.local_tax_status, report.local_tax_amount),
        totalTax: amount(report.total_tax_status, report.total_tax_amount),
      },
    }
  }
}
