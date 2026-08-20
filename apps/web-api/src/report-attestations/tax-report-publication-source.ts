import { createHash } from 'node:crypto'

import type { Pool } from 'pg'

import type {
  ReportAttestationEligibility,
  ReportAttestationPublication,
  ReportAttestationPublicationSource,
} from './publication-source.js'
import { ReportAttestationPublicationIneligibleError } from './publication-source.js'
import type { Hex32 } from './types.js'

const REPORT_ID_PATTERN = /^tax-report-v2:[0-9a-f]{64}$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const SOURCE_VERSION = 'giwa.tax-report-publication.v3'
const DERIVATION_RULE_VERSION =
  'giwa.tax-report-publication-allowlist.v3'

export const TAX_REPORT_DERIVATION_RULE_DIGEST =
  `0x${createHash('sha256')
    .update(DERIVATION_RULE_VERSION, 'utf8')
    .digest('hex')}` as Hex32

type ActivatedTaxReportPublicationRow = {
  subject_id: unknown
  report_id: unknown
  tax_year: unknown
  finality: unknown
  status: unknown
  filing_status: unknown
  generation_id: unknown
  generation_state: unknown
  bound_report_pointer_version: unknown
  report_model_v2_artifact_digest: unknown
  evidence_pack_v2_artifact_digest: unknown
  policy_artifact_digest: unknown
  coverage_status: unknown
  coverage_assurance: unknown
  tax_year_close_status: unknown
  calculated_as_of: unknown
  is_current_report: unknown
  is_current_tax_result: unknown
  is_current_ledger_scope: unknown
  is_current_source_coverage: unknown
}

export class InconsistentTaxReportPublicationError extends Error {
  constructor() {
    super('Activated Tax Report V2 publication is inconsistent')
    this.name = 'InconsistentTaxReportPublicationError'
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalJson(entry)}`,
    )
    .join(',')}}`
}

const safePositiveInteger = (value: unknown) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : undefined
}

const isoTimestamp = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }
  return undefined
}

const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && DIGEST_PATTERN.test(value)

const currentEligibilityFromRow = (
  row: ActivatedTaxReportPublicationRow,
  ownerId: string,
  reportId: string,
): ReportAttestationEligibility => {
  const currentReport =
    row.subject_id === ownerId &&
    row.report_id === reportId &&
    REPORT_ID_PATTERN.test(reportId) &&
    Number.isSafeInteger(row.tax_year) &&
    Number(row.tax_year) >= 2025 &&
    (row.finality === 'FINAL' || row.finality === 'PROVISIONAL') &&
    (row.status === 'FINAL' || row.status === 'PARTIAL') &&
    (row.filing_status === 'READY' || row.filing_status === 'BLOCKED') &&
    (row.generation_state === 'ACTIVE' ||
      row.generation_state === 'REVIEW_REQUIRED') &&
    validDigest(row.generation_id) &&
    safePositiveInteger(row.bound_report_pointer_version) !== undefined &&
    (row.coverage_status === 'COMPLETE' ||
      row.coverage_status === 'PARTIAL' ||
      row.coverage_status === 'UNKNOWN') &&
    (row.coverage_assurance === 'DOCUMENT_METADATA_VERIFIED' ||
      row.coverage_assurance === 'CHAIN_VERIFIED' ||
      row.coverage_assurance === 'USER_DECLARED' ||
      row.coverage_assurance === 'UNKNOWN') &&
    (row.tax_year_close_status === 'OPEN' ||
      row.tax_year_close_status === 'CLOSED') &&
    isoTimestamp(row.calculated_as_of) !== undefined &&
    row.is_current_report === true
  const checks = [
    { code: 'CURRENT_REPORT', status: currentReport },
    {
      code: 'CALCULATION_RESULT',
      status:
        row.is_current_tax_result === true &&
        validDigest(row.report_model_v2_artifact_digest),
    },
    {
      code: 'EVIDENCE_PACK',
      status:
        validDigest(row.evidence_pack_v2_artifact_digest) &&
        validDigest(row.policy_artifact_digest),
    },
    { code: 'CURRENT_LEDGER', status: row.is_current_ledger_scope === true },
    {
      code: 'CURRENT_SOURCE_COVERAGE',
      status: row.is_current_source_coverage === true,
    },
  ].map(({ code, status }) => ({
    code: code as ReportAttestationEligibility['checks'][number]['code'],
    status: status ? 'PASSED' as const : 'FAILED' as const,
  }))
  return {
    reportId,
    eligible: checks.every((check) => check.status === 'PASSED'),
    checks,
  }
}

