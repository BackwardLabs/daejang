import { describe, expect, it } from 'vitest'
import {
  createEvmWalletIntentKey,
  evmWalletFlowReducer,
  initialEvmWalletFlowState,
  maskEvmAddress,
  normalizeEvmWalletPeriod,
  validateEvmWalletPeriodDraft,
  type CompleteWalletConnectionSuccess,
  type ConnectedWallet,
  type EvmWalletFlowState,
} from './evmWalletFlow.ts'
import {
  completeWalletConnectionTestFixture as completeWalletConnectionMock,
  connectWalletTestFixture as connectWalletMock,
  requestOwnershipSignatureTestFixture as requestOwnershipSignatureMock,
} from './evmWalletFlow.test-fixtures.ts'

const connectedWallet: ConnectedWallet = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  chainId: 'eip155:1',
  network: 'Ethereum',
  provider: 'rabby',
}

function advanceToOwnershipReady() {
  let state: EvmWalletFlowState = evmWalletFlowReducer(
    initialEvmWalletFlowState,
    {
      provider: connectedWallet.provider,
      type: 'PROVIDER_SELECTED',
    },
  )
  state = evmWalletFlowReducer(state, { type: 'CONNECT_STARTED' })

  return evmWalletFlowReducer(state, {
    type: 'CONNECT_SUCCEEDED',
    wallet: connectedWallet,
  })
}

function advanceToScopeEditing() {
  let state = advanceToOwnershipReady()
  state = evmWalletFlowReducer(state, {
    type: 'SIGNATURE_STARTED',
  })

  return evmWalletFlowReducer(state, {
    type: 'SIGNATURE_SUCCEEDED',
    verificationId: 'verification-1',
  })
}

