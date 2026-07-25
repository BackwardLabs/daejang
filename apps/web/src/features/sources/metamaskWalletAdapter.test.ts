import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  connectMetaMaskWallet,
  requestMetaMaskOwnershipSignature,
  subscribeToMetaMaskSession,
  type Eip1193RequestArguments,
  type MetaMaskProvider,
} from './metamaskWalletAdapter.ts'

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const SECOND_ADDRESS =
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const PERSONAL_SIGNATURE = `0x${'ab'.repeat(65)}`
const ETHEREUM_MAINNET_CHAIN_ID = '0x1'

type ProviderListener = (...arguments_: unknown[]) => void

function decodeHexUtf8(value: string) {
  const bytes = new Uint8Array(
    Array.from(
      { length: (value.length - 2) / 2 },
      (_, index) =>
        Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
    ),
  )

  return new TextDecoder().decode(bytes)
}

function createProvider(
  handleRequest: (
    arguments_: Eip1193RequestArguments,
  ) => Promise<unknown>,
) {
  const listeners = new Map<string, Set<ProviderListener>>()
  const request = vi.fn(handleRequest)
  const on = vi.fn(
    (eventName: string, listener: ProviderListener) => {
      const eventListeners =
        listeners.get(eventName) ?? new Set<ProviderListener>()
      eventListeners.add(listener)
      listeners.set(eventName, eventListeners)
    },
  )
  const removeListener = vi.fn(
    (eventName: string, listener: ProviderListener) => {
      listeners.get(eventName)?.delete(listener)
    },
  )
  const provider: MetaMaskProvider = {
    isMetaMask: true,
    on,
    removeListener,
    request,
  }

  return {
    emit(eventName: string, value: unknown) {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(value)
      }
    },
    on,
    provider,
    removeListener,
    request,
  }
}

const announcementCleanups: Array<() => void> = []

function announceMetaMask(provider: MetaMaskProvider) {
  function handleRequest() {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { rdns: 'io.metamask' },
          provider,
        },
      }),
    )
  }

  window.addEventListener('eip6963:requestProvider', handleRequest)
  announcementCleanups.push(() => {
    window.removeEventListener(
      'eip6963:requestProvider',
      handleRequest,
    )
  })
}

function removeLegacyProvider() {
  Object.defineProperty(window, 'ethereum', {
    configurable: true,
    value: undefined,
    writable: true,
  })
}

beforeEach(() => {
  removeLegacyProvider()
})

