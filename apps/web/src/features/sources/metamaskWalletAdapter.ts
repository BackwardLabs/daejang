import type {
  ConnectWallet,
  EvmWalletConnectionError,
  EvmWalletOwnershipError,
  RequestOwnershipSignature,
} from './evmWalletFlow.ts'

const ETHEREUM_MAINNET_CHAIN_ID = '0x1'
const EIP155_ETHEREUM_MAINNET_CHAIN_ID = 'eip155:1'
const SIGNATURE_TTL_MS = 5 * 60 * 1_000
const EIP6963_DISCOVERY_TIMEOUT_MS = 100

export type Eip1193RequestArguments = {
  method: string
  params?: object | readonly unknown[]
}

type Eip1193Listener = (...arguments_: unknown[]) => void

export type MetaMaskProvider = {
  isMetaMask?: boolean
  off?: (eventName: string, listener: Eip1193Listener) => void
  on?: (eventName: string, listener: Eip1193Listener) => void
  providers?: readonly MetaMaskProvider[]
  removeListener?: (
    eventName: string,
    listener: Eip1193Listener,
  ) => void
  request: (arguments_: Eip1193RequestArguments) => Promise<unknown>
}

type Eip6963ProviderDetail = {
  info?: {
    rdns?: string
  }
  provider?: MetaMaskProvider
}

export type MetaMaskSessionHandlers = {
  onAccountsChanged?: (accounts: readonly string[]) => void
  onChainChanged?: (chainId: string) => void
  onDisconnect?: (error: unknown) => void
}

let activeMetaMaskProvider: MetaMaskProvider | null = null

function createAbortError() {
  return new DOMException(
    'The MetaMask wallet request was aborted.',
    'AbortError',
  )
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw createAbortError()
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    let settled = false

    function finish(callback: () => void) {
      if (settled) {
        return
      }

      settled = true
      signal.removeEventListener('abort', handleAbort)
      callback()
    }

    function handleAbort() {
      finish(() => {
        reject(createAbortError())
      })
    }

    signal.addEventListener('abort', handleAbort, { once: true })

    promise.then(
      (value) => {
        finish(() => {
          resolve(value)
        })
      },
      (error: unknown) => {
        finish(() => {
          reject(error)
        })
      },
    )
  })
}

function requestProvider(
  provider: MetaMaskProvider,
  arguments_: Eip1193RequestArguments,
  signal: AbortSignal,
) {
  const request = Promise.resolve().then(() =>
    provider.request(arguments_),
  )

  return withAbort(request, signal)
}

function isMetaMaskProvider(value: unknown): value is MetaMaskProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'request' in value &&
    typeof value.request === 'function'
  )
}

function isMetaMaskAnnouncement(
  value: unknown,
): value is Required<Pick<Eip6963ProviderDetail, 'provider'>> &
  Eip6963ProviderDetail {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const detail = value as Eip6963ProviderDetail
  if (!isMetaMaskProvider(detail.provider)) {
    return false
  }

  const rdns = detail.info?.rdns?.toLowerCase()
  if (rdns) {
    return rdns === 'io.metamask' || rdns.startsWith('io.metamask.')
  }

  return detail.provider.isMetaMask === true
}

function getLegacyMetaMaskProvider() {
  if (typeof window === 'undefined') {
    return null
  }

  const ethereum = (
    window as unknown as { ethereum?: MetaMaskProvider }
  ).ethereum

  if (!isMetaMaskProvider(ethereum)) {
    return null
  }

  const injectedMetaMask = ethereum.providers?.find(
    (provider) =>
      isMetaMaskProvider(provider) && provider.isMetaMask === true,
  )

  if (injectedMetaMask) {
    return injectedMetaMask
  }

  return ethereum.isMetaMask === true ? ethereum : null
}

function discoverMetaMaskProvider(signal: AbortSignal) {
  throwIfAborted(signal)

  if (typeof window === 'undefined') {
    return Promise.resolve<MetaMaskProvider | null>(null)
  }

  return new Promise<MetaMaskProvider | null>((resolve, reject) => {
    let settled = false
    let timeoutId: number | undefined

    function cleanup() {
      window.removeEventListener(
        'eip6963:announceProvider',
        handleAnnouncement,
      )
      signal.removeEventListener('abort', handleAbort)
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }

    function finish(provider: MetaMaskProvider | null) {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve(provider)
    }

    function handleAbort() {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(createAbortError())
    }

    function handleAnnouncement(event: Event) {
      if (
        event instanceof CustomEvent &&
        isMetaMaskAnnouncement(event.detail)
      ) {
        finish(event.detail.provider)
      }
    }

    window.addEventListener(
      'eip6963:announceProvider',
      handleAnnouncement,
    )
    signal.addEventListener('abort', handleAbort, { once: true })
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    if (settled) {
      return
    }

    const legacyProvider = getLegacyMetaMaskProvider()
    if (legacyProvider) {
      finish(legacyProvider)
      return
    }

    timeoutId = window.setTimeout(() => {
      finish(null)
    }, EIP6963_DISCOVERY_TIMEOUT_MS)
  })
}