describe('evmWalletFlowReducer', () => {
  it('moves a connected wallet through ownership, scope, and backfilling', () => {
    let state = advanceToScopeEditing()

    expect(state).toMatchObject({
      chainIds: ['eip155:1', 'eip155:10'],
      error: null,
      intentKey: null,
      period: {
        endDate: '2026-07-28',
        mode: 'CUSTOM',
        startDate: '2026-07-28',
      },
      status: 'EDITING',
      verificationId: 'verification-1',
      view: 'scope',
      wallet: connectedWallet,
    })

    state = evmWalletFlowReducer(state, {
      period: {
        endDate: '2027-06-30',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      },
      type: 'PERIOD_CHANGED',
    })
    state = evmWalletFlowReducer(state, {
      intentKey: 'intent-wallet-1',
      type: 'SCOPE_SUBMIT_STARTED',
    })

    expect(state).toMatchObject({
      intentKey: 'intent-wallet-1',
      status: 'SUBMITTING',
      view: 'scope',
    })

    const result: CompleteWalletConnectionSuccess = {
      jobId: 'job-wallet-1',
      jobStatus: 'BACKFILLING',
      normalizedPeriod: {
        endDate: '2027-06-30',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      },
      ok: true,
      sourceId: 'source-wallet-1',
      sourceStatus: 'SOURCE_SAVED',
    }
    state = evmWalletFlowReducer(state, {
      result,
      type: 'SCOPE_SUBMIT_SUCCEEDED',
    })

    expect(state).toEqual({
      addressPreview: '0x1234…5678',
      chainIds: ['eip155:1', 'eip155:10'],
      jobId: 'job-wallet-1',
      normalizedPeriod: result.normalizedPeriod,
      provider: 'rabby',
      sourceId: 'source-wallet-1',
      sourceStatus: 'SOURCE_SAVED',
      status: 'BACKFILLING',
      view: 'complete',
    })
    expect('wallet' in state).toBe(false)
    expect('verificationId' in state).toBe(false)
  })

  it('requires at least one supported collection network', () => {
    let state = advanceToScopeEditing()
    state = evmWalletFlowReducer(state, {
      chainIds: [],
      type: 'CHAIN_SCOPES_CHANGED',
    })
    state = evmWalletFlowReducer(state, {
      intentKey: 'intent-without-network',
      type: 'SCOPE_SUBMIT_STARTED',
    })

    expect(state).toMatchObject({
      chainIds: [],
      error: { code: 'CHAIN_SCOPE_INVALID' },
      status: 'EDITING',
      view: 'scope',
    })
  })

  it('supports connection, ownership, and scope retries without changing the same intent', () => {
    let state: EvmWalletFlowState = evmWalletFlowReducer(
      initialEvmWalletFlowState,
      {
        provider: 'rabby',
        type: 'PROVIDER_SELECTED',
      },
    )
    state = evmWalletFlowReducer(state, { type: 'CONNECT_STARTED' })
    state = evmWalletFlowReducer(state, {
      error: { code: 'CONNECTION_REJECTED' },
      type: 'CONNECT_FAILED',
    })

    expect(state).toMatchObject({
      error: { code: 'CONNECTION_REJECTED' },
      provider: 'rabby',
      status: 'SELECTING',
      view: 'select',
    })

    state = evmWalletFlowReducer(state, { type: 'CONNECT_STARTED' })
    state = evmWalletFlowReducer(state, {
      type: 'CONNECT_SUCCEEDED',
      wallet: connectedWallet,
    })
    state = evmWalletFlowReducer(state, {
      type: 'SIGNATURE_STARTED',
    })
    state = evmWalletFlowReducer(state, {
      error: { code: 'SIGNATURE_REJECTED' },
      type: 'SIGNATURE_FAILED',
    })

    expect(state).toMatchObject({
      error: { code: 'SIGNATURE_REJECTED' },
      status: 'REJECTED',
      view: 'ownership',
    })

    state = evmWalletFlowReducer(state, {
      type: 'SIGNATURE_STARTED',
    })
    state = evmWalletFlowReducer(state, {
      type: 'SIGNATURE_SUCCEEDED',
      verificationId: 'verification-retry',
    })
    state = evmWalletFlowReducer(state, {
      intentKey: 'intent-stable',
      type: 'SCOPE_SUBMIT_STARTED',
    })
    state = evmWalletFlowReducer(state, {
      error: {
        code: 'SOURCE_SAVE_FAILED',
        requestId: 'request-safe-1',
      },
      type: 'SCOPE_SUBMIT_FAILED',
    })

    expect(state).toMatchObject({
      error: {
        code: 'SOURCE_SAVE_FAILED',
        requestId: 'request-safe-1',
      },
      intentKey: 'intent-stable',
      status: 'EDITING',
      view: 'scope',
    })

    state = evmWalletFlowReducer(state, {
      intentKey: 'intent-must-not-replace-retry',
      type: 'SCOPE_SUBMIT_STARTED',
    })
    expect(state).toMatchObject({
      intentKey: 'intent-stable',
      status: 'SUBMITTING',
      view: 'scope',
    })
  })

  it('supports back and reset while pending and stale actions remain no-ops', () => {
    const staleConnectSuccess = evmWalletFlowReducer(
      initialEvmWalletFlowState,
      {
        type: 'CONNECT_SUCCEEDED',
        wallet: connectedWallet,
      },
    )
    expect(staleConnectSuccess).toBe(initialEvmWalletFlowState)

    let state: EvmWalletFlowState = evmWalletFlowReducer(
      initialEvmWalletFlowState,
      {
        provider: 'metamask',
        type: 'PROVIDER_SELECTED',
      },
    )
    state = evmWalletFlowReducer(state, { type: 'CONNECT_STARTED' })
    const mismatchedWalletResult = evmWalletFlowReducer(state, {
      type: 'CONNECT_SUCCEEDED',
      wallet: connectedWallet,
    })
    expect(mismatchedWalletResult).toBe(state)

    state = evmWalletFlowReducer(state, { type: 'BACK_REQUESTED' })
    expect(state).toMatchObject({
      provider: 'metamask',
      status: 'SELECTING',
      view: 'select',
    })

    state = advanceToOwnershipReady()
    state = evmWalletFlowReducer(state, { type: 'SIGNATURE_STARTED' })
    const signingBackResult = evmWalletFlowReducer(state, {
      type: 'BACK_REQUESTED',
    })
    expect(signingBackResult).toBe(state)

    const staleScopeSuccess = evmWalletFlowReducer(state, {
      result: {
        jobId: 'stale-job',
        jobStatus: 'BACKFILLING',
        normalizedPeriod: normalizeEvmWalletPeriod({
          mode: 'TAX_YEAR',
          taxYear: '2027',
        }),
        ok: true,
        sourceId: 'stale-source',
        sourceStatus: 'SOURCE_SAVED',
      },
      type: 'SCOPE_SUBMIT_SUCCEEDED',
    })
    expect(staleScopeSuccess).toBe(state)

    expect(
      evmWalletFlowReducer(state, { type: 'RESET' }),
    ).toBe(initialEvmWalletFlowState)
  })

  it('returns from scope to ownership and clears invalid submission errors when edited', () => {
    let state = advanceToScopeEditing()
    state = evmWalletFlowReducer(state, {
      period: {
        endDate: '2027-01-01',
        mode: 'CUSTOM',
        startDate: '2027-02-01',
      },
      type: 'PERIOD_CHANGED',
    })
    state = evmWalletFlowReducer(state, {
      intentKey: 'unused-intent',
      type: 'SCOPE_SUBMIT_STARTED',
    })

    expect(state).toMatchObject({
      error: {
        code: 'PERIOD_INVALID',
        fieldErrors: {
          endDate: 'START_AFTER_END',
          startDate: 'START_AFTER_END',
        },
      },
      intentKey: null,
      status: 'EDITING',
      view: 'scope',
    })

    state = evmWalletFlowReducer(state, {
      period: {
        endDate: '2027-12-31',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      },
      type: 'PERIOD_CHANGED',
    })
    expect(state).toMatchObject({
      error: null,
      intentKey: null,
    })

    state = evmWalletFlowReducer(state, { type: 'BACK_REQUESTED' })
    expect(state).toMatchObject({
      error: null,
      status: 'READY',
      view: 'ownership',
      wallet: connectedWallet,
    })
  })
})

