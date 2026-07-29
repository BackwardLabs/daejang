import type { Pool } from 'pg'

import type {
  CurrentTaxReport,
  ReportPaymentTaxReport,
  ReportPaymentTaxReportReader,
  TaxAmount,
  TaxReportFinality,
  TaxReportReader,
} from './types.js'

export class AmbiguousCurrentTaxReportError extends Error {}
export class InconsistentTaxReportError extends Error {}

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

  constructor(private readonly pool: Pool) {}

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
    return result.rows[0]
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