function isUserRejectedError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  return Number(error.code) === 4001
}

function connectionError(
  code: EvmWalletConnectionError['code'],
): {
  error: EvmWalletConnectionError
  ok: false
} {
  return {
    error: { code },
    ok: false,
  }
}

function ownershipError(
  code: EvmWalletOwnershipError['code'],
): {
  error: EvmWalletOwnershipError
  ok: false
} {
  return {
    error: { code },
    ok: false,
  }
}

function isEthereumAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-f]{40}$/i.test(value)
  )
}

function getFirstAccount(value: unknown) {
  if (!Array.isArray(value)) {
    return null
  }

  const account = value[0]
  return isEthereumAddress(account) ? account : null
}

function isEthereumMainnet(value: unknown) {
  if (typeof value !== 'string') {
    return false
  }

  try {
    return BigInt(value) === 1n
  } catch {
    return false
  }
}

export const connectMetaMaskWallet: ConnectWallet = async ({
  provider: providerId,
  signal,
}) => {
  activeMetaMaskProvider = null

  if (providerId !== 'metamask') {
    return connectionError('PROVIDER_UNAVAILABLE')
  }

  try {
    const provider = await discoverMetaMaskProvider(signal)
    throwIfAborted(signal)

    if (!provider) {
      return connectionError('PROVIDER_UNAVAILABLE')
    }

    const requestedAccount = getFirstAccount(
      await requestProvider(
        provider,
        { method: 'eth_requestAccounts' },
        signal,
      ),
    )

    if (!requestedAccount) {
      return connectionError('CONNECTION_FAILED')
    }

    let chainId = await requestProvider(
      provider,
      { method: 'eth_chainId' },
      signal,
    )

    if (!isEthereumMainnet(chainId)) {
      try {
        await requestProvider(
          provider,
          {
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: ETHEREUM_MAINNET_CHAIN_ID }],
          },
          signal,
        )
      } catch (error: unknown) {
        if (signal.aborted) {
          throw createAbortError()
        }
        if (isUserRejectedError(error)) {
          throw error
        }

        return connectionError('UNSUPPORTED_NETWORK')
      }

      chainId = await requestProvider(
        provider,
        { method: 'eth_chainId' },
        signal,
      )
    }

    if (!isEthereumMainnet(chainId)) {
      return connectionError('UNSUPPORTED_NETWORK')
    }

    const activeAccount = getFirstAccount(
      await requestProvider(
        provider,
        { method: 'eth_accounts' },
        signal,
      ),
    )
    if (!activeAccount) {
      return connectionError('CONNECTION_FAILED')
    }

    throwIfAborted(signal)
    activeMetaMaskProvider = provider

    return {
      ok: true,
      wallet: {
        address: activeAccount,
        chainId: EIP155_ETHEREUM_MAINNET_CHAIN_ID,
        network: 'Ethereum',
        provider: 'metamask',
      },
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      throw createAbortError()
    }

    return connectionError(
      isUserRejectedError(error)
        ? 'CONNECTION_REJECTED'
        : 'CONNECTION_FAILED',
    )
  }
}

function createCryptographicToken(byteLength: number) {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('A cryptographic random source is unavailable.')
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(byteLength))
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function getSignatureOrigin() {
  if (
    typeof window !== 'undefined' &&
    window.location.origin !== 'null'
  ) {
    return window.location.origin
  }

  return 'https://daejang.local'
}

function createOwnershipMessage(
  address: string,
  issuedAtMilliseconds: number,
) {
  const uri = getSignatureOrigin()
  const domain =
    typeof window !== 'undefined' && window.location.host
      ? window.location.host
      : new URL(uri).host
  const issuedAt = new Date(issuedAtMilliseconds).toISOString()
  const expirationTime = new Date(
    issuedAtMilliseconds + SIGNATURE_TTL_MS,
  ).toISOString()
  const nonce = createCryptographicToken(16)

  return {
    expirationTime,
    message: `${domain} wants you to sign in with your Ethereum account:
${address}

Confirm this wallet for Daejang data collection.

URI: ${uri}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`,
  }
}