describe('EVM wallet period validation and normalization', () => {
  it('accepts the allowed tax years and normalizes their inclusive ranges', () => {
    expect(
      validateEvmWalletPeriodDraft({
        mode: 'TAX_YEAR',
        taxYear: '2027',
      }),
    ).toBeNull()
    expect(
      validateEvmWalletPeriodDraft({
        mode: 'TAX_YEAR',
        taxYear: '2026',
      }),
    ).toBeNull()
    expect(
      normalizeEvmWalletPeriod({
        mode: 'TAX_YEAR',
        taxYear: '2026',
      }),
    ).toEqual({
      endDate: '2026-12-31',
      mode: 'TAX_YEAR',
      startDate: '2026-01-01',
      taxYear: '2026',
    })
  })

  it('rejects unsupported tax years, invalid dates, reversed ranges, and future dates', () => {
    expect(
      validateEvmWalletPeriodDraft({
        mode: 'TAX_YEAR',
        taxYear: '2028',
      }),
    ).toMatchObject({
      code: 'PERIOD_INVALID',
      fieldErrors: { taxYear: 'NOT_ALLOWED' },
    })
    expect(
      validateEvmWalletPeriodDraft({
        endDate: '2027-02-30',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      }),
    ).toMatchObject({
      fieldErrors: { endDate: 'INVALID_FORMAT' },
    })
    expect(
      validateEvmWalletPeriodDraft({
        endDate: '2027-03-01',
        mode: 'CUSTOM',
        startDate: '2027-04-01',
      }),
    ).toMatchObject({
      fieldErrors: {
        endDate: 'START_AFTER_END',
        startDate: 'START_AFTER_END',
      },
    })
    expect(
      validateEvmWalletPeriodDraft({
        endDate: '2028-01-01',
        mode: 'CUSTOM',
        startDate: '2027-12-31',
      }),
    ).toMatchObject({
      fieldErrors: { endDate: 'AFTER_LATEST_ALLOWED_DATE' },
    })
  })

  it('allows at most one inclusive calendar year', () => {
    expect(
      validateEvmWalletPeriodDraft({
        endDate: '2026-12-31',
        mode: 'CUSTOM',
        startDate: '2026-01-01',
      }),
    ).toBeNull()
    expect(
      validateEvmWalletPeriodDraft({
        endDate: '2027-01-01',
        mode: 'CUSTOM',
        startDate: '2026-01-01',
      }),
    ).toMatchObject({
      code: 'PERIOD_INVALID',
      fieldErrors: { endDate: 'EXCEEDS_MAX_PERIOD' },
    })
  })
})

