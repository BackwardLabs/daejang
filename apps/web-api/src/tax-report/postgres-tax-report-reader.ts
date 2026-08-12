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
  TaxReportCoverageAssurance,
  TaxReportCoverageStatus,
  TaxReportGenerationBlockedReason,
  TaxReportGenerationOutcome,
  TaxReportGenerationState,
  TaxReportGenerationStatus,
  TaxReportGenerationStatusReader,
  TaxReportFinality,
  TaxReportReader,
} from './types.js'

export class AmbiguousCurrentTaxReportError extends Error {}
export class InconsistentTaxReportError extends Error {}
export class InconsistentTaxReportGenerationStatusError extends Error {}
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
  report_model_v2_artifact_digest?: string
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

type GenerationStatusRow = {
  subject_id: unknown
  resident_id: unknown
  generation_id: unknown
  pointer_version: unknown
  state: unknown
  tax_year: unknown
  finality: unknown
  outcome: unknown
  period_start: unknown
  period_end: unknown
  coverage_from: unknown
  coverage_through: unknown
  calculated_as_of: unknown
  coverage_status: unknown
  coverage_assurance: unknown
  coverage_declaration_id: unknown
  tax_year_close_status: unknown
  source_coverage_interval_count: unknown
  source_coverage_summary_status: unknown
  source_coverage_snapshot: unknown
  created_at: unknown
  completed_at: unknown
  failed_at: unknown
  failure_code: unknown
  blocked_reason_code: unknown
  has_current_report: unknown
}

type SubjectResidentResolutionRow = {
  resident_id: unknown
  resident_count: unknown
  eligibility_status: unknown
}

const generationStates = new Set<TaxReportGenerationState>([
  'NOT_STARTED',
  'BUILDING',
  'ACTIVE',
  'REVIEW_REQUIRED',
  'FAILED',
  'SUPERSEDED',
])
const generationOutcomes = new Set<TaxReportGenerationOutcome>([
  'REPORT',
  'NO_TAX_EVENTS',
])
const generationBlockedReasons = new Set<TaxReportGenerationBlockedReason>([
  'NOT_STARTED',
  'APPLICATION_PENDING',
  'GENERATION_BUILDING',
  'GENERATION_FAILED',
  'GENERATION_NOT_ACTIVE',
  'LEDGER_STALE',
  'SOURCE_COVERAGE_INVALID',
  'TAX_RESULT_STALE',
  'REVIEW_REQUIRED',
  'GENERATION_INCOMPLETE',
  'NO_TAX_EVENTS',
  'REPORT_NOT_CURRENT',
])
const coverageStatuses = new Set<TaxReportCoverageStatus>([
  'UNKNOWN',
  'PARTIAL',
  'COMPLETE',
])
const coverageAssurances = new Set<TaxReportCoverageAssurance>([
  'UNKNOWN',
  'USER_DECLARED',
  'DOCUMENT_METADATA_VERIFIED',
  'CHAIN_VERIFIED',
])

const validDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime())

const dateOnly = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  ) {
    return value
  }
  return undefined
}

