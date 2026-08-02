import { describe, expect, it } from 'vitest'
import type { LedgerEventModel, LedgerPostingModel } from '../../api/productApi.ts'
import { projectLedgerTransactions } from './ledgerProjection.ts'

const posting = (
  legId: string,
  role: string,
  overrides: Partial<LedgerPostingModel> = {},
): LedgerPostingModel => ({
  legId,
  accountId: 'wallet:subject',
  assetId: 'asset:eip155:10:native',
  occurredAt: '2026-07-26T08:29:01Z',
  direction: 'OUT',
  quantity: '200000000000000',
  role,
  fairValue: '',
  costBasis: '',
  denomination: '',
  ...overrides,
})

const event = (
  eventId: string,
  overrides: Partial<LedgerEventModel> = {},
): LedgerEventModel => ({
  eventId,
  revisionId: `${eventId}:revision`,
  revisionNumber: 1,
  eventType: 'TRANSFER',
  flowShape: 'UNKNOWN',
  resolution: 'PARTIAL',
  interpretationSupport: 'OBJECTIVE_ONLY',
  effectiveAt: '2026-07-26T08:29:01Z',
  postings: [],
  ...overrides,
})

describe('ledger transaction projection', () => {
  it('uses the ActionProof event as the canonical transaction row and keeps distinct fee evidence', () => {
    const principal = posting('objective-principal', 'PRINCIPAL')
    const result = projectLedgerTransactions([
      event('objective', {
        chainId: '10',
        transactionHash: '0xABC',
        transactionCoordinate: 'EXACT',
        postings: [principal, posting('gas', 'GAS', { quantity: '123' })],
      }),
      event('proof', {
        eventType: 'STAKE',
        subtype: 'LENDING_SUPPLY',
        flowShape: 'POSITION_CHANGE',
        resolution: 'RESOLVED',
        interpretationSupport: 'ACTION_PROOF',
        chainId: '10',
        transactionHash: '0xabc',
        transactionCoordinate: 'EXACT',
        actionProofId: 'proof-1',
        actionProfileId: 'aave-v3.supply',
        actionProfileVersion: '1.0.0',
        postings: [posting('proof-principal', 'PRINCIPAL')],
      }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      eventId: 'proof',
      subtype: 'LENDING_SUPPLY',
      actionProfileId: 'aave-v3.supply',
      projectionKey: 'evm:10:0xabc',
      sourceEvents: [
        { eventId: 'proof', revisionId: 'proof:revision' },
        { eventId: 'objective', revisionId: 'objective:revision' },
      ],
      projectedActions: [{
        eventId: 'proof',
        actionProofId: 'proof-1',
        actionProfileId: 'aave-v3.supply',
      }],
    })
    expect(result[0]?.postings.map(({ role }) => role)).toEqual(['PRINCIPAL', 'GAS'])
  })

  it('does not collapse ambiguous, missing, or CEX transaction coordinates', () => {
    const result = projectLedgerTransactions([
      event('ambiguous-1', { transactionCoordinate: 'AMBIGUOUS' }),
      event('ambiguous-2', { transactionCoordinate: 'AMBIGUOUS' }),
      event('missing', { transactionCoordinate: 'MISSING' }),
      event('cex', { transactionCoordinate: 'NOT_APPLICABLE' }),
    ])

    expect(result.map(({ eventId }) => eventId)).toEqual([
      'ambiguous-1',
      'ambiguous-2',
      'missing',
      'cex',
    ])
  })

  it('keeps every proven action when one transaction contains multiple actions', () => {
    const shared = {
      chainId: '10',
      transactionHash: '0xmulti',
      transactionCoordinate: 'EXACT',
      resolution: 'RESOLVED',
    }
    const result = projectLedgerTransactions([
      event('proof-a', {
        ...shared,
        actionProofId: 'proof-a',
        actionProfileId: 'profile-a',
      }),
      event('proof-b', {
        ...shared,
        actionProofId: 'proof-b',
        actionProfileId: 'profile-b',
      }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.projectedActions?.map(({ actionProfileId }) => actionProfileId)).toEqual([
      'profile-a',
      'profile-b',
    ])
  })

  it('preserves repeated equal-value legs while collapsing duplicate event projections', () => {
    const shared = {
      chainId: '10',
      transactionHash: '0xrepeated',
      transactionCoordinate: 'EXACT',
    }
    const result = projectLedgerTransactions([
      event('proof', {
        ...shared,
        actionProofId: 'proof-1',
        postings: [posting('proof-principal', 'PRINCIPAL')],
      }),
      event('objective', {
        ...shared,
        postings: [
          posting('objective-principal-1', 'PRINCIPAL'),
          posting('objective-principal-2', 'PRINCIPAL'),
        ],
      }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.postings.map(({ legId }) => legId)).toEqual([
      'objective-principal-1',
      'objective-principal-2',
    ])
  })
})