describe('EVM wallet flow helpers and test adapters', () => {
  it('masks full addresses and creates non-empty intent keys', () => {
    expect(maskEvmAddress(connectedWallet.address)).toBe(
      '0x1234…5678',
    )
    expect(maskEvmAddress('0x1234')).toBe('0x1234')

    const firstIntentKey = createEvmWalletIntentKey()
    const secondIntentKey = createEvmWalletIntentKey()
    expect(firstIntentKey).not.toHaveLength(0)
    expect(secondIntentKey).not.toHaveLength(0)
    expect(secondIntentKey).not.toBe(firstIntentKey)
  })

  it('runs the abortable mock connection without retaining a raw signature', async () => {
    const controller = new AbortController()
    const connection = await connectWalletMock({
      provider: 'walletconnect',
      signal: controller.signal,
    })
    expect(connection).toEqual({
      ok: true,
      wallet: {
        address: connectedWallet.address,
        chainId: 'eip155:1',
        network: 'Ethereum',
        provider: 'walletconnect',
      },
    })
    if (!connection.ok) {
      throw new Error('Expected the mock wallet connection to succeed.')
    }

    const ownership = await requestOwnershipSignatureMock({
      signal: controller.signal,
      wallet: connection.wallet,
    })
    expect(ownership).toEqual({
      ok: true,
      verificationId: 'verification-test',
    })
    expect('signature' in ownership).toBe(false)
    if (!ownership.ok) {
      throw new Error('Expected mock ownership verification to succeed.')
    }

    await expect(
      completeWalletConnectionMock({
        chainIds: ['eip155:1', 'eip155:10'],
        intentKey: 'intent-mock-1',
        period: {
          endDate: '2027-06-30',
          mode: 'CUSTOM',
          startDate: '2027-01-01',
        },
        signal: controller.signal,
        verificationId: ownership.verificationId,
        wallet: connection.wallet,
      }),
    ).resolves.toMatchObject({
      jobStatus: 'BACKFILLING',
      normalizedPeriod: {
        endDate: '2027-06-30',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      },
      ok: true,
      sourceStatus: 'SOURCE_SAVED',
    })
  })

  it('rejects adapter work when its signal is aborted', async () => {
    const controller = new AbortController()
    const connectionPromise = connectWalletMock({
      provider: 'coinbase',
      signal: controller.signal,
    })
    controller.abort()

    await expect(connectionPromise).rejects.toMatchObject({
      name: 'AbortError',
    })

    await expect(
      requestOwnershipSignatureMock({
        signal: controller.signal,
        wallet: connectedWallet,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })

    await expect(
      completeWalletConnectionMock({
        chainIds: ['eip155:1', 'eip155:10'],
        intentKey: 'intent-aborted',
        period: {
          mode: 'TAX_YEAR',
          taxYear: '2027',
        },
        signal: controller.signal,
        verificationId: 'verification-aborted',
        wallet: connectedWallet,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