function isPersonalSignature(value: unknown) {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-f]{130}$/i.test(value)
  )
}

function encodeUtf8AsHex(value: string) {
  const bytes = new TextEncoder().encode(value)

  return `0x${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`
}

export const requestMetaMaskOwnershipSignature: RequestOwnershipSignature =
  async ({ signal, wallet }) => {
    try {
      throwIfAborted(signal)

      const provider = activeMetaMaskProvider
      if (
        !provider ||
        wallet.provider !== 'metamask' ||
        wallet.chainId !== EIP155_ETHEREUM_MAINNET_CHAIN_ID
      ) {
        return ownershipError('SIGNATURE_FAILED')
      }

      const currentAccount = getFirstAccount(
        await requestProvider(
          provider,
          { method: 'eth_accounts' },
          signal,
        ),
      )

      if (
        !currentAccount ||
        currentAccount.toLowerCase() !== wallet.address.toLowerCase()
      ) {
        return ownershipError('SIGNATURE_ADDRESS_MISMATCH')
      }

      const chainId = await requestProvider(
        provider,
        { method: 'eth_chainId' },
        signal,
      )
      if (!isEthereumMainnet(chainId)) {
        return ownershipError('SIGNATURE_FAILED')
      }

      const issuedAtMilliseconds = Date.now()
      const challenge = createOwnershipMessage(
        wallet.address,
        issuedAtMilliseconds,
      )

      if (
        !isPersonalSignature(
          await requestProvider(
            provider,
            {
              method: 'personal_sign',
              params: [
                encodeUtf8AsHex(challenge.message),
                wallet.address,
              ],
            },
            signal,
          ),
        )
      ) {
        return ownershipError('SIGNATURE_FAILED')
      }

      const accountAfterSigning = getFirstAccount(
        await requestProvider(
          provider,
          { method: 'eth_accounts' },
          signal,
        ),
      )
      if (
        !accountAfterSigning ||
        accountAfterSigning.toLowerCase() !==
          wallet.address.toLowerCase()
      ) {
        return ownershipError('SIGNATURE_ADDRESS_MISMATCH')
      }

      const chainIdAfterSigning = await requestProvider(
        provider,
        { method: 'eth_chainId' },
        signal,
      )
      if (!isEthereumMainnet(chainIdAfterSigning)) {
        return ownershipError('SIGNATURE_FAILED')
      }

      throwIfAborted(signal)
      if (Date.now() > Date.parse(challenge.expirationTime)) {
        return ownershipError('SIGNATURE_EXPIRED')
      }

      return {
        ok: true,
        proofMode: 'CLIENT_PREVIEW',
        verificationId: `verification_metamask_${createCryptographicToken(16)}`,
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw createAbortError()
      }

      return ownershipError(
        isUserRejectedError(error)
          ? 'SIGNATURE_REJECTED'
          : 'SIGNATURE_FAILED',
      )
    }
  }

export function subscribeToMetaMaskSession(
  handlers: MetaMaskSessionHandlers,
) {
  const provider = activeMetaMaskProvider
  if (!provider?.on) {
    return () => undefined
  }

  const handleAccountsChanged: Eip1193Listener = (value) => {
    if (!Array.isArray(value)) {
      return
    }

    handlers.onAccountsChanged?.(
      value.filter(isEthereumAddress),
    )
  }
  const handleChainChanged: Eip1193Listener = (value) => {
    if (typeof value === 'string') {
      handlers.onChainChanged?.(value)
    }
  }
  const handleDisconnect: Eip1193Listener = (error) => {
    if (activeMetaMaskProvider === provider) {
      activeMetaMaskProvider = null
    }
    handlers.onDisconnect?.(error)
  }

  provider.on('accountsChanged', handleAccountsChanged)
  provider.on('chainChanged', handleChainChanged)
  provider.on('disconnect', handleDisconnect)

  let subscribed = true

  return () => {
    if (!subscribed) {
      return
    }

    subscribed = false
    const removeListener = provider.removeListener ?? provider.off
    removeListener?.call(
      provider,
      'accountsChanged',
      handleAccountsChanged,
    )
    removeListener?.call(
      provider,
      'chainChanged',
      handleChainChanged,
    )
    removeListener?.call(
      provider,
      'disconnect',
      handleDisconnect,
    )
  }
}