const publicationFromRow = (
  row: ActivatedTaxReportPublicationRow,
  ownerId: string,
  reportId: string,
  requireCurrent: boolean,
): ReportAttestationPublication => {
  const pointerVersion = safePositiveInteger(
    row.bound_report_pointer_version,
  )
  const calculatedAsOf = isoTimestamp(row.calculated_as_of)
  if (
    row.subject_id !== ownerId ||
    row.report_id !== reportId ||
    !REPORT_ID_PATTERN.test(reportId) ||
    !Number.isSafeInteger(row.tax_year) ||
    Number(row.tax_year) < 2025 ||
    (row.finality !== 'FINAL' && row.finality !== 'PROVISIONAL') ||
    (row.status !== 'FINAL' && row.status !== 'PARTIAL') ||
    (row.filing_status !== 'READY' && row.filing_status !== 'BLOCKED') ||
    (row.generation_state !== 'ACTIVE' &&
      row.generation_state !== 'REVIEW_REQUIRED' &&
      row.generation_state !== 'SUPERSEDED') ||
    !validDigest(row.generation_id) ||
    pointerVersion === undefined ||
    !validDigest(row.report_model_v2_artifact_digest) ||
    !validDigest(row.evidence_pack_v2_artifact_digest) ||
    !validDigest(row.policy_artifact_digest) ||
    (row.coverage_status !== 'COMPLETE' &&
      row.coverage_status !== 'PARTIAL' &&
      row.coverage_status !== 'UNKNOWN') ||
    (row.coverage_assurance !== 'DOCUMENT_METADATA_VERIFIED' &&
      row.coverage_assurance !== 'CHAIN_VERIFIED' &&
      row.coverage_assurance !== 'USER_DECLARED' &&
      row.coverage_assurance !== 'UNKNOWN') ||
    (row.tax_year_close_status !== 'OPEN' &&
      row.tax_year_close_status !== 'CLOSED') ||
    calculatedAsOf === undefined ||
    (requireCurrent &&
      ((row.generation_state !== 'ACTIVE' &&
        row.generation_state !== 'REVIEW_REQUIRED') ||
        row.is_current_report !== true ||
        row.is_current_tax_result !== true ||
        row.is_current_ledger_scope !== true ||
        row.is_current_source_coverage !== true))
  ) {
    throw new InconsistentTaxReportPublicationError()
  }

  const safeArtifact = {
    calculatedAsOf,
    coverageAssurance: row.coverage_assurance,
    coverageStatus: row.coverage_status,
    derivationRuleVersion: DERIVATION_RULE_VERSION,
    evidencePackDigest: row.evidence_pack_v2_artifact_digest,
    filingStatus: row.filing_status,
    finality: row.finality,
    generationId: row.generation_id,
    policyArtifactDigest: row.policy_artifact_digest,
    reportId,
    reportModelDigest: row.report_model_v2_artifact_digest,
    reportPointerVersion: pointerVersion,
    reportStatus: row.status,
    schemaVersion: 'giwa.tax-report.publication.v2',
    taxYear: Number(row.tax_year),
    taxYearCloseStatus: row.tax_year_close_status,
  }

  return {
    reportId,
    sourceVersion: SOURCE_VERSION,
    // A Tax Report V2 ID is itself immutable and changes with its committed
    // input. DB pointer versions remain inside the safe projection, while EAS
    // revision 1 attests this exact immutable report identity once.
    revision: 1,
    derivationRuleDigest: TAX_REPORT_DERIVATION_RULE_DIGEST,
    safeArtifactBytes: new TextEncoder().encode(
      canonicalJson(safeArtifact),
    ),
  }
}

/**
 * Loads only an authenticated owner's exact, currently valid Tax Report V2
 * binding. The public EAS commitment intentionally excludes resident identity,
 * source rows, transaction details, balances, and tax amounts.
 */
export class PostgresTaxReportAttestationPublicationSource
  implements ReportAttestationPublicationSource
{
  constructor(private readonly pool: Pool) {}

  async getEligibility(
    ownerId: string,
    reportId: string,
  ): Promise<ReportAttestationEligibility | undefined> {
    if (ownerId.length === 0 || !REPORT_ID_PATTERN.test(reportId)) {
      return undefined
    }
    const rows = await this.#loadRows(ownerId, reportId)
    if (rows.length === 0) return undefined
    if (rows.length !== 1) {
      throw new InconsistentTaxReportPublicationError()
    }
    const row = rows[0]
    if (!row) return undefined
    return currentEligibilityFromRow(row, ownerId, reportId)
  }

  async getPublication(
    ownerId: string,
    reportId: string,
    revision?: number,
  ): Promise<ReportAttestationPublication | undefined> {
    if (
      ownerId.length === 0 ||
      !REPORT_ID_PATTERN.test(reportId) ||
      (revision !== undefined && revision !== 1)
    ) {
      return undefined
    }

    const rows = await this.#loadRows(ownerId, reportId)
    const row = rows[0]
    if (!row) return undefined
    if (rows.length !== 1) {
      throw new InconsistentTaxReportPublicationError()
    }
    if (
      revision === undefined &&
      !currentEligibilityFromRow(row, ownerId, reportId).eligible
    ) {
      throw new ReportAttestationPublicationIneligibleError()
    }
    // A route lookup omits revision and is allowed to prepare only the current
    // readable current report. The durable attestation store supplies revision 1
    // while hydrating an existing record, so a superseded immutable report can
    // still be verified after a newer report becomes current.
    return publicationFromRow(
      row,
      ownerId,
      reportId,
      revision === undefined,
    )
  }

  async #loadRows(
    ownerId: string,
    reportId: string,
  ): Promise<ActivatedTaxReportPublicationRow[]> {
    const result = await this.pool.query<ActivatedTaxReportPublicationRow>(
      `
        SELECT
          subject_id,
          report_id,
          tax_year,
          finality,
          status,
          filing_status,
          generation_id,
          generation_state,
          bound_report_pointer_version,
          report_model_v2_artifact_digest,
          evidence_pack_v2_artifact_digest,
          policy_artifact_digest,
          coverage_status,
          coverage_assurance,
          tax_year_close_status,
          calculated_as_of,
          is_current_report,
          is_current_tax_result,
          is_current_ledger_scope,
          is_current_source_coverage
        FROM reporting.activated_tax_report_read_v2
        WHERE subject_id = $1
          AND report_id = $2
        LIMIT 2
      `,
      [ownerId, reportId],
    )
    return result.rows
  }
}