const safeInteger = (value: unknown) => {
  const number = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

const validCoverageStatus = (
  value: unknown,
): value is TaxReportCoverageStatus =>
  typeof value === 'string' &&
  coverageStatuses.has(value as TaxReportCoverageStatus)

const validCoverageAssurance = (
  value: unknown,
): value is TaxReportCoverageAssurance =>
  typeof value === 'string' &&
  coverageAssurances.has(value as TaxReportCoverageAssurance)

const sourceCoverageSnapshot = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 100_000) return undefined
  const parsed = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined
    }
    const row = entry as Record<string, unknown>
    const ordinal = safeInteger(row.coverageOrdinal)
    const declaredFrom = row.declaredFrom === null
      ? null
      : dateOnly(row.declaredFrom)
    const declaredThrough = row.declaredThrough === null
      ? null
      : dateOnly(row.declaredThrough)
    const sourceKinds = new Set(['API', 'FILE', 'MANUAL', 'OTHER'])
    if (
      typeof row.fragmentId !== 'string' || row.fragmentId.length === 0 ||
      typeof row.sourceArtifactId !== 'string' || row.sourceArtifactId.length === 0 ||
      ordinal === undefined ||
      typeof row.sourceKind !== 'string' || !sourceKinds.has(row.sourceKind) ||
      typeof row.systemName !== 'string' || row.systemName.length === 0 ||
      declaredFrom === undefined || declaredThrough === undefined ||
      (declaredFrom === null) !== (declaredThrough === null) ||
      !validCoverageStatus(row.completeness) ||
      !validCoverageAssurance(row.assurance)
    ) {
      return undefined
    }
    return {
      fragmentId: row.fragmentId,
      sourceArtifactId: row.sourceArtifactId,
      coverageOrdinal: ordinal,
      sourceKind: row.sourceKind as 'API' | 'FILE' | 'MANUAL' | 'OTHER',
      systemName: row.systemName,
      declaredFrom,
      declaredThrough,
      completeness: row.completeness,
      assurance: row.assurance,
    }
  })
  return parsed.every((entry) => entry !== undefined)
    ? parsed as NonNullable<TaxReportGenerationStatus['sourceCoverageSnapshot']>
    : undefined
}

const validGenerationState = (
  value: unknown,
): value is TaxReportGenerationState =>
  typeof value === 'string' &&
  generationStates.has(value as TaxReportGenerationState)

const validGenerationOutcome = (
  value: unknown,
): value is TaxReportGenerationOutcome =>
  typeof value === 'string' &&
  generationOutcomes.has(value as TaxReportGenerationOutcome)

const validGenerationBlockedReason = (
  value: unknown,
): value is TaxReportGenerationBlockedReason =>
  typeof value === 'string' &&
  generationBlockedReasons.has(value as TaxReportGenerationBlockedReason)

const amount = (status: TaxAmount['status'], value: string | null): TaxAmount => {
  if ((status === 'KNOWN') !== (value !== null)) {
    throw new InconsistentTaxReportError('Tax amount status and value disagree')
  }
  return status === 'KNOWN' ? { status, amount: value as string } : { status }
}

