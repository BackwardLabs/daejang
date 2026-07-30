import { describe, expect, it } from 'vitest'
import {
  describeFlowShape,
  describeLedgerSource,
  describePostingDirection,
  describePostingRole,
  formatLedgerQuantity,
  parseLedgerAsset,
} from './ledgerPresentation.ts'

describe('ledger posting presentation', () => {
  it('parses CEX asset metadata from the durable asset identifier', () => {
    expect(parseLedgerAsset('cex-document-asset:upbit:decimal8:usdt')).toEqual({
      symbol: 'USDT',
      decimals: 8,
      metadata: 'Upbit · 소수점 8자리',
    })
    expect(parseLedgerAsset('asset:unmapped')).toEqual({ symbol: 'asset:unmapped' })
  })

  it('presents known EVM assets without inventing token metadata', () => {
    expect(parseLedgerAsset('asset:eip155:10:native')).toEqual({
      symbol: 'ETH',
      decimals: 18,
      metadata: 'Optimism · 네이티브 자산',
    })
    expect(parseLedgerAsset('asset:eip155:1:erc20:0x1234567890abcdef1234')).toEqual({
      symbol: '0x12345678…ef1234',
      metadata: 'Ethereum · 토큰 메타데이터 확인 필요',
    })
    expect(parseLedgerAsset('asset:eip155:137:native')).toEqual({
      symbol: 'asset:eip155:137:native',
      metadata: 'EVM 137 · 네이티브 자산 메타데이터 확인 필요',
    })
  })

  it('formats fixed-point quantities without converting them to Number', () => {
    expect(formatLedgerQuantity('180108722461', 8)).toBe('1,801.08722461')
    expect(formatLedgerQuantity('27016310000000', 8)).toBe('270,163.1')
    expect(formatLedgerQuantity('2701600000', 8)).toBe('27.016')
    expect(formatLedgerQuantity('-1', 18)).toBe('-0.000000000000000001')
  })

  it('explains posting directions and roles in product language', () => {
    expect(describePostingDirection('IN')).toBe('들어옴')
    expect(describePostingDirection('OUT')).toBe('나감')
    expect(describePostingRole('PRINCIPAL')).toMatchObject({ label: '주 거래' })
    expect(describePostingRole('FEE')).toMatchObject({ label: '거래 수수료' })
    expect(describeFlowShape('EXCHANGE')).toBe('자산 교환')
  })

  it('derives a visible source only from durable posting identifiers', () => {
    expect(describeLedgerSource([{
      accountId: 'account-upbit',
      assetId: 'cex-document-asset:upbit:decimal8:krw',
    }])).toEqual({ kind: 'CEX', label: 'Upbit', detail: 'account-upbit' })
    expect(describeLedgerSource([{
      accountId: 'wallet-1',
      assetId: 'asset:eip155:10:native',
    }])).toEqual({ kind: 'WALLET', label: 'Optimism', detail: 'wallet-1' })
  })
})
