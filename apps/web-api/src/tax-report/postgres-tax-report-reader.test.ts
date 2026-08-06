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
  generation_id: 'b'.repeat(64),
  state: 'ACTIVE',
  tax_year: 2027,
  outcome: 'REPORT',
  created_at: new Date('2028-01-09T00:00:00.000Z'),
  completed_at: new Date('2028-01-10T00:00:00.000Z'),
  blocked_reason_code: null,
  has_current_report: true,
} as const
const applicationPendingStatusRow = {
  subject_id: 'subject-1',
  generation_id: null,
  state: 'NOT_STARTED',
  tax_year: 2027,
  outcome: null,
  created_at: null,
  completed_at: null,
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

describe('PostgresTaxReportReader', () => {
  it('reads one subject-scoped summary using only the two reporting tables', async () => {
    const { query, reader } = readerWithRows([reportRow])
    const report = await reader.getCurrent('subject-1', 2027, 'FINAL', 'resident-1')

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('reporting.current_tax_report_read_v1')
    expect(sql).not.toMatch(/FROM\s+reporting\.current_tax_report\s/)
    expect(sql).toContain('reporting.activated_tax_report_read_v1')
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

  it('reads one subject-scoped status using only the Web-safe generation view', async () => {
    const { query, reader } = readerWithRows([generationStatusRow])
    const status = await reader.getGenerationStatus('subject-1', 2027)

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain(
      'reporting.current_tax_report_generation_status_read_v1',
    )
    expect(sql).not.toMatch(
      /(?:FROM|JOIN)\s+reporting\.(?:tax_report_generation|current_tax_report_generation|tax_report)\s/,
    )
    expect(params).toEqual(['subject-1', 2027])
    expect(status).toEqual({
      generationId: 'b'.repeat(64),
      state: 'ACTIVE',
      taxYear: 2027,
      outcome: 'REPORT',
      createdAt: '2028-01-09T00:00:00.000Z',
      completedAt: '2028-01-10T00:00:00.000Z',
      blockedReasonCode: null,
      hasCurrentReport: true,
    })
  })

  it('returns no status when the subject has no current generation', async () => {
    const { reader } = readerWithRows([])
    await expect(
      reader.getGenerationStatus('subject-1', 2025),
    ).resolves.toBeUndefined()
  })

  it('reads an explicit pointerless application-pending status', async () => {
    const { reader } = readerWithRows([applicationPendingStatusRow])

    await expect(
      reader.getGenerationStatus('subject-1', 2027),
    ).resolves.toEqual({
      generationId: null,
      state: 'NOT_STARTED',
      taxYear: 2027,
      outcome: null,
      createdAt: null,
      completedAt: null,
      blockedReasonCode: 'APPLICATION_PENDING',
      hasCurrentReport: false,
    })
  })

  it('reads an explicit pointerless not-started status', async () => {
    const { reader } = readerWithRows([{
      ...applicationPendingStatusRow,
      tax_year: 2025,
      blocked_reason_code: 'NOT_STARTED',
    }])

    await expect(
      reader.getGenerationStatus('subject-1', 2025),
    ).resolves.toMatchObject({
      generationId: null,
      state: 'NOT_STARTED',
      blockedReasonCode: 'NOT_STARTED',
    })
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
        reader.getGenerationStatus('subject-1', 2027),
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