afterEach(() => {
  for (const cleanup of announcementCleanups.splice(0)) {
    cleanup()
  }
  removeLegacyProvider()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MetaMask wallet adapter', () => {
  it('maps a missing extension to PROVIDER_UNAVAILABLE', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const connection = connectMetaMaskWallet({
      provider: 'metamask',
      signal: controller.signal,
    })

    await vi.runAllTimersAsync()

    await expect(connection).resolves.toEqual({
      error: { code: 'PROVIDER_UNAVAILABLE' },
      ok: false,
    })
  })

  it('ignores an injected provider result that arrives after abort', async () => {
    const pendingAccounts: {
      resolve?: (accounts: readonly string[]) => void
    } = {}
    const injected = createProvider(async ({ method }) => {
      if (method === 'eth_requestAccounts') {
        return await new Promise<readonly string[]>((resolve) => {
          pendingAccounts.resolve = resolve
        })
      }
      return ETHEREUM_MAINNET_CHAIN_ID
    })
    announceMetaMask(injected.provider)
    const controller = new AbortController()

    const connection = connectMetaMaskWallet({
      provider: 'metamask',
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(injected.request).toHaveBeenCalledWith({
        method: 'eth_requestAccounts',
      })
    })

    controller.abort()
    await expect(connection).rejects.toMatchObject({
      name: 'AbortError',
    })

    pendingAccounts.resolve?.([ADDRESS])
    await Promise.resolve()

    await expect(
      requestMetaMaskOwnershipSignature({
        signal: new AbortController().signal,
        wallet: {
          address: ADDRESS,
          chainId: 'eip155:1',
          network: 'Ethereum',
          provider: 'metamask',
        },
      }),
    ).resolves.toEqual({
      error: { code: 'SIGNATURE_FAILED' },
      ok: false,
    })
  })

  it('connects through an EIP-6963 MetaMask announcement', async () => {
    const injected = createProvider(async ({ method }) => {
      if (
        method === 'eth_requestAccounts' ||
        method === 'eth_accounts'
      ) {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return '0x1'
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)

    await expect(
      connectMetaMaskWallet({
        provider: 'metamask',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: true,
      wallet: {
        address: ADDRESS,
        chainId: 'eip155:1',
        network: 'Ethereum',
        provider: 'metamask',
      },
    })
    expect(injected.request).toHaveBeenNthCalledWith(1, {
      method: 'eth_requestAccounts',
    })
    expect(injected.request).toHaveBeenNthCalledWith(2, {
      method: 'eth_chainId',
    })
    expect(injected.request).toHaveBeenNthCalledWith(3, {
      method: 'eth_accounts',
    })
  })

  it('uses the legacy injected-provider fallback and maps rejection', async () => {
    const injected = createProvider(async () => {
      throw { code: 4001, message: 'User rejected the request.' }
    })
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: injected.provider,
      writable: true,
    })

    await expect(
      connectMetaMaskWallet({
        provider: 'metamask',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      error: { code: 'CONNECTION_REJECTED' },
      ok: false,
    })
  })

  it('switches a non-mainnet provider to Ethereum mainnet', async () => {
    let chainId = '0xaa36a7'
    const injected = createProvider(async ({ method, params }) => {
      if (
        method === 'eth_requestAccounts' ||
        method === 'eth_accounts'
      ) {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return chainId
      }
      if (method === 'wallet_switchEthereumChain') {
        expect(params).toEqual([{ chainId: '0x1' }])
        chainId = '0x1'
        return null
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)

    await expect(
      connectMetaMaskWallet({
        provider: 'metamask',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      wallet: { chainId: 'eip155:1', network: 'Ethereum' },
    })
    expect(injected.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    })
    expect(
      injected.request.mock.calls.filter(
        ([arguments_]) => arguments_.method === 'eth_chainId',
      ),
    ).toHaveLength(2)
  })

  it('uses the active account after switching to Ethereum mainnet', async () => {
    let chainId = '0xaa36a7'
    let account = ADDRESS
    const injected = createProvider(async ({ method }) => {
      if (method === 'eth_requestAccounts') {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return chainId
      }
      if (method === 'wallet_switchEthereumChain') {
        chainId = '0x1'
        account = SECOND_ADDRESS
        return null
      }
      if (method === 'eth_accounts') {
        return [account]
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)

    await expect(
      connectMetaMaskWallet({
        provider: 'metamask',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      wallet: {
        address: SECOND_ADDRESS,
        chainId: 'eip155:1',
      },
    })
  })

  it('rejects a provider that remains off mainnet after switching', async () => {
    const injected = createProvider(async ({ method }) => {
      if (method === 'eth_requestAccounts') {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return '0xaa36a7'
      }
      if (method === 'wallet_switchEthereumChain') {
        return null
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)

    await expect(
      connectMetaMaskWallet({
        provider: 'metamask',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      error: { code: 'UNSUPPORTED_NETWORK' },
      ok: false,
    })
  })

  it('builds a five-minute ownership challenge for personal_sign', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-03-10T12:00:00.000Z'))
    const injected = createProvider(async ({ method }) => {
      if (
        method === 'eth_requestAccounts' ||
        method === 'eth_accounts'
      ) {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return '0x1'
      }
      if (method === 'personal_sign') {
        return PERSONAL_SIGNATURE
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)
    const controller = new AbortController()
    const connection = await connectMetaMaskWallet({
      provider: 'metamask',
      signal: controller.signal,
    })
    if (!connection.ok) {
      throw new Error('Expected MetaMask to connect.')
    }

    const ownership = await requestMetaMaskOwnershipSignature({
      signal: controller.signal,
      wallet: connection.wallet,
    })

    expect(ownership).toMatchObject({
      ok: true,
      proofMode: 'CLIENT_PREVIEW',
    })
    expect(ownership).not.toHaveProperty('signature')
    expect(JSON.stringify(ownership)).not.toContain(PERSONAL_SIGNATURE)

    const personalSignCall = injected.request.mock.calls.find(
      ([arguments_]) => arguments_.method === 'personal_sign',
    )
    expect(personalSignCall).toBeDefined()
    const personalSignArguments = personalSignCall?.[0]
    expect(personalSignArguments?.params).toEqual([
      expect.stringMatching(/^0x[0-9a-f]+$/),
      ADDRESS,
    ])

    const personalSignParams = personalSignArguments?.params
    if (!Array.isArray(personalSignParams)) {
      throw new Error('Expected personal_sign positional parameters.')
    }
    const encodedMessage = personalSignParams[0]
    if (typeof encodedMessage !== 'string') {
      throw new Error('Expected a hex-encoded personal_sign message.')
    }
    const message = decodeHexUtf8(encodedMessage)
    expect(message).toContain(window.location.host)
    expect(message).toContain(ADDRESS)
    expect(message).toContain(`URI: ${window.location.origin}`)
    expect(message).toContain('Version: 1')
    expect(message).toContain('Chain ID: 1')
    expect(message).toMatch(/Nonce: [0-9a-f]{32}/)
    expect(message).toContain(
      'Issued At: 2027-03-10T12:00:00.000Z',
    )
    expect(message).toContain(
      'Expiration Time: 2027-03-10T12:05:00.000Z',
    )
  })

  it('rejects a signature when the account changes while signing', async () => {
    let accountReadCount = 0
    const injected = createProvider(async ({ method }) => {
      if (method === 'eth_requestAccounts') {
        return [ADDRESS]
      }
      if (method === 'eth_accounts') {
        accountReadCount += 1
        return accountReadCount < 3 ? [ADDRESS] : [SECOND_ADDRESS]
      }
      if (method === 'eth_chainId') {
        return '0x1'
      }
      if (method === 'personal_sign') {
        return PERSONAL_SIGNATURE
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)
    const controller = new AbortController()
    const connection = await connectMetaMaskWallet({
      provider: 'metamask',
      signal: controller.signal,
    })
    if (!connection.ok) {
      throw new Error('Expected MetaMask to connect.')
    }

    await expect(
      requestMetaMaskOwnershipSignature({
        signal: controller.signal,
        wallet: connection.wallet,
      }),
    ).resolves.toEqual({
      error: { code: 'SIGNATURE_ADDRESS_MISMATCH' },
      ok: false,
    })
  })

  it('rejects a signature when the chain changes while signing', async () => {
    let chainReadCount = 0
    const injected = createProvider(async ({ method }) => {
      if (
        method === 'eth_requestAccounts' ||
        method === 'eth_accounts'
      ) {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        chainReadCount += 1
        return chainReadCount < 3 ? '0x1' : '0xaa36a7'
      }
      if (method === 'personal_sign') {
        return PERSONAL_SIGNATURE
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)
    const controller = new AbortController()
    const connection = await connectMetaMaskWallet({
      provider: 'metamask',
      signal: controller.signal,
    })
    if (!connection.ok) {
      throw new Error('Expected MetaMask to connect.')
    }

    await expect(
      requestMetaMaskOwnershipSignature({
        signal: controller.signal,
        wallet: connection.wallet,
      }),
    ).resolves.toEqual({
      error: { code: 'SIGNATURE_FAILED' },
      ok: false,
    })
  })

  it('forwards session events and removes every listener on cleanup', async () => {
    const injected = createProvider(async ({ method }) => {
      if (
        method === 'eth_requestAccounts' ||
        method === 'eth_accounts'
      ) {
        return [ADDRESS]
      }
      if (method === 'eth_chainId') {
        return '0x1'
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    announceMetaMask(injected.provider)
    await connectMetaMaskWallet({
      provider: 'metamask',
      signal: new AbortController().signal,
    })

    const onAccountsChanged = vi.fn()
    const onChainChanged = vi.fn()
    const onDisconnect = vi.fn()
    const cleanup = subscribeToMetaMaskSession({
      onAccountsChanged,
      onChainChanged,
      onDisconnect,
    })

    injected.emit('accountsChanged', [SECOND_ADDRESS])
    injected.emit('chainChanged', '0xaa36a7')
    const disconnectError = { code: 4900 }
    injected.emit('disconnect', disconnectError)

    expect(onAccountsChanged).toHaveBeenCalledWith([SECOND_ADDRESS])
    expect(onChainChanged).toHaveBeenCalledWith('0xaa36a7')
    expect(onDisconnect).toHaveBeenCalledWith(disconnectError)

    cleanup()
    cleanup()
    injected.emit('accountsChanged', [ADDRESS])
    injected.emit('chainChanged', '0x1')
    injected.emit('disconnect', null)

    expect(onAccountsChanged).toHaveBeenCalledTimes(1)
    expect(onChainChanged).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(injected.removeListener).toHaveBeenCalledTimes(3)
  })
})
