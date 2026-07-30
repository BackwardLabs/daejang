import { describe, expect, it } from 'vitest'
import {
  describeFlowShape,
  describeLedgerAction,
  describeLedgerSource,
  describePostingDirection,
  describePostingRole,
  describeTransferEndpoint,
  formatLedgerMoney,
  formatLedgerQuantity,
  formatLedgerUnitPrice,
  parseLedgerAsset,
} from './ledgerPresentation.ts'

describe('ledger posting presentation', () => {
  it('uses persisted CEX asset metadata before identifier compatibility parsing', () => {
    expect(parseLedgerAsset('asset-usdt-upbit', 'USDT', 8, 'upbit')).toEqual({
      symbol: 'USDT',
      decimals: 8,
      metadata: 'Upbit · 소수점 8자리',
    })
    expect(parseLedgerAsset('cex-document-asset:upbit:decimal8:usdt')).toEqual({
      symbol: 'USDT',
      decimals: 8,
      metadata: 'Upbit · 소수점 8자리',
    })
    expect(parseLedgerAsset('asset-krw-upbit')).toEqual({ symbol: 'asset-krw-upbit' })
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

  it('formats the transaction amount and derives the CEX statement unit price', () => {
    const postings = [
      {
        assetId: 'asset-usdt-upbit', assetSymbol: 'USDT', assetDecimals: 8,
        hasAssetDecimals: true, assetVenue: 'upbit', direction: 'IN',
        quantity: '180108722461', role: 'PRINCIPAL', denomination: 'asset-krw-upbit',
      },
      {
        assetId: 'asset-krw-upbit', assetSymbol: 'KRW', assetDecimals: 8,
        hasAssetDecimals: true, assetVenue: 'upbit', direction: 'OUT',
        quantity: '270163100000000', role: 'PRINCIPAL', denomination: 'asset-krw-upbit',
      },
      {
        assetId: 'asset-krw-upbit', assetSymbol: 'KRW', assetDecimals: 8,
        hasAssetDecimals: true, assetVenue: 'upbit', direction: 'OUT',
        quantity: '27016000000', role: 'FEE', denomination: 'asset-krw-upbit',
      },
    ]

    expect(formatLedgerMoney('270190116000000', 'asset-krw-upbit', postings)).toBe('2,701,901.16 KRW')
    expect(formatLedgerUnitPrice(postings[0]!, postings)).toBe('1,500 KRW / USDT')
    expect(formatLedgerUnitPrice(postings[1]!, postings)).toBe('—')
    expect(formatLedgerUnitPrice(postings[2]!, postings)).toBe('—')
  })

  it('explains posting directions and roles in product language', () => {
    expect(describePostingDirection('IN')).toBe('들어옴')
    expect(describePostingDirection('OUT')).toBe('나감')
    expect(describePostingRole('PRINCIPAL')).toMatchObject({ label: '주 거래' })
    expect(describePostingRole('FEE')).toMatchObject({ label: '거래 수수료' })
    expect(describeFlowShape('EXCHANGE')).toBe('자산 교환')
  })

  it('labels transfers as deposits or withdrawals from durable flow evidence', () => {
    expect(describeLedgerAction('TRANSFER', 'EXTERNAL_IN', [{
      direction: 'IN',
      role: 'PRINCIPAL',
    }])).toEqual({ label: '입금', description: '외부에서 들어온 자산' })
    expect(describeLedgerAction('TRANSFER', 'EXTERNAL_OUT', [{
      direction: 'OUT',
      role: 'PRINCIPAL',
    }])).toEqual({ label: '출금', description: '외부로 나간 자산' })
    expect(describeLedgerAction('TRANSFER', 'SELF_TRANSFER', [
      { direction: 'OUT', role: 'PRINCIPAL' },
      { direction: 'IN', role: 'PRINCIPAL' },
    ])).toEqual({ label: '내 계정 이동', description: '내 계정 간 이동' })
  })

  it('uses the statement activity for fiat, interest, and airdrop rows', () => {
    expect(describeLedgerAction('TRANSFER', 'FIAT_IN', [{ direction: 'IN' }])).toEqual({
      label: '원화 입금', description: '본인 원화 입금',
    })
    expect(describeLedgerAction('TRANSFER', 'FIAT_OUT', [{ direction: 'OUT' }])).toEqual({
      label: '원화 출금', description: '본인 원화 출금',
    })
    expect(describeLedgerAction('REWARD', 'DEPOSIT_INTEREST', [{ direction: 'IN' }])).toEqual({
      label: '예치금 이용료', description: '거래소 예치금 이용료',
    })
    expect(describeLedgerAction('REWARD', 'AIRDROP', [{ direction: 'IN' }])).toEqual({
      label: '에어드롭', description: '에어드롭 지급',
    })
  })

  it('uses material posting direction when a transfer flow shape is incomplete', () => {
    expect(describeLedgerAction('TRANSFER', 'UNKNOWN', [
      { direction: 'IN', role: 'PRINCIPAL' },
      { direction: 'OUT', role: 'FEE' },
    ])).toEqual({ label: '입금', description: '흐름 확인 필요' })
    expect(describeLedgerAction('TRANSFER', 'UNKNOWN', [
      { direction: 'OUT', role: 'PRINCIPAL' },
    ])).toEqual({ label: '출금', description: '흐름 확인 필요' })
    expect(describeLedgerAction('TRADE', 'EXCHANGE', [])).toEqual({
      label: '거래',
      description: '자산 교환',
    })
  })

  it('derives a visible source only from durable posting identifiers', () => {
    expect(describeLedgerSource([{
      accountId: 'account-upbit',
      assetId: 'cex-document-asset:upbit:decimal8:krw',
    }])).toEqual({ kind: 'CEX', label: 'Upbit', detail: 'account-upbit' })
    expect(describeLedgerSource([{
      accountId: 'cex-account:upbit:acb59c011f',
      assetId: 'asset-krw-upbit',
    }])).toEqual({ kind: 'CEX', label: 'Upbit', detail: 'cex-account:upbit:acb59c011f' })
    expect(describeLedgerSource([{
      accountId: 'wallet-1',
      assetId: 'asset:eip155:10:native',
    }])).toEqual({ kind: 'WALLET', label: 'Optimism', detail: 'wallet-1' })
  })

  it('presents a registered transfer counterpart as an owned-wallet candidate', () => {
    expect(describeTransferEndpoint([{ direction: 'IN', role: 'PRINCIPAL' }], {
      resolution: 'OWNED_REGISTERED',
      display: '0x123456…abcdef',
      addressFamily: 'EVM',
      chainCandidates: ['eip155:10'],
      connectionStatus: 'WALLET_OBSERVATION_PENDING',
      reviewRequired: true,
    })).toEqual({
      label: '보낸 곳',
      title: '내 등록 지갑',
      detail: '0x123456…abcdef · Optimism',
      status: '반대편 지갑 장부 확인 대기',
      tone: 'warning',
    })
  })

  it('keeps an absent transfer counterpart in review instead of inventing an external wallet', () => {
    expect(describeTransferEndpoint([{ direction: 'OUT', role: 'PRINCIPAL' }])).toEqual({
      label: '받는 곳',
      title: '확인 필요',
      detail: '상대 지갑 정보가 자료에 없습니다',
      status: '송신자·수신자 확인 필요',
      tone: 'warning',
    })
  })
})
