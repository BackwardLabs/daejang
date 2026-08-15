import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  caipAddress: 'eip155:1:0x1234567890abcdef1234567890abcdef12345678' as
    | string
    | undefined,
  connect: vi.fn(),
  accountCallback: undefined as ((state: any) => void) | undefined,
  eventCallback: undefined as ((state: any) => void) | undefined,
  listSources: vi.fn(),
  open: vi.fn(),
  provider: 'other',
  stateCallback: undefined as ((state: any) => void) | undefined,
}))

vi.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: mocks.open }),
}))

vi.mock('@reown/appkit-wallet-button/react', () => ({
  useAppKitWallet: () => ({ connect: mocks.connect }),
}))

vi.mock('./reownAppKit.ts', () => ({
  isReownAppKitConfigured: true,
  reownAppKit: {
    getCaipAddress: () => mocks.caipAddress,
    getProvider: vi.fn(),
    subscribeAccount: (callback: (state: any) => void) => {
      mocks.accountCallback = callback
      return vi.fn()
    },
    subscribeEvents: (callback: (state: any) => void) => {
      mocks.eventCallback = callback
      return vi.fn()
    },
    subscribeState: (callback: (state: any) => void) => {
      mocks.stateCallback = callback
      return vi.fn()
    },
  },
}))

vi.mock('./sourceApi.ts', () => ({
  createSyncJob: vi.fn(),
  createWalletChallenge: vi.fn(),
  listSources: mocks.listSources,
  registerWalletSource: vi.fn(),
  watchSyncJob: vi.fn(),
}))

vi.mock('./EvmWalletConnectionPage.tsx', () => ({
  EvmWalletConnectionPage: (props: {
    autoConnectProvider?: string
    connectWallet: (request: {
      provider: string
      signal: AbortSignal
    }) => Promise<unknown>
    onInitialConnectionResult?: (result: unknown) => void
  }) => (
    <button
      data-testid="connect-wallet"
      type="button"
      onClick={async () => {
        const result = await props.connectWallet({
          provider: mocks.provider,
          signal: new AbortController().signal,
        })
        props.onInitialConnectionResult?.(result)
      }}
    >
      connect
    </button>
  ),
}))

import { ReownEvmWalletConnectionRoute } from './ReownEvmWalletConnectionRoute.tsx'

function openModal() {
  mocks.stateCallback?.({ open: true })
}

function selectCurrentWallet() {
  mocks.eventCallback?.({ data: { event: 'SELECT_WALLET' } })
  mocks.stateCallback?.({ open: false })
}

describe('ReownEvmWalletConnectionRoute', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'ethereum')
    mocks.caipAddress =
      'eip155:1:0x1234567890abcdef1234567890abcdef12345678'
    mocks.accountCallback = undefined
    mocks.eventCallback = undefined
    mocks.provider = 'other'
    mocks.stateCallback = undefined
    mocks.connect.mockReset()
    mocks.listSources.mockReset()
    mocks.listSources.mockResolvedValue({ items: [] })
    mocks.open.mockReset()
    mocks.open.mockImplementation(async () => {
      openModal()
    })
  })

  it('opens Reown even when an old account remains in its cache', async () => {
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      selectCurrentWallet()
    })

    await waitFor(() => {
      expect(mocks.listSources).toHaveBeenCalledTimes(1)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })

  it('returns to source selection when the Reown picker is cancelled', async () => {
    mocks.caipAddress = undefined
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))
    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      mocks.stateCallback?.({ open: false })
    })

    await waitFor(() => {
      expect(onLaunchFailed).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false }),
      )
    }, { timeout: 2_000 })
    expect(mocks.listSources).not.toHaveBeenCalled()
  })

  it('uses allAccounts when Reown discards its caipAddress cache', async () => {
    mocks.caipAddress = undefined
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))
    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      selectCurrentWallet()
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
    expect(mocks.listSources).not.toHaveBeenCalled()

    await act(async () => {
      mocks.accountCallback?.({
        allAccounts: [
          {
            address: '0x1234567890abcdef1234567890abcdef12345678',
            caipAddress:
              'eip155:1:0x1234567890abcdef1234567890abcdef12345678',
            chainId: 1,
            namespace: 'eip155',
          },
        ],
        caipAddress: undefined,
        isConnected: false,
      })
    })

    await waitFor(() => {
      expect(mocks.listSources).toHaveBeenCalledTimes(1)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })

  it('reports an already-active wallet immediately after explicit selection', async () => {
    mocks.listSources.mockResolvedValue({
      items: [
        {
          address: mocks.caipAddress!.split(':').at(-1),
          status: 'ACTIVE',
          type: 'EVM_WALLET',
        },
      ],
    })
    const onAlreadyConnected = vi.fn()
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onAlreadyConnected={onAlreadyConnected}
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))
    await act(async () => {
      selectCurrentWallet()
    })

    await waitFor(() => {
      expect(onAlreadyConnected).toHaveBeenCalledTimes(1)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })

})
