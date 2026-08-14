import { generateKeyPairSync, sign } from 'node:crypto'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  AmbiguousCurrentTaxReportError,
  canonicalCorrectionArtifact,
  CorrectionPendingError,
  InconsistentTaxReportGenerationStatusError,
  InconsistentTaxReportError,
  PostgresTaxReportReader,
} from './postgres-tax-report-reader.js'
import type {
  CorrectionQuarantineSnapshot,
  CorrectionQuarantineStore,
} from './types.js'

const reportRow = {
  report_id: 'report-1',
  resident_id: 'resident-1',
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
const generationStatusRow = {
  subject_id: 'subject-1',
  resident_id: 'resident-1',
  generation_id: 'b'.repeat(64),
  pointer_version: '2',
  state: 'ACTIVE',
  tax_year: 2027,
  finality: 'PROVISIONAL',
  outcome: 'REPORT',
  period_start: '2027-01-01',
  period_end: '2027-12-31',
  coverage_from: '2027-01-01',
  coverage_through: '2027-06-30',
  calculated_as_of: new Date('2027-07-01T00:00:00.000Z'),
  coverage_status: 'PARTIAL',
  coverage_assurance: 'DOCUMENT_METADATA_VERIFIED',
  coverage_declaration_id: 'coverage-1',
  tax_year_close_status: 'OPEN',
  source_coverage_interval_count: '1',
  source_coverage_summary_status: 'PARTIAL',
  source_coverage_snapshot: [{
    fragmentId: 'fragment-1', sourceArtifactId: 'source-1', coverageOrdinal: 0,
    sourceKind: 'FILE', systemName: 'Upbit', declaredFrom: '2027-01-01',
    declaredThrough: '2027-06-30', completeness: 'PARTIAL',
    assurance: 'DOCUMENT_METADATA_VERIFIED',
  }],
  created_at: new Date('2028-01-09T00:00:00.000Z'),
  completed_at: new Date('2028-01-10T00:00:00.000Z'),
  failed_at: null,
  failure_code: null,
  blocked_reason_code: null,
  has_current_report: true,
} as const
const applicationPendingStatusRow = {
  subject_id: 'subject-1',
  resident_id: 'resident-1',
  generation_id: null,
  pointer_version: '0',
  state: 'NOT_STARTED',
  tax_year: 2027,
  finality: 'PROVISIONAL',
  outcome: null,
  period_start: '2027-01-01',
  period_end: '2027-12-31',
  coverage_from: null,
  coverage_through: null,
  calculated_as_of: null,
  coverage_status: 'UNKNOWN',
  coverage_assurance: 'UNKNOWN',
  coverage_declaration_id: null,
  tax_year_close_status: 'OPEN',
  source_coverage_interval_count: '0',
  source_coverage_summary_status: 'UNKNOWN',
  source_coverage_snapshot: [],
  created_at: null,
  completed_at: null,
  failed_at: null,
  failure_code: null,
  blocked_reason_code: 'APPLICATION_PENDING',
  has_current_report: false,
} as const
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const receiptDigest = 'a'.repeat(64)

const signed = <T extends CorrectionQuarantineSnapshot['quarantine']['payload'] | CorrectionQuarantineSnapshot['currentPointer']['payload']>(payload: T) => ({
  keyId: 'tax-correction-1',
  payload,
  signature: sign(null, Buffer.from(canonicalCorrectionArtifact(payload)), privateKey).toString('base64url'),
})

const correctionSnapshot = (
  overrides: Partial<CorrectionQuarantineSnapshot['quarantine']['payload']> = {},
  pointerOverrides: Partial<CorrectionQuarantineSnapshot['currentPointer']['payload']> = {},
): CorrectionQuarantineSnapshot => ({
  quarantine: signed({
    artifactVersion: 1,
    subjectId: 'subject-1',
    taxYear: 2027,
    finality: 'FINAL',
    residentId: 'resident-1',
    reportId: 'report-1',
    status: 'PENDING',
    candidateEpoch: 2,
    correctionEpoch: 3,
    expiresAt: '2030-01-01T00:00:00.000Z',
    expectedCurrentPointerVersion: 2,
    ...overrides,
  }),
  currentPointer: signed({
    artifactVersion: 1,
    subjectId: 'subject-1',
    taxYear: 2027,
    finality: 'FINAL',
    residentId: 'resident-1',
    reportId: 'report-1',
    candidateEpoch: 2,
    correctionEpoch: 3,
    pointerVersion: 2,
    ...pointerOverrides,
  }),
})

const readerWithCorrection = (
  snapshot: CorrectionQuarantineSnapshot | undefined,
  now = new Date('2029-01-01T00:00:00.000Z'),
) => {
  const { query } = readerWithRows([reportRow])
  const store: CorrectionQuarantineStore = { get: vi.fn(async () => snapshot) }
  return {
    store,
    reader: new PostgresTaxReportReader(
      { query } as unknown as Pool,
      { store, trust: { publicKeys: new Map([['tax-correction-1', publicKey]]), now: () => now } },
    ),
  }
}

const readerWithRows = (rows: unknown[]) => {
  const query = vi.fn(async () => ({ rows }))
  return {
    query,
    reader: new PostgresTaxReportReader({ query } as unknown as Pool),
  }
}

const readerWithResultSequence = (...resultRows: unknown[][]) => {
  const query = vi.fn()
  for (const rows of resultRows) query.mockResolvedValueOnce({ rows })
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
    expect(sql).toContain('reporting.current_tax_report_read_v2')
    expect(sql).not.toMatch(/FROM\s+reporting\.current_tax_report\s/)
    expect(sql).not.toContain('reporting.activated_tax_report_read_v1')
    expect(sql).not.toMatch(/JOIN\s+reporting\.tax_report\s/)
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

  it('returns no current or payment report while the generation gate is closed', async () => {
    const { reader } = readerWithRows([])
    await expect(
      reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1'),
    ).resolves.toBeUndefined()
    await expect(
      reader.getCurrentForPayment('subject-1', 2027, 'FINAL', 'resident-1'),
    ).resolves.toBeUndefined()
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

  it('reads one explicit resident status using only the parameterized Web-safe contract', async () => {
    const { query, reader } = readerWithRows([generationStatusRow])
    const status = await reader.getGenerationStatus(
      'subject-1', 2027, 'PROVISIONAL', 'resident-1',
    )

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain(
      'reporting.tax_report_generation_status_v2',
    )
    expect(sql).toContain('period_start::text AS period_start')
    expect(sql).toContain('period_end::text AS period_end')
    expect(sql).toContain('coverage_from::text AS coverage_from')
    expect(sql).toContain('coverage_through::text AS coverage_through')
    expect(sql).not.toMatch(
      /(?:FROM|JOIN)\s+reporting\.(?:tax_report_generation|current_tax_report_generation|tax_report)\s/,
    )
    expect(params).toEqual(['subject-1', 'resident-1', 2027, 'PROVISIONAL'])
    expect(status).toEqual({
      generationId: 'b'.repeat(64),
      state: 'ACTIVE',
      taxYear: 2027,
      finality: 'PROVISIONAL',
      pointerVersion: 2,
      outcome: 'REPORT',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      coverageFrom: '2027-01-01',
      coverageThrough: '2027-06-30',
      calculatedAsOf: '2027-07-01T00:00:00.000Z',
      coverageStatus: 'PARTIAL',
      coverageAssurance: 'DOCUMENT_METADATA_VERIFIED',
      coverageDeclarationId: 'coverage-1',
      taxYearCloseStatus: 'OPEN',
      sourceCoverageIntervalCount: 1,
      sourceCoverageSummaryStatus: 'PARTIAL',
      sourceCoverageSnapshot: [{
        fragmentId: 'fragment-1', sourceArtifactId: 'source-1', coverageOrdinal: 0,
        sourceKind: 'FILE', systemName: 'Upbit', declaredFrom: '2027-01-01',
        declaredThrough: '2027-06-30', completeness: 'PARTIAL',
        assurance: 'DOCUMENT_METADATA_VERIFIED',
      }],
      createdAt: '2028-01-09T00:00:00.000Z',
      completedAt: '2028-01-10T00:00:00.000Z',
      failedAt: null,
      failureCode: null,
      blockedReasonCode: null,
      hasCurrentReport: true,
    })
  })

  it('returns NOT_STARTED when subject resident resolution has no scope', async () => {
    const { reader } = readerWithRows([{
      resident_id: '', resident_count: '0', eligibility_status: null,
    }])
    await expect(
      reader.getGenerationStatus('subject-1', 2025),
    ).resolves.toMatchObject({
      generationId: null,
      state: 'NOT_STARTED',
      finality: 'PROVISIONAL',
      blockedReasonCode: 'NOT_STARTED',
    })
  })

  it('returns subject-level APPLICATION_PENDING without a resident or report lookup', async () => {
    const { query, reader } = readerWithRows([{
      resident_id: '', resident_count: '0', eligibility_status: 'APPLICATION_PENDING',
    }])

    await expect(
      reader.getGenerationStatus('subject-1', 2027),
    ).resolves.toMatchObject({
      generationId: null,
      state: 'NOT_STARTED',
      taxYear: 2027,
      blockedReasonCode: 'APPLICATION_PENDING',
      hasCurrentReport: false,
    })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql] = query.mock.calls[0] as unknown as [string, unknown[]?]
    expect(sql).toContain(
      'reporting.tax_report_subject_resident_v2',
    )
  })

  it('reads an explicit pointerless not-started status', async () => {
    const { reader } = readerWithRows([{
      ...applicationPendingStatusRow,
      tax_year: 2025,
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      blocked_reason_code: 'NOT_STARTED',
    }])

    await expect(
      reader.getGenerationStatus('subject-1', 2025, 'PROVISIONAL', 'resident-1'),
    ).resolves.toMatchObject({
      generationId: null,
      state: 'NOT_STARTED',
      blockedReasonCode: 'NOT_STARTED',
    })
  })

  it('resolves exactly one resident before reading its parameterized status', async () => {
    const { query, reader } = readerWithResultSequence(
      [{ resident_id: 'resident-1', resident_count: '1', eligibility_status: 'ELIGIBLE' }],
      [generationStatusRow],
    )

    await expect(reader.getGenerationStatus('subject-1', 2027)).resolves.toMatchObject({
      state: 'ACTIVE', finality: 'PROVISIONAL', hasCurrentReport: true,
    })
    expect(query).toHaveBeenCalledTimes(2)
    const [resolverSql] = query.mock.calls[0] as unknown as [string, unknown[]?]
    const [statusSql] = query.mock.calls[1] as unknown as [string, unknown[]?]
    expect(resolverSql).toContain('tax_report_subject_resident_v2')
    expect(statusSql).toContain('tax_report_generation_status_v2')
  })

  it('fails with ambiguity when more than one resident is in scope', async () => {
    const { reader } = readerWithRows([{
      resident_id: 'resident-1', resident_count: '2', eligibility_status: 'ELIGIBLE',
    }])
    await expect(reader.getGenerationStatus('subject-1', 2027)).rejects.toBeInstanceOf(
      AmbiguousCurrentTaxReportError,
    )
  })

  it('fails closed for invalid status enums, nullability, or subject scope', async () => {
    const invalidRows = [
      { ...generationStatusRow, state: 'READY' },
      { ...generationStatusRow, outcome: null },
      { ...generationStatusRow, blocked_reason_code: 'UNKNOWN_REASON' },
      { ...generationStatusRow, subject_id: 'subject-2' },
      {
        ...generationStatusRow,
        state: 'BUILDING',
        outcome: null,
        completed_at: null,
        blocked_reason_code: null,
        has_current_report: false,
      },
      { ...applicationPendingStatusRow, generation_id: 'b'.repeat(64) },
      { ...applicationPendingStatusRow, created_at: new Date() },
      { ...applicationPendingStatusRow, blocked_reason_code: null },
    ]

    for (const row of invalidRows) {
      const { reader } = readerWithRows([row])
      await expect(
        reader.getGenerationStatus('subject-1', 2027, 'PROVISIONAL', 'resident-1'),
      ).rejects.toBeInstanceOf(InconsistentTaxReportGenerationStatusError)
    }
  })

  it('fails closed for tampered, expired, wrong-subject, stale, or wrong-pointer quarantine artifacts', async () => {
    const cases = [
      (() => {
        const snapshot = correctionSnapshot()
        snapshot.quarantine.signature = 'tampered'
        return snapshot
      })(),
      correctionSnapshot({ expiresAt: '2028-01-01T00:00:00.000Z' }),
      correctionSnapshot({ subjectId: 'subject-2' }),
      correctionSnapshot({}, { correctionEpoch: 4 }),
      correctionSnapshot({ expectedCurrentPointerVersion: 3 }),
    ]

    for (const snapshot of cases) {
      const { reader } = readerWithCorrection(snapshot)
      await expect(reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1')).rejects.toBeInstanceOf(
        CorrectionPendingError,
      )
    }
  })

  it('does not return a current report while a valid correction quarantine is pending', async () => {
    const { reader, store } = readerWithCorrection(correctionSnapshot())
    await expect(reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1')).rejects.toBeInstanceOf(
      CorrectionPendingError,
    )
    expect(store.get).toHaveBeenCalledWith({
      subjectId: 'subject-1',
      taxYear: 2027,
      finality: 'FINAL',
      residentId: 'resident-1',
    })
  })

  it('returns the report only after a signed receipt and matching current pointer release it', async () => {
    const { reader } = readerWithCorrection(correctionSnapshot(
      { status: 'RELEASED', finalCorrectionReceiptDigest: receiptDigest },
      { finalCorrectionReceiptDigest: receiptDigest },
    ))
    await expect(reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1')).resolves.toMatchObject({
      reportId: 'report-1',
      pointerVersion: 2,
    })
  })
})
