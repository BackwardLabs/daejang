import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  AmbiguousCurrentTaxReportError,
  InconsistentTaxReportError,
  PostgresTaxReportReader,
} from './postgres-tax-report-reader.js'

const reportRow = {
  report_id: 'report-1',
  tax_year: 2027,
  finality: 'FINAL',
  status: 'PARTIAL',
  filing_status: 'BLOCKED',
  denomination_asset_id: 'asset-krw',
  pointer_version: '2',
  issued_at: new Date('2028-01-10T00:00:00.000Z'),
  disposal_count: 1,
  transfer_count: 2,
  excluded_conversion_count: 3,
  limitation_count: 4,
  gain_loss_status: 'KNOWN',
  gain_loss_amount: '1200',
  taxable_base_status: 'UNKNOWN',
  taxable_base_amount: null,
  national_tax_status: 'UNKNOWN',
  national_tax_amount: null,
  local_tax_status: 'UNKNOWN',
  local_tax_amount: null,
  total_tax_status: 'UNKNOWN',
  total_tax_amount: null,
} as const

const readerWithRows = (rows: unknown[]) => {
  const query = vi.fn(async () => ({ rows }))
  return {
    query,
    reader: new PostgresTaxReportReader({ query } as unknown as Pool),
  }
}

describe('PostgresTaxReportReader', () => {
  it('reads one subject-scoped summary using only the two reporting tables', async () => {
    const { query, reader } = readerWithRows([reportRow])
    const report = await reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1')

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('reporting.current_tax_report')
    expect(sql).toContain('reporting.tax_report')
    expect(sql).not.toMatch(/(?:FROM|JOIN)\s+tax\./)
    expect(params).toEqual(['subject-1', 2027, 'FINAL', 'resident-1'])
    expect(report).toMatchObject({
      reportId: 'report-1',
      counts: { disposals: 1, transfers: 2 },
      summary: {
        gainLoss: { status: 'KNOWN', amount: '1200' },
        totalTax: { status: 'UNKNOWN' },
      },
    })
    expect(report).not.toHaveProperty('residentId')
    expect(report).not.toHaveProperty('taxInventoryRunId')
  })

  it('rejects an ambiguous current pointer instead of selecting another resident', async () => {
    const { reader } = readerWithRows([reportRow, reportRow])
    await expect(reader.getCurrent('subject-1', 2027, 'FINAL')).rejects.toBeInstanceOf(
      AmbiguousCurrentTaxReportError,
    )
  })

  it('rejects an amount whose status and persisted value disagree', async () => {
    const { reader } = readerWithRows([{
      ...reportRow,
      total_tax_status: 'UNKNOWN',
      total_tax_amount: '0',
    }])
    await expect(reader.getCurrent('subject-1', 2027, 'FINAL')).rejects.toBeInstanceOf(
      InconsistentTaxReportError,
    )
  })
})
