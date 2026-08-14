import { describe, expect, it } from 'vitest'

import type { LedgerEventModel } from '../../api/productApi.ts'
import type { TaxReportV2DetailModel } from './taxReportApi.ts'
import { buildReportAssetPresentations } from './reportAssetPresentation.ts'

const report = {
  assetSummaries: [{ taxAssetId: 'asset:eip155:10:0x4200000000000000000000000000000000000006' }],
  disposals: [{
    taxAssetId: 'asset:eip155:10:0x4200000000000000000000000000000000000006',
    ledgerAssetId: 'ledger:weth:optimism',
  }],
  feeAssetDisposals: [],
  acquisitions: [],
  incomeRows: [],
} as unknown as TaxReportV2DetailModel

const ledgerEvent = (assetSymbol: string): LedgerEventModel => ({
  eventId: 'event-1',
  revisionId: 'revision-1',
  revisionNumber: 1,
  eventType: 'SWAP',
  flowShape: 'EXCHANGE',
  resolution: 'CONFIRMED',
  interpretationSupport: 'SUPPORTED',
  effectiveAt: '2026-01-01T00:00:00Z',
  postings: [{
    legId: 'leg-1',
    accountId: 'account-1',
    assetId: 'ledger:weth:optimism',
    occurredAt: '2026-01-01T00:00:00Z',
    direction: 'IN',
    quantity: '1000000000000000000',
    role: 'PRINCIPAL',
    fairValue: '0',
    costBasis: '0',
    denomination: 'KRW',
    assetSymbol,
    assetDecimals: 18,
    hasAssetDecimals: true,
  }],
})

describe('buildReportAssetPresentations', () => {
  it('binds persisted ledger metadata to the report tax asset', () => {
    expect(buildReportAssetPresentations(report, [ledgerEvent('WETH')])).toEqual({
      'asset:eip155:10:0x4200000000000000000000000000000000000006': {
        symbol: 'WETH',
        decimals: 18,
        metadata: '소수점 18자리',
      },
    })
  })

  it('does not expose suspicious combining-mark symbols', () => {
    expect(buildReportAssetPresentations(report, [ledgerEvent('ET\u0323H')]))
      .toEqual({})
  })

  it('uses the canonical chain native symbol instead of the storage sentinel', () => {
    const nativeReport = {
      ...report,
      assetSummaries: [{ taxAssetId: 'asset:eip155:10:native' }],
      disposals: [{
        taxAssetId: 'asset:eip155:10:native',
        ledgerAssetId: 'ledger:weth:optimism',
      }],
    } as unknown as TaxReportV2DetailModel

    expect(buildReportAssetPresentations(
      nativeReport,
      [ledgerEvent('NATIVE')],
    )['asset:eip155:10:native']?.symbol).toBe('ETH')
  })
})
