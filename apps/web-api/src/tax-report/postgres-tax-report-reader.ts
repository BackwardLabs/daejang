import type { Pool, PoolClient } from 'pg'

import type {
  CurrentTaxReport,
  ExcludedTaxConversion,
  TaxAmount,
  TaxDisposal,
  TaxLimitation,
  TaxReportFinality,
  TaxReportReader,
  TaxTransfer,
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
  tax_inventory_run_id: string
  tax_estimate_id: string
  lot_run_id: string
  input_digest: string
  schema_digest: string
  denomination_asset_id: string
  report_artifact_digest: string
  evidence_pack_digest: string
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

const optional = (value: string | null) => value ?? undefined

export class PostgresTaxReportReader implements TaxReportReader {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async getCurrent(
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ): Promise<CurrentTaxReport | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const report = await this.getReportRow(client, subjectId, taxYear, finality, residentId)
      if (!report) {
        await client.query('COMMIT')
        return undefined
      }

      const disposals = await this.getDisposals(client, subjectId, report.tax_inventory_run_id)
      const transfers = await this.getTransfers(client, subjectId, report.tax_inventory_run_id)
      const excludedConversions = await this.getExcludedConversions(
        client,
        subjectId,
        report.tax_inventory_run_id,
      )
      const limitations = await this.getLimitations(
        client,
        subjectId,
        report.tax_inventory_run_id,
      )
      if (
        disposals.length !== report.disposal_count ||
        transfers.length !== report.transfer_count ||
        excludedConversions.length !== report.excluded_conversion_count ||
        limitations.length !== report.limitation_count
      ) {
        throw new InconsistentTaxReportError('Tax report counts disagree with its inventory rows')
      }

      const pointerVersion = Number(report.pointer_version)
      if (!Number.isSafeInteger(pointerVersion) || pointerVersion < 1) {
        throw new InconsistentTaxReportError('Tax report pointer version is invalid')
      }
      const result: CurrentTaxReport = {
        schemaVersion: 'giwa.web.tax-report.v1',
        reportId: report.report_id,
        residentId: report.resident_id,
        taxYear: report.tax_year,
        finality: report.finality,
        status: report.status,
        filingStatus: report.filing_status,
        taxInventoryRunId: report.tax_inventory_run_id,
        taxEstimateId: report.tax_estimate_id,
        lotRunId: report.lot_run_id,
        inputDigest: report.input_digest,
        schemaDigest: report.schema_digest,
        denominationAssetId: report.denomination_asset_id,
        reportArtifactDigest: report.report_artifact_digest,
        evidencePackDigest: report.evidence_pack_digest,
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
        disposals,
        transfers,
        excludedConversions,
        limitations,
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async getReportRow(
    client: PoolClient,
    subjectId: string,
    taxYear: number,
    finality: TaxReportFinality,
    residentId?: string,
  ) {
    const result = await client.query<ReportRow>(
      `
        SELECT
          report.report_id,
          report.resident_id,
          report.tax_year,
          report.finality,
          report.status,
          report.filing_status,
          report.tax_inventory_run_id,
          report.tax_estimate_id,
          report.lot_run_id,
          report.input_digest,
          report.schema_digest,
          report.denomination_asset_id,
          report.report_artifact_digest,
          report.evidence_pack_digest,
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

  private async getDisposals(client: PoolClient, subjectId: string, runId: string) {
    const result = await client.query<{
      movement_id: string
      event_id: string
      revision_id: string
      leg_id: string
      tax_address_id: string
      tax_asset_id: string
      ledger_asset_id: string
      quantity: string
      proceeds_status: TaxAmount['status']
      gross_proceeds_amount: string | null
      ancillary_expense_status: TaxAmount['status']
      ancillary_expense_amount: string | null
      basis_status: TaxAmount['status']
      basis_amount: string | null
      gain_loss_amount: string | null
      valuation_id: string | null
      cost_method: string
      rounding: string | null
    }>(
      `SELECT movement_id,event_id,revision_id,leg_id,tax_address_id,tax_asset_id,ledger_asset_id,quantity::text,proceeds_status,gross_proceeds_amount::text,ancillary_expense_status,ancillary_expense_amount::text,basis_status,basis_amount::text,gain_loss_amount::text,valuation_id,cost_method,rounding FROM tax.disposal WHERE subject_id=$1 AND run_id=$2 ORDER BY movement_id`,
      [subjectId, runId],
    )
    return result.rows.map<TaxDisposal>((row) => ({
      movementId: row.movement_id,
      eventId: row.event_id,
      revisionId: row.revision_id,
      legId: row.leg_id,
      taxAddressId: row.tax_address_id,
      taxAssetId: row.tax_asset_id,
      ledgerAssetId: row.ledger_asset_id,
      quantity: row.quantity,
      grossProceeds: amount(row.proceeds_status, row.gross_proceeds_amount),
      ancillaryExpense: amount(row.ancillary_expense_status, row.ancillary_expense_amount),
      basis: amount(row.basis_status, row.basis_amount),
      gainLoss: amount(row.gain_loss_amount === null ? 'UNKNOWN' : 'KNOWN', row.gain_loss_amount),
      ...(row.valuation_id === null ? {} : { valuationId: row.valuation_id }),
      costMethod: row.cost_method,
      ...(row.rounding === null ? {} : { rounding: row.rounding }),
    }))
  }

  private async getTransfers(client: PoolClient, subjectId: string, runId: string) {
    const result = await client.query<{
      movement_id: string
      event_id: string
      revision_id: string
      from_leg_id: string
      to_leg_id: string
      from_address_id: string
      to_address_id: string
      tax_asset_id: string
      quantity: string
      basis_status: TaxAmount['status']
      basis_amount: string | null
      from_cost_method: string
      to_cost_method: string
    }>(
      `SELECT movement_id,event_id,revision_id,from_leg_id,to_leg_id,from_address_id,to_address_id,tax_asset_id,quantity::text,basis_status,basis_amount::text,from_cost_method,to_cost_method FROM tax.transfer WHERE subject_id=$1 AND run_id=$2 ORDER BY movement_id`,
      [subjectId, runId],
    )
    return result.rows.map<TaxTransfer>((row) => ({
      movementId: row.movement_id,
      eventId: row.event_id,
      revisionId: row.revision_id,
      fromLegId: row.from_leg_id,
      toLegId: row.to_leg_id,
      fromAddressId: row.from_address_id,
      toAddressId: row.to_address_id,
      taxAssetId: row.tax_asset_id,
      quantity: row.quantity,
      basis: amount(row.basis_status, row.basis_amount),
      fromCostMethod: row.from_cost_method,
      toCostMethod: row.to_cost_method,
    }))
  }

  private async getExcludedConversions(
    client: PoolClient,
    subjectId: string,
    runId: string,
  ) {
    const result = await client.query<{
      event_id: string
      revision_id: string
      relation_id: string
      tax_address_id: string
      tax_asset_id: string
      from_leg_id: string
      to_leg_id: string
      from_quantity: string
      to_quantity: string
    }>(
      `SELECT event_id,revision_id,relation_id,tax_address_id,tax_asset_id,from_leg_id,to_leg_id,from_quantity::text,to_quantity::text FROM tax.excluded_conversion WHERE subject_id=$1 AND run_id=$2 ORDER BY event_id,revision_id,relation_id`,
      [subjectId, runId],
    )
    return result.rows.map<ExcludedTaxConversion>((row) => ({
      eventId: row.event_id,
      revisionId: row.revision_id,
      relationId: row.relation_id,
      taxAddressId: row.tax_address_id,
      taxAssetId: row.tax_asset_id,
      fromLegId: row.from_leg_id,
      toLegId: row.to_leg_id,
      fromQuantity: row.from_quantity,
      toQuantity: row.to_quantity,
    }))
  }

  private async getLimitations(client: PoolClient, subjectId: string, runId: string) {
    const result = await client.query<{
      code: string
      tax_address_id: string | null
      tax_asset_id: string | null
      movement_id: string | null
      reason: string
    }>(
      `SELECT code,tax_address_id,tax_asset_id,movement_id,reason FROM tax.limitation WHERE subject_id=$1 AND run_id=$2 ORDER BY ordinal`,
      [subjectId, runId],
    )
    return result.rows.map<TaxLimitation>((row) => ({
      code: row.code,
      ...(optional(row.tax_address_id) ? { taxAddressId: row.tax_address_id as string } : {}),
      ...(optional(row.tax_asset_id) ? { taxAssetId: row.tax_asset_id as string } : {}),
      ...(optional(row.movement_id) ? { movementId: row.movement_id as string } : {}),
      reason: row.reason,
    }))
  }
}
