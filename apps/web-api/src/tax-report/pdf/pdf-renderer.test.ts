import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { loadPretendardFont } from './font.js'
import {
  formatReportAmount,
  renderTaxReportPdf,
} from './pdf-renderer.js'
import type { ReportPrintModelV1 } from './report-print-model.js'

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

const model = (
  overrides: Partial<ReportPrintModelV1> = {},
): ReportPrintModelV1 => ({
  schemaVersion: 'giwa.tax-report-print-model.v1',
  reportId: `tax-report:${digest('report')}`,
  reportModelDigest: digest('report-model'),
  inputDigest: digest('input'),
  evidencePackDigest: digest('evidence-pack'),
  taxYear: 2027,
  finality: 'FINAL',
  status: 'PARTIAL',
  filingStatus: 'BLOCKED',
  denominationAssetId: 'KRW',
  issuedAt: '2028-02-14T01:32:00.000Z',
  counts: {
    disposals: 1,
    transfers: 1,
    excludedConversions: 1,
    limitations: 1,
  },
  summary: {
    gainLoss: { status: 'KNOWN', amount: '12480000' },
    taxableBase: { status: 'UNKNOWN' },
    nationalTax: { status: 'UNKNOWN' },
    localTax: { status: 'UNKNOWN' },
    totalTax: { status: 'UNKNOWN' },
  },
  totals: {
    grossProceeds: { status: 'KNOWN', amount: '22500000' },
    acquisitionCost: { status: 'KNOWN', amount: '18000000' },
    ancillaryExpense: { status: 'KNOWN', amount: '0' },
    gainLoss: { status: 'KNOWN', amount: '12480000' },
  },
  assetSummaries: [{
    taxAssetId: 'BTC',
    disposalCount: 1,
    quantity: '25000000',
    grossProceeds: { status: 'KNOWN', amount: '22500000' },
    acquisitionCost: { status: 'KNOWN', amount: '18000000' },
    ancillaryExpense: { status: 'KNOWN', amount: '0' },
    gainLoss: { status: 'KNOWN', amount: '4500000' },
  }],
  disposals: [{
    movementId: 'movement:btc:1',
    eventId: 'event:btc:1',
    taxAssetId: 'BTC',
    ledgerAssetId: 'eip155:1/slip44:0',
    quantity: '0.25000000',
    grossProceeds: { status: 'KNOWN', amount: '22500000' },
    ancillaryExpense: { status: 'KNOWN', amount: '0' },
    basis: { status: 'KNOWN', amount: '18000000' },
    gainLoss: { status: 'KNOWN', amount: '4500000' },
    costMethod: 'FIFO',
    valuationId: 'valuation:btc:1',
  }],
  transfers: [{
    movementId: 'movement:eth:transfer:1',
    eventId: 'event:eth:transfer:1',
    taxAssetId: 'ETH',
    quantity: '1.20000000',
    basis: { status: 'UNKNOWN' },
    fromCostMethod: 'FIFO',
    toCostMethod: 'FIFO',
  }],
  excludedConversions: [{
    eventId: 'event:weth:1',
    relationId: 'relation:weth:1',
    taxAssetId: 'ETH',
    fromQuantity: '1',
    toQuantity: '1',
  }],
  limitations: [{
    code: 'PRICE_EVIDENCE_MISSING',
    reason: '가격 근거가 확정되지 않아 관련 금액을 미확정으로 유지했습니다.',
    taxAssetId: 'USDT',
    movementId: 'movement:usdt:1',
    reviewId: 'review:usdt:1',
    reviewRevisionId: 'review-revision:usdt:1',
  }],
  methodology: {
    taxInventoryRunId: 'tax-inventory:2027:1',
    taxEstimateId: 'tax-estimate:2027:1',
    lotRunId: 'lot-run:2027:1',
    generationId: 'generation:2027:1',
    schemaDigest: digest('schema'),
    policy: {
      name: 'giwa-korea-tax-policy',
      version: '2027.1',
      artifactDigest: digest('policy'),
    },
    engine: {
      name: 'daejang-tax-engine',
      version: '1.0.0',
      artifactDigest: digest('engine'),
    },
  },
  ...overrides,
})

describe('tax report PDF renderer', () => {
  it('renders deterministic Korean A4 PDF bytes for an exact report', async () => {
    const fontBytes = await loadPretendardFont()
    const input = model()

    const first = await renderTaxReportPdf(input, {
      fontBytes,
      rendererVersion: 'test-1',
    })
    const second = await renderTaxReportPdf(input, {
      fontBytes,
      rendererVersion: 'test-1',
    })

    expect(first.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(first.equals(second)).toBe(true)
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    )
    expect(first.byteLength).toBeGreaterThan(15_000)
  })

  it('keeps unknown amounts unknown instead of presenting zero', () => {
    expect(formatReportAmount({ status: 'UNKNOWN' }, 'KRW')).toBe('—')
    expect(formatReportAmount({ status: 'KNOWN', amount: '0' }, 'KRW')).toBe(
      '0 KRW',
    )
    expect(formatReportAmount(
      { status: 'KNOWN', amount: '-1234567.89' },
      'KRW',
    )).toBe('-1,234,567.89 KRW')
  })

  it('renders a deterministic 2026 PDF', async () => {
    const fontBytes = await loadPretendardFont()
    const input = model({ taxYear: 2026 })

    const first = await renderTaxReportPdf(input, {
      fontBytes,
      rendererVersion: 'test-simulation-1',
    })
    const second = await renderTaxReportPdf(input, {
      fontBytes,
      rendererVersion: 'test-simulation-1',
    })

    expect(first.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(first.equals(second)).toBe(true)
    expect(first.byteLength).toBeGreaterThan(15_000)
  })

  it('paginates a large disposal ledger', async () => {
    const fontBytes = await loadPretendardFont()
    const disposals = Array.from({ length: 120 }, (_, index) => ({
      ...model().disposals[0]!,
      movementId: `movement:btc:${index.toString().padStart(3, '0')}`,
      eventId: `event:btc:${index.toString().padStart(3, '0')}`,
    }))
    const output = await renderTaxReportPdf(
      model({
        counts: {
          ...model().counts,
          disposals: disposals.length,
        },
        disposals,
      }),
      { fontBytes },
    )
    const pageObjects = output.toString('latin1').match(/\/Type \/Page\b/g)

    expect(pageObjects?.length).toBeGreaterThan(3)
    expect(pageObjects?.length).toBeLessThan(15)
  })

  it('rejects a report with an invalid issuedAt', async () => {
    await expect(renderTaxReportPdf(
      model({ issuedAt: 'not-a-date' }),
      { fontBytes: await loadPretendardFont() },
    )).rejects.toThrow('issuedAt')
  })
})
