import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { loadPretendardFont } from './font.js'
import {
  formatCostMethod,
  formatReportAmount,
  reportCalculationKeyValues,
  reportDocumentPresentation,
  reportStatusKeyValues,
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
  taxYearCloseStatus: 'UNVERIFIED',
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
    calculationContract: 'ANNUAL_TOTAL_AVERAGE',
    calculationRule: {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET',
      costMethods: ['ANNUAL_TOTAL_AVERAGE'],
      basicDeductionAmount: '2500000',
      deductionUsedAmount: '2500000',
      nationalRate: { numerator: '20', denominator: '100' },
      localRate: { numerator: '2', denominator: '100' },
      taxRounding: 'FLOOR',
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    },
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
    costMethod: 'ANNUAL_TOTAL_AVERAGE',
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
    expect(formatReportAmount({ status: 'UNKNOWN' }, 'KRW')).toBe(
      '미확정(0원이 아님)',
    )
    expect(formatReportAmount({ status: 'KNOWN', amount: '0' }, 'KRW')).toBe(
      '0 KRW',
    )
    expect(formatReportAmount(
      { status: 'KNOWN', amount: '-1234567.89' },
      'KRW',
    )).toBe('-1,234,567.89 KRW')
  })

  it('labels report readiness without claiming that filing is complete', () => {
    const base = model()
    const readyModel = model({
      finality: 'FINAL',
      status: 'FINAL',
      filingStatus: 'READY',
      taxYearCloseStatus: 'CLOSED',
      counts: { ...base.counts, limitations: 0 },
      summary: {
        ...base.summary,
        taxableBase: { status: 'KNOWN', amount: '9980000' },
        nationalTax: { status: 'KNOWN', amount: '1996000' },
        localTax: { status: 'KNOWN', amount: '199600' },
        totalTax: { status: 'KNOWN', amount: '2195600' },
      },
      transfers: base.transfers.map((transfer) => ({
        ...transfer,
        basis: { status: 'KNOWN' as const, amount: '1000000' },
      })),
      limitations: [],
    })
    const ready = reportDocumentPresentation(readyModel)
    expect(ready).toEqual({
      kind: '신고 준비 자료',
      title: '2027년 가상자산 신고 준비 자료',
      description:
        'Tax Engine에서 확정 계산과 차단 항목 없음을 판정한 자료입니다. 원화 단위와 세액 적합성은 별도 검토가 필요하며, 실제 신고 제출 또는 세무서 접수 완료를 뜻하지 않습니다.',
    })
    expect(reportStatusKeyValues(readyModel)).toContainEqual([
      '신고 준비 상태',
      'READY · 엔진상 차단 항목 없음',
    ])
    expect(reportDocumentPresentation(model())).toMatchObject({
      kind: '검토 자료',
      title: '2027년 가상자산 세금 계산 검토 자료',
    })
    expect(reportDocumentPresentation(model({
      finality: 'FINAL',
      status: 'FINAL',
      filingStatus: 'READY',
    }))).toMatchObject({
      kind: '검토 자료',
    })
    expect(reportDocumentPresentation({
      ...readyModel,
      summary: {
        ...readyModel.summary,
        calculationRule: {
          poolScope: readyModel.summary.calculationRule!.poolScope,
          costMethods: readyModel.summary.calculationRule!.costMethods,
          basicDeductionAmount:
            readyModel.summary.calculationRule!.basicDeductionAmount,
          nationalRate: readyModel.summary.calculationRule!.nationalRate,
          localRate: readyModel.summary.calculationRule!.localRate,
          taxRounding: readyModel.summary.calculationRule!.taxRounding,
          basisAllocationRounding:
            readyModel.summary.calculationRule!.basisAllocationRounding,
        },
      },
    })).toMatchObject({
      kind: '검토 자료',
    })
    expect(reportDocumentPresentation(model({ taxYear: 2026 }))).toMatchObject({
      kind: '정책 시뮬레이션 검토 자료',
    })
    expect(reportStatusKeyValues(model())).toEqual([
      ['평가 입력', 'FINAL · 평가 입력 확정'],
      ['연간 마감', 'UNVERIFIED · 연간 입력 마감 미확인'],
      ['결과 완결성', 'PARTIAL · 일부 계산 항목 미확정'],
      ['신고 준비 상태', 'BLOCKED · 엔진상 차단 항목 있음'],
      ['현재 용도', '검토 자료'],
      ['제한사항', '1건'],
      ['별도 확인', '원화 단위와 세액 적합성'],
    ])
  })

  it('keeps legacy and unsupported cost methods in review', () => {
    const base = model()
    for (const calculationContract of ['LEGACY', 'UNSUPPORTED'] as const) {
      const presentation = reportDocumentPresentation(model({
        finality: 'FINAL',
        status: 'FINAL',
        filingStatus: 'READY',
        summary: {
          gainLoss: base.summary.gainLoss,
          taxableBase: base.summary.taxableBase,
          nationalTax: base.summary.nationalTax,
          localTax: base.summary.localTax,
          totalTax: base.summary.totalTax,
          calculationContract,
        },
      }))

      expect(presentation.kind).toBe('검토 자료')
      expect(presentation.description).toContain(
        '총평균법 원가 방식이 확인되지 않아',
      )
    }
  })

  it('shows annual total-average in Korean while preserving its identifier', () => {
    expect(formatCostMethod('ANNUAL_TOTAL_AVERAGE')).toBe(
      '연간 총평균법 (ANNUAL_TOTAL_AVERAGE)',
    )
    expect(formatCostMethod('UNRECOGNIZED_METHOD')).toBe(
      'UNRECOGNIZED_METHOD',
    )
  })

  it('prints only calculation fields supplied by the report model', () => {
    expect(reportCalculationKeyValues(model())).toEqual([
      [
        '원가 방식 판정',
        '원가 방식: 연간 총평균법 (ANNUAL_TOTAL_AVERAGE)',
      ],
      ['계산 범위', '거주자 × 과세연도 × 과세자산'],
      [
        '취득원가 계산 방식',
        '연간 총평균법 (ANNUAL_TOTAL_AVERAGE)',
      ],
      ['기본공제', '2,500,000 KRW'],
      ['실제 적용 공제', '2,500,000 KRW'],
      ['국세율', '20% (20/100)'],
      ['지방세율', '2% (2/100)'],
      ['세액 반올림', '절사 (FLOOR)'],
      [
        '취득원가 배분 반올림',
        '연간 총평균 누적 배분 절사 (CUMULATIVE_FLOOR_ANNUAL_POOL)',
      ],
    ])

    const base = model()
    const withoutRule = model({
      summary: {
        gainLoss: base.summary.gainLoss,
        taxableBase: base.summary.taxableBase,
        nationalTax: base.summary.nationalTax,
        localTax: base.summary.localTax,
        totalTax: base.summary.totalTax,
      },
    })
    expect(reportCalculationKeyValues(withoutRule)).toEqual([])
  })

  it('formats canonical Upbit KRW atomic amounts as KRW', () => {
    expect(formatReportAmount(
      { status: 'KNOWN', amount: '368786100000000' },
      'asset-krw-upbit',
    )).toBe('3,687,861 KRW')
    expect(formatReportAmount(
      { status: 'KNOWN', amount: '1' },
      'asset-krw-upbit',
    )).toBe('0.00000001 KRW')
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
