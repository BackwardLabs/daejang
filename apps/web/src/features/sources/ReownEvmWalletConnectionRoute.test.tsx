import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountCallback: undefined as ((state: any) => void) | undefined,
  caipAddress: 'eip155:1:0x1234567890abcdef1234567890abcdef12345678',
  close: vi.fn(),
  connect: vi.fn(),
  eventCallback: undefined as ((state: any) => void) | undefined,
  listSources: vi.fn(),
  modalOpen: false,
  open: vi.fn(),
  providerAccounts: [] as string[],
  providerRequest: vi.fn(),
  provider: 'other',
  stateCallback: undefined as ((state: any) => void) | undefined,
}))

vi.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ close: mocks.close, open: mocks.open }),
}))

vi.mock('@reown/appkit-wallet-button/react', () => ({
  useAppKitWallet: () => ({ connect: mocks.connect }),
}))

vi.mock('./reownAppKit.ts', () => ({
  isReownAppKitConfigured: true,
  reownAppKit: {
    getCaipAddress: () => mocks.caipAddress,
    getAccount: () => ({ isConnected: false }),
    getProvider: () => ({ request: mocks.providerRequest }),
    isOpen: () => mocks.modalOpen,
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
  mocks.modalOpen = true
  mocks.stateCallback?.({ open: true })
}

function selectCurrentWallet(
  caipAddress = mocks.caipAddress,
) {
  mocks.caipAddress = caipAddress
  mocks.providerAccounts = [caipAddress.split(':').at(-1)!]
  mocks.modalOpen = false
  mocks.stateCallback?.({ open: false })
  mocks.accountCallback?.({ caipAddress, isConnected: true })
}

describe('ReownEvmWalletConnectionRoute', () => {
  beforeEach(() => {
    mocks.accountCallback = undefined
    mocks.caipAddress =
      'eip155:1:0x1234567890abcdef1234567890abcdef12345678'
    mocks.eventCallback = undefined
    mocks.provider = 'other'
    mocks.stateCallback = undefined
    mocks.connect.mockReset()
    mocks.close.mockReset()
    mocks.close.mockResolvedValue(undefined)
    mocks.listSources.mockReset()
    mocks.listSources.mockResolvedValue({ items: [] })
    mocks.modalOpen = false
    mocks.open.mockReset()
    mocks.open.mockImplementation(async () => {
      openModal()
    })
    mocks.providerAccounts = []
    mocks.providerRequest.mockReset()
    mocks.providerRequest.mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === 'eth_accounts') return mocks.providerAccounts
        if (method === 'eth_chainId') return '0x1'
        throw new Error(`Unexpected provider method: ${method}`)
      },
    )
  })

  it('does not accept a persisted CAIP address before this attempt selects a wallet', async () => {
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))

    await act(async () => Promise.resolve())
    expect(mocks.listSources).toHaveBeenCalledTimes(1)
    expect(onLaunchFailed).not.toHaveBeenCalled()

    await act(async () => {
      selectCurrentWallet()
    })

    await waitFor(() => {
      expect(mocks.listSources).toHaveBeenCalledTimes(2)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })

  it('treats closing the picker without a new selection as cancellation', async () => {
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
      mocks.modalOpen = false
      mocks.stateCallback?.({ open: false })
    })

    await waitFor(() => {
      expect(onLaunchFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: { code: 'CONNECTION_REJECTED' },
          ok: false,
        }),
      )
    }, { timeout: 2_000 })
    expect(mocks.listSources).toHaveBeenCalledTimes(1)
  })

  it('reports another explicitly selected wallet when that address is already active', async () => {
    const secondCaipAddress =
      'eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    mocks.listSources.mockResolvedValue({
      items: [
        {
          address: mocks.caipAddress.split(':').at(-1),
          status: 'ACTIVE',
          type: 'EVM_WALLET',
        },
        {
          address: secondCaipAddress.split(':').at(-1),
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
    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      selectCurrentWallet(secondCaipAddress)
    })

    await waitFor(() => {
      expect(onAlreadyConnected).toHaveBeenCalledTimes(1)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })

  it('keeps the existing session and waits for another account from the same wallet', async () => {
    mocks.listSources.mockResolvedValue({
      items: [
        {
          address: mocks.caipAddress.split(':').at(-1),
          status: 'ACTIVE',
          type: 'EVM_WALLET',
        },
      ],
    })
    const onAlreadyConnected = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onAlreadyConnected={onAlreadyConnected}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledTimes(1)
    })
    expect(onAlreadyConnected).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()

    await act(async () => {
      selectCurrentWallet(
        'eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      )
    })

    await waitFor(() => {
      expect(mocks.listSources).toHaveBeenCalledTimes(2)
    })
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(onAlreadyConnected).not.toHaveBeenCalled()
  })

  it('keeps the direct wallet happy path after an explicit connect click', async () => {
    mocks.provider = 'metamask'
    const onLaunchFailed = vi.fn()

    render(
      <ReownEvmWalletConnectionRoute
        launchImmediately
        onLaunchFailed={onLaunchFailed}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-wallet'))

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith('metamask')
      expect(mocks.listSources).toHaveBeenCalledTimes(2)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })
})
