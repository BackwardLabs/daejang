import { describe, expect, it } from 'vitest'
import {
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
  })
})
