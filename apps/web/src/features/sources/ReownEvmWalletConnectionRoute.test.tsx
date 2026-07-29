import { act, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReownWalletLauncher } from './ReownEvmWalletConnectionRoute.tsx'

const reownMocks = vi.hoisted(() => ({
  caipAddress: undefined as string | undefined,
  disconnect: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  stateSubscriber: undefined as ((state: { open: boolean }) => void) | undefined,
}))

const registrationMocks = vi.hoisted(() => ({
  createWalletChallenge: vi.fn(),
  registerWalletSource: vi.fn(),
  signMessage: vi.fn(),
  verifyMessage: vi.fn(),
}))

vi.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: reownMocks.open }),
}))

vi.mock('ethers', () => ({
  BrowserProvider: class {
    async getSigner() {
      return { signMessage: registrationMocks.signMessage }
    }
  },
  verifyMessage: registrationMocks.verifyMessage,
}))

vi.mock('./sourceApi.ts', () => ({
  createWalletChallenge: registrationMocks.createWalletChallenge,
  registerWalletSource: registrationMocks.registerWalletSource,
}))

vi.mock('./reownAppKit.ts', () => ({
  isReownAppKitConfigured: true,
  reownAppKit: {
    getCaipAddress: () => reownMocks.caipAddress,
    getChainId: () => 1,
    getProvider: () => ({}),
    getState: () => ({ open: false }),
    subscribeState: (subscriber: (state: { open: boolean }) => void) => {
      reownMocks.stateSubscriber = subscriber
      return () => {
        reownMocks.stateSubscriber = undefined
      }
    },
    disconnect: reownMocks.disconnect,
  },
}))

describe('ReownWalletLauncher', () => {
  beforeEach(() => {
    reownMocks.caipAddress = undefined
    reownMocks.disconnect.mockClear()
    reownMocks.disconnect.mockImplementation(async () => {
      reownMocks.caipAddress = undefined
    })
    reownMocks.open.mockClear()
    reownMocks.stateSubscriber = undefined
    registrationMocks.createWalletChallenge.mockReset()
    registrationMocks.createWalletChallenge.mockResolvedValue({
      challengeId: 'challenge-1',
      message: 'Sign this Daejang wallet challenge',
      expiresAt: '2027-07-29T00:05:00.000Z',
    })
    registrationMocks.registerWalletSource.mockReset()
    registrationMocks.registerWalletSource.mockResolvedValue({ id: 'source-1' })
    registrationMocks.signMessage.mockReset()
    registrationMocks.signMessage.mockResolvedValue('0xsigned')
    registrationMocks.verifyMessage.mockReset()
    registrationMocks.verifyMessage.mockImplementation(() =>
      reownMocks.caipAddress?.split(':').at(-1),
    )
  })

  it('opens Reown without replacing the page behind the modal', async () => {
    const onConnected = vi.fn()

    const { container } = render(
      <ReownWalletLauncher onConnected={onConnected} />,
    )

    await waitFor(() => expect(reownMocks.open).toHaveBeenCalled())
    reownMocks.caipAddress =
      'eip155:1:0x1234567890abcdef1234567890abcdef12345678'

    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledWith({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        chainId: 'eip155:1',
        network: 'Ethereum',
        provider: 'walletconnect',
      })
    })
    expect(reownMocks.open).toHaveBeenCalledWith({
      namespace: 'eip155',
      view: 'Connect',
    })
    expect(registrationMocks.createWalletChallenge).toHaveBeenCalledWith({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 'eip155:1',
      signal: expect.any(AbortSignal),
    })
    expect(registrationMocks.signMessage).toHaveBeenCalledWith(
      'Sign this Daejang wallet challenge',
    )
    expect(registrationMocks.registerWalletSource).toHaveBeenCalledWith({
      challengeId: 'challenge-1',
      signature: '0xsigned',
      chainIds: ['eip155:1'],
      signal: expect.any(AbortSignal),
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('finishes registration and notifies the page in StrictMode', async () => {
    const onConnected = vi.fn()

    render(
      <StrictMode>
        <ReownWalletLauncher onConnected={onConnected} />
      </StrictMode>,
    )

    await waitFor(() => expect(reownMocks.open).toHaveBeenCalled())
    reownMocks.caipAddress =
      'eip155:1:0x1234567890abcdef1234567890abcdef12345678'

    await waitFor(() => {
      expect(registrationMocks.registerWalletSource).toHaveBeenCalledOnce()
      expect(onConnected).toHaveBeenCalledOnce()
    })
  })

  it('disconnects the previous EVM session before opening a new account connection', async () => {
    reownMocks.caipAddress =
      'eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const onConnected = vi.fn()

    render(<ReownWalletLauncher onConnected={onConnected} />)

    await waitFor(() => {
      expect(reownMocks.disconnect).toHaveBeenCalledWith('eip155')
      expect(reownMocks.open).toHaveBeenCalledWith({
        namespace: 'eip155',
        view: 'Connect',
      })
    })
    expect(reownMocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      reownMocks.open.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(onConnected).not.toHaveBeenCalled()

    reownMocks.caipAddress =
      'eip155:1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledWith({
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        chainId: 'eip155:1',
        network: 'Ethereum',
        provider: 'walletconnect',
      })
    })
  })

  it('treats closing the modal without a connection as cancellation', async () => {
    reownMocks.caipAddress = undefined
    const onCancelled = vi.fn()
    const onConnected = vi.fn()
    const onError = vi.fn()

    render(
      <ReownWalletLauncher
        onCancelled={onCancelled}
        onConnected={onConnected}
        onError={onError}
      />,
    )

    await waitFor(() => expect(reownMocks.open).toHaveBeenCalled())
    act(() => reownMocks.stateSubscriber?.({ open: true }))
    act(() => reownMocks.stateSubscriber?.({ open: false }))

    await waitFor(() => expect(onCancelled).toHaveBeenCalledOnce())
    expect(onConnected).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('catches a rejected wallet approval as cancellation', async () => {
    reownMocks.caipAddress = undefined
    reownMocks.open.mockRejectedValueOnce({ code: 4001 })
    const onCancelled = vi.fn()
    const onError = vi.fn()

    render(
      <ReownWalletLauncher
        onCancelled={onCancelled}
        onConnected={vi.fn()}
        onError={onError}
      />,
    )

    await waitFor(() => expect(onCancelled).toHaveBeenCalledOnce())
    expect(onError).not.toHaveBeenCalled()
  })

  it('returns to retry when the ownership signature is rejected', async () => {
    registrationMocks.signMessage.mockRejectedValueOnce({ code: 4001 })
    const onCancelled = vi.fn()
    const onConnected = vi.fn()

    render(
      <ReownWalletLauncher
        onCancelled={onCancelled}
        onConnected={onConnected}
      />,
    )

    await waitFor(() => expect(reownMocks.open).toHaveBeenCalled())
    reownMocks.caipAddress =
      'eip155:1:0xcccccccccccccccccccccccccccccccccccccccc'

    await waitFor(() => expect(onCancelled).toHaveBeenCalledOnce())
    expect(onConnected).not.toHaveBeenCalled()
    expect(registrationMocks.registerWalletSource).not.toHaveBeenCalled()
  })

})
