import { generateKeyPairSync, sign } from 'node:crypto'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  AmbiguousCurrentTaxReportError,
  canonicalCorrectionArtifact,
  CorrectionPendingError,
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
