import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  caipAddress: 'eip155:1:0x1234567890abcdef1234567890abcdef12345678',
  connect: vi.fn(),
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
    mocks.caipAddress =
      'eip155:1:0x1234567890abcdef1234567890abcdef12345678'
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
    expect(mocks.listSources).not.toHaveBeenCalled()
    expect(onLaunchFailed).not.toHaveBeenCalled()

    await act(async () => {
      selectCurrentWallet()
    })

    await waitFor(() => {
      expect(mocks.listSources).toHaveBeenCalledTimes(1)
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
    await act(async () => {
      mocks.stateCallback?.({ open: false })
    })

    await waitFor(() => {
      expect(onLaunchFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: { code: 'CONNECTION_REJECTED' },
          ok: false,
        }),
      )
    })
    expect(mocks.listSources).not.toHaveBeenCalled()
  })

  it('reports an already-active wallet immediately after explicit selection', async () => {
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
      expect(mocks.listSources).toHaveBeenCalledTimes(1)
    })
    expect(onLaunchFailed).not.toHaveBeenCalled()
  })
})