export class PostgresTaxReportReader
  implements
    TaxReportReader,
    TaxReportGenerationStatusReader,
    ReportPaymentTaxReportReader
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

  async getGenerationStatus(
    subjectId: string,
    taxYear: 2025 | 2026 | 2027,
    finality: TaxReportFinality = 'PROVISIONAL',
    residentId?: string,
  ): Promise<TaxReportGenerationStatus | undefined> {
    let resolvedResidentId = residentId
    if (!resolvedResidentId) {
      const resolution = await this.pool.query<SubjectResidentResolutionRow>(
        `
          SELECT resident_id, resident_count, eligibility_status
          FROM reporting.tax_report_subject_resident_v2($1, $2, $3)
        `,
        [subjectId, taxYear, finality],
      )
      if (resolution.rows.length !== 1) {
        throw new InconsistentTaxReportGenerationStatusError(
          'Subject resident resolution must return exactly one row',
        )
      }
      const resident = resolution.rows[0]
      const residentCount = safeInteger(resident?.resident_count)
      if (residentCount === undefined || residentCount > 1) {
        if (residentCount !== undefined && residentCount > 1) {
          throw new AmbiguousCurrentTaxReportError(
            'More than one resident is in scope for this subject and tax year',
          )
        }
        throw new InconsistentTaxReportGenerationStatusError(
          'Subject resident resolution returned an invalid count',
        )
      }
      if (residentCount === 0) {
        if (
          resident?.resident_id !== '' ||
          ![null, 'APPLICATION_PENDING', 'ELIGIBLE'].includes(
            resident?.eligibility_status as null | string,
          )
        ) {
          throw new InconsistentTaxReportGenerationStatusError(
            'Subject resident resolution returned an invalid empty scope',
          )
        }
        return this.emptyGenerationStatus(
          taxYear,
          finality,
          resident.eligibility_status === 'APPLICATION_PENDING',
        )
      }
      if (typeof resident?.resident_id !== 'string' || resident.resident_id.length === 0) {
        throw new InconsistentTaxReportGenerationStatusError(
          'Subject resident resolution did not return a resident ID',
        )
      }
      resolvedResidentId = resident.resident_id
    }

    const result = await this.pool.query<GenerationStatusRow>(
      `
        SELECT
          subject_id,
          resident_id,
          generation_id,
          pointer_version,
          state,
          tax_year,
          finality,
          outcome,
          period_start,
          period_end,
          coverage_from,
          coverage_through,
          calculated_as_of,
          coverage_status,
          coverage_assurance,
          coverage_declaration_id,
          tax_year_close_status,
          source_coverage_interval_count,
          source_coverage_summary_status,
          source_coverage_snapshot,
          created_at,
          completed_at,
          failed_at,
          failure_code,
          blocked_reason_code,
          has_current_report
        FROM reporting.tax_report_generation_status_v2($1, $2, $3, $4)
      `,
      [subjectId, resolvedResidentId, taxYear, finality],
    )
    if (result.rows.length !== 1) {
      throw new InconsistentTaxReportGenerationStatusError(
        'Parameterized generation status must return exactly one row',
      )
    }
    const row = result.rows[0]
    if (!row) return undefined
    return this.toGenerationStatus(row, subjectId, taxYear, finality)
  }

  private emptyGenerationStatus(
    taxYear: 2025 | 2026 | 2027,
    finality: TaxReportFinality,
    applicationPending: boolean,
  ): TaxReportGenerationStatus {
    return {
      generationId: null,
      state: 'NOT_STARTED',
      taxYear,
      finality,
      pointerVersion: 0,
      outcome: null,
      periodStart: `${taxYear}-01-01`,
      periodEnd: `${taxYear}-12-31`,
      coverageFrom: null,
      coverageThrough: null,
      calculatedAsOf: null,
      coverageStatus: 'UNKNOWN',
      coverageAssurance: 'UNKNOWN',
      coverageDeclarationId: null,
      taxYearCloseStatus: 'OPEN',
      sourceCoverageIntervalCount: 0,
      sourceCoverageSummaryStatus: 'UNKNOWN',
      sourceCoverageSnapshot: [],
      createdAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      blockedReasonCode: applicationPending
        ? 'APPLICATION_PENDING'
        : 'NOT_STARTED',
      hasCurrentReport: false,
    }
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
      reportArtifactDigest:
        report.report_model_v2_artifact_digest ??
        report.report_artifact_digest,
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
          report.report_model_v2_artifact_digest,
          report.pointer_version::text,
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
        FROM reporting.current_tax_report_read_v2 AS report
        WHERE report.subject_id = $1
          AND report.tax_year = $2
          AND report.finality = $3
          AND ($4::text IS NULL OR report.resident_id = $4)
        ORDER BY report.resident_id
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

  private toGenerationStatus(
    row: GenerationStatusRow,
    subjectId: string,
    taxYear: 2025 | 2026 | 2027,
    finality: TaxReportFinality,
  ): TaxReportGenerationStatus {
    const outcome = row.outcome
    const generationId = row.generation_id
    const createdAt = row.created_at
    const completedAt = row.completed_at
    const failedAt = row.failed_at
    const blockedReasonCode = row.blocked_reason_code
    const pointerless = row.state === 'NOT_STARTED'
    const pointerVersion = safeInteger(row.pointer_version)
    const periodStart = dateOnly(row.period_start)
    const periodEnd = dateOnly(row.period_end)
    const coverageFrom = row.coverage_from === null
      ? null
      : dateOnly(row.coverage_from)
    const coverageThrough = row.coverage_through === null
      ? null
      : dateOnly(row.coverage_through)
    const sourceIntervalCount = safeInteger(
      row.source_coverage_interval_count,
    )
    const coverageSnapshot = sourceCoverageSnapshot(
      row.source_coverage_snapshot,
    )
    if (
      row.subject_id !== subjectId ||
      row.tax_year !== taxYear ||
      row.finality !== finality ||
      typeof row.resident_id !== 'string' || row.resident_id.length === 0 ||
      !validGenerationState(row.state) ||
      (pointerless
        ? generationId !== null ||
          pointerVersion !== 0 ||
          createdAt !== null ||
          outcome !== null ||
          completedAt !== null ||
          failedAt !== null ||
          !['NOT_STARTED', 'APPLICATION_PENDING'].includes(
            String(blockedReasonCode),
          ) ||
          row.has_current_report !== false
        : typeof generationId !== 'string' ||
          !digestPattern.test(generationId) ||
          pointerVersion === undefined || pointerVersion < 1 ||
          !validDate(createdAt)) ||
      periodStart !== `${taxYear}-01-01` ||
      periodEnd !== `${taxYear}-12-31` ||
      coverageFrom === undefined || coverageThrough === undefined ||
      (coverageFrom === null) !== (coverageThrough === null) ||
      (row.calculated_as_of !== null && !validDate(row.calculated_as_of)) ||
      !validCoverageStatus(row.coverage_status) ||
      !validCoverageAssurance(row.coverage_assurance) ||
      (row.coverage_declaration_id !== null &&
        (typeof row.coverage_declaration_id !== 'string' ||
          row.coverage_declaration_id.length === 0)) ||
      (row.tax_year_close_status !== 'OPEN' &&
        row.tax_year_close_status !== 'CLOSED') ||
      sourceIntervalCount === undefined ||
      !validCoverageStatus(row.source_coverage_summary_status) ||
      coverageSnapshot === undefined ||
      (outcome !== null && !validGenerationOutcome(outcome)) ||
      (completedAt !== null && !validDate(completedAt)) ||
      (failedAt !== null && !validDate(failedAt)) ||
      (row.failure_code !== null &&
        (typeof row.failure_code !== 'string' ||
          !/^[A-Z0-9_]{1,64}$/.test(row.failure_code))) ||
      (blockedReasonCode !== null &&
        !validGenerationBlockedReason(blockedReasonCode)) ||
      typeof row.has_current_report !== 'boolean' ||
      (row.has_current_report &&
        (!['ACTIVE', 'REVIEW_REQUIRED'].includes(String(row.state)) ||
          outcome !== 'REPORT' ||
          completedAt === null)) ||
      (!row.has_current_report && blockedReasonCode === null) ||
      (row.state === 'BUILDING' && completedAt !== null) ||
      (row.state === 'FAILED' &&
        (failedAt === null || row.failure_code === null)) ||
      (row.state !== 'FAILED' &&
        (failedAt !== null || row.failure_code !== null)) ||
      (['ACTIVE', 'REVIEW_REQUIRED'].includes(String(row.state)) &&
        completedAt === null)
    ) {
      throw new InconsistentTaxReportGenerationStatusError(
        'Tax report generation status row is invalid',
      )
    }

    return {
      generationId: pointerless ? null : generationId as string,
      state: row.state,
      taxYear,
      finality,
      pointerVersion: pointerVersion as number,
      outcome,
      periodStart,
      periodEnd,
      coverageFrom,
      coverageThrough,
      calculatedAsOf: validDate(row.calculated_as_of)
        ? row.calculated_as_of.toISOString()
        : null,
      coverageStatus: row.coverage_status,
      coverageAssurance: row.coverage_assurance,
      coverageDeclarationId: row.coverage_declaration_id as string | null,
      taxYearCloseStatus: row.tax_year_close_status,
      sourceCoverageIntervalCount: sourceIntervalCount,
      sourceCoverageSummaryStatus: row.source_coverage_summary_status,
      sourceCoverageSnapshot: coverageSnapshot,
      createdAt: pointerless ? null : (createdAt as Date).toISOString(),
      completedAt: completedAt?.toISOString() ?? null,
      failedAt: failedAt instanceof Date ? failedAt.toISOString() : null,
      failureCode: row.failure_code as string | null,
      blockedReasonCode,
      hasCurrentReport: row.has_current_report,
    }
  }
}
