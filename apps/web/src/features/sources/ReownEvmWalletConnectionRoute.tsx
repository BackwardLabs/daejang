import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  useAppKit,
  type Provider,
} from '@reown/appkit/react'
import { useAppKitWallet } from '@reown/appkit-wallet-button/react'
import { BrowserProvider, verifyMessage } from 'ethers'
import { EvmWalletConnectionPage } from './EvmWalletConnectionPage.tsx'
import {
  type CompleteWalletConnection,
  type ConnectWallet,
  type ConnectWalletResult,
  type EvmWalletProviderId,
  type RequestOwnershipSignature,
  normalizeEvmWalletPeriod,
} from './evmWalletFlow.ts'
import {
  getEvmWalletNetwork,
  toEvmCaipChainId,
} from './evmNetworks.ts'
import {
  isReownAppKitConfigured,
  reownAppKit,
} from './reownAppKit.ts'
import {
  createSyncJob,
  createWalletChallenge,
  listSources,
  registerWalletSource,
  watchSyncJob,
} from './sourceApi.ts'

const directWalletNames = {
  coinbase: 'coinbase',
  metamask: 'metamask',
  walletconnect: 'walletConnect',
} as const

const unavailableConnectWallet: ConnectWallet = async () => ({
  error: { code: 'PROVIDER_UNAVAILABLE' },
  ok: false,
})

const unavailableOwnershipSignature: RequestOwnershipSignature = async () => ({
  error: { code: 'SIGNATURE_FAILED' },
  ok: false,
})

const unavailableCompleteConnection: CompleteWalletConnection = async () => ({
  error: { code: 'SOURCE_SAVE_FAILED' },
  ok: false,
})

function isUserRejection(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 4001
  )
}

type WalletConnectionFailureCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'SOURCE_ALREADY_CONNECTED'

function walletConnectionFailure(code: WalletConnectionFailureCode) {
  return { code }
}

function getWalletConnectionFailureCode(error: unknown) {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error)
  ) {
    return null
  }

  const code = (error as { code?: unknown }).code
  return code === 'PROVIDER_UNAVAILABLE' ||
    code === 'SOURCE_ALREADY_CONNECTED'
    ? code
    : null
}

type Eip6963ProviderDetail = {
  info: {
    rdns: string
  }
  provider: Provider
}

function isRabbyProvider(detail: Eip6963ProviderDetail) {
  return (
    detail.info.rdns === 'io.rabby' ||
    detail.info.rdns.startsWith('io.rabby.')
  )
}

function findRabbyProvider(signal: AbortSignal, timeoutMs = 800) {
  return new Promise<Provider | null>((resolve, reject) => {
    let timeoutId = 0
    let settled = false

    function finish() {
      window.clearTimeout(timeoutId)
      window.removeEventListener('eip6963:announceProvider', handleAnnouncement)
      signal.removeEventListener('abort', handleAbort)
    }

    function settle(provider: Provider | null) {
      if (settled) return
      settled = true
      finish()
      resolve(provider)
    }

    function handleAnnouncement(event: Event) {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
      if (detail?.provider && isRabbyProvider(detail)) {
        settle(detail.provider)
      }
    }

    function handleAbort() {
      if (settled) return
      settled = true
      finish()
      reject(new DOMException('Wallet connection aborted.', 'AbortError'))
    }

    window.addEventListener('eip6963:announceProvider', handleAnnouncement)
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
      return
    }

    timeoutId = window.setTimeout(() => settle(null), timeoutMs)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
  })
}

function parseEvmConnection(caipAddress: string | undefined) {
  if (!caipAddress) return null

  const [, chainId, address] = caipAddress.split(':')
  if (!chainId || !address) return null

  return {
    address,
    chainId: toEvmCaipChainId(chainId),
  }
}

type ReownAccountSnapshot = {
  address?: string
  allAccounts?: Array<{
    address?: string
    caipAddress?: string
    chainId?: string | number
    namespace?: string
  }>
  caipAddress?: string
  isConnected?: boolean
}

function parseReownAccountConnection(account: ReownAccountSnapshot | undefined) {
  if (!account?.isConnected) return null

  const directConnection = parseEvmConnection(account.caipAddress)
  if (directConnection) return directConnection

  const evmAccount = account.allAccounts?.find(
    (candidate) => candidate.namespace === 'eip155',
  )
  const listedConnection = parseEvmConnection(evmAccount?.caipAddress)
  if (listedConnection) return listedConnection

  if (evmAccount?.address && evmAccount.chainId !== undefined) {
    return {
      address: evmAccount.address,
      chainId: toEvmCaipChainId(evmAccount.chainId),
    }
  }

  const address = evmAccount?.address ?? account.address
  const activeChainId = reownAppKit?.getCaipNetwork?.('eip155')?.id
  if (!address || activeChainId === undefined) return null

  return {
    address,
    chainId: toEvmCaipChainId(activeChainId),
  }
}

function readCurrentEvmConnection() {
  return (
    parseEvmConnection(reownAppKit?.getCaipAddress('eip155')) ??
    parseReownAccountConnection(reownAppKit?.getAccount?.('eip155'))
  )
}

async function readProviderEvmConnection() {
  const provider = reownAppKit?.getProvider<Provider>('eip155')
  if (!provider) return null

  const accounts = await provider.request({ method: 'eth_accounts' })
  const chainId = await provider.request({ method: 'eth_chainId' })
  const address = Array.isArray(accounts) ? accounts[0] : undefined
  if (typeof address !== 'string' || address.length === 0) return null
  if (typeof chainId !== 'string' && typeof chainId !== 'number') return null

  const normalizedChainId =
    typeof chainId === 'string' && /^0x[0-9a-f]+$/iu.test(chainId)
      ? Number.parseInt(chainId.slice(2), 16)
      : chainId

  return {
    address,
    chainId: toEvmCaipChainId(normalizedChainId),
  }
}

async function readInjectedEvmConnection(provider: Provider) {
  const accounts = await provider.request({ method: 'eth_accounts' })
  const chainId = await provider.request({ method: 'eth_chainId' })
  const address = Array.isArray(accounts) ? accounts[0] : undefined
  if (typeof address !== 'string' || address.length === 0) return null
  if (typeof chainId !== 'string' && typeof chainId !== 'number') return null

  const normalizedChainId =
    typeof chainId === 'string' && /^0x[0-9a-f]+$/iu.test(chainId)
      ? Number.parseInt(chainId.slice(2), 16)
      : chainId

  return {
    address,
    chainId: toEvmCaipChainId(normalizedChainId),
  }
}

async function connectRabbyWallet(
  signal: AbortSignal,
  requireAccountSelection: boolean,
) {
  const provider = await findRabbyProvider(signal)
  if (!provider) {
    throw walletConnectionFailure('PROVIDER_UNAVAILABLE')
  }

  if (requireAccountSelection) {
    try {
      await provider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      })
    } catch (error) {
      if (isUserRejection(error)) throw error

      // Some injected-wallet versions do not expose an account picker through
      // wallet_requestPermissions. Re-read their authorised account instead of
      // leaving the UI in a generic failure state; the active-source guard below
      // will then explain that the account is already connected.
      await provider.request({ method: 'eth_requestAccounts' })
    }
  } else {
    await provider.request({ method: 'eth_requestAccounts' })
  }

  const connection = await readInjectedEvmConnection(provider)
  if (!connection) {
    throw new Error('Rabby did not return an EVM account.')
  }

  return { connection, provider }
}

function waitForExplicitEvmConnection(
  signal: AbortSignal,
  openWalletPicker: () => Promise<unknown>,
  requireDifferentConnection = false,
) {
  return new Promise<{ address: string; chainId: string }>((resolve, reject) => {
    const initialConnection = readCurrentEvmConnection()
    const startedAt = Date.now()
    let intervalId = 0
    let modalClosedAt: number | null = null
    let modalWasOpen = false
    let readingConnection = false
    let settled = false
    let unsubscribeAccount: (() => void) | undefined
    let unsubscribeState: (() => void) | undefined

    function isInitialConnection(connection: {
      address: string
      chainId: string
    }) {
      return Boolean(
        initialConnection &&
        initialConnection.address.toLowerCase() ===
          connection.address.toLowerCase() &&
        initialConnection.chainId === connection.chainId,
      )
    }

    function resolveConnection(
      connection: { address: string; chainId: string } | null,
      allowInitialConnection = false,
    ) {
      if (settled || !connection) return false
      if (isInitialConnection(connection) && requireDifferentConnection) {
        if (allowInitialConnection) {
          settled = true
          finish()
          reject(walletConnectionFailure('SOURCE_ALREADY_CONNECTED'))
        }
        return false
      }
      if (isInitialConnection(connection) && !allowInitialConnection) {
        return false
      }

      settled = true
      finish()
      resolve(connection)
      return true
    }

    async function readConnection() {
      if (settled || readingConnection) return
      readingConnection = true
      try {
        if (resolveConnection(readCurrentEvmConnection())) return
        resolveConnection(await readProviderEvmConnection(), true)
      } catch {
        // Reown may expose the provider one tick before it is ready to answer.
      } finally {
        readingConnection = false
      }
    }

    unsubscribeAccount = reownAppKit?.subscribeAccount((account) => {
      resolveConnection(parseReownAccountConnection(account), true)
    }, 'eip155')

    unsubscribeState = reownAppKit?.subscribeState((state) => {
      if (state.open) {
        modalWasOpen = true
        modalClosedAt = null
        return
      }

      if (!modalWasOpen) return
      modalClosedAt = Date.now()
      void readConnection()
    })

    function finish() {
      window.clearInterval(intervalId)
      unsubscribeAccount?.()
      unsubscribeState?.()
      signal.removeEventListener('abort', handleAbort)
    }

    function handleAbort() {
      if (settled) return
      settled = true
      finish()
      reject(new DOMException('Wallet connection aborted.', 'AbortError'))
    }

    intervalId = window.setInterval(() => {
      const modalOpen = reownAppKit?.isOpen() ?? false
      if (modalOpen) {
        modalWasOpen = true
        modalClosedAt = null
      } else if (modalWasOpen && modalClosedAt === null) {
        modalClosedAt = Date.now()
      }

      void readConnection()

      if (
        modalClosedAt !== null &&
        Date.now() - modalClosedAt >= 750
      ) {
        settled = true
        finish()
        reject({ code: 4001 })
        return
      }

      if (Date.now() - startedAt >= 15_000) {
        settled = true
        finish()
        reject(new Error('Wallet connection timed out.'))
      }
    }, 100)

    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
      return
    }

    modalWasOpen = true
    void openWalletPicker()
      .then(() => readConnection())
      .catch((error: unknown) => {
        if (settled) return
        settled = true
        finish()
        reject(error)
      })
  })
}

async function isActiveWalletSource(address: string, signal: AbortSignal) {
  const normalizedAddress = address.trim().toLowerCase()
  const { items } = await listSources(signal)

  return items.some(
    (source) =>
      source.type === 'EVM_WALLET' &&
      source.status === 'ACTIVE' &&
      source.address.trim().toLowerCase() === normalizedAddress,
  )
}

function getDirectWalletName(provider: EvmWalletProviderId) {
  if (provider in directWalletNames) {
    return directWalletNames[
      provider as keyof typeof directWalletNames
    ]
  }

  return null
}

type ReownRouteProps = {
  launchImmediately?: boolean
  onAlreadyConnected?: () => void
  onLaunchFailed?: (result: ConnectWalletResult) => void
  onExitRequested?: () => void
  pendingView?: ReactNode
  presentation?: 'dialog' | 'page'
}

function MissingImmediateLaunch({
  onLaunchFailed,
  pendingView,
}: Pick<ReownRouteProps, 'onLaunchFailed' | 'pendingView'>) {
  useEffect(() => {
    onLaunchFailed?.({
      error: { code: 'PROVIDER_UNAVAILABLE' },
      ok: false,
    })
  }, [onLaunchFailed])

  return pendingView
}

function MissingReownConfigurationRoute({
  launchImmediately = false,
  onLaunchFailed,
  onExitRequested,
  pendingView,
  presentation,
}: ReownRouteProps) {
  if (launchImmediately) {
    return (
      <MissingImmediateLaunch
        onLaunchFailed={onLaunchFailed}
        pendingView={pendingView}
      />
    )
  }

  return (
    <EvmWalletConnectionPage
      completeConnection={unavailableCompleteConnection}
      connectWallet={unavailableConnectWallet}
      onExitRequested={onExitRequested}
      presentation={presentation}
      requestSignature={unavailableOwnershipSignature}
    />
  )
}

function ConfiguredReownRoute({
  launchImmediately = false,
  onAlreadyConnected,
  onExitRequested,
  onLaunchFailed,
  pendingView,
  presentation,
}: ReownRouteProps) {
  const { close, open } = useAppKit()
  const walletButton = useAppKitWallet({ namespace: 'eip155' })
  const [initialConnectionComplete, setInitialConnectionComplete] = useState(
    !launchImmediately,
  )
  const pendingSignatures = useRef(new Map<string, string>())
  const pendingSourceIds = useRef(new Map<string, string>())
  const injectedProviders = useRef(new Map<string, Provider>())
  const duplicateWalletAttempt = useRef(false)

  const connectWallet = useCallback<ConnectWallet>(
    async ({ provider, signal }) => {
      try {
        duplicateWalletAttempt.current = false
        const currentConnection = readCurrentEvmConnection()
        const requiresDifferentConnection = Boolean(
          currentConnection &&
          await isActiveWalletSource(currentConnection.address, signal),
        )

        const directWalletName = getDirectWalletName(provider)
        let connection: { address: string; chainId: string }

        if (provider === 'rabby') {
          const rabbyConnection = await connectRabbyWallet(
            signal,
            requiresDifferentConnection,
          )
          connection = rabbyConnection.connection
          injectedProviders.current.set(
            connection.address.toLowerCase(),
            rabbyConnection.provider,
          )
        } else if (directWalletName) {
          await walletButton.connect(directWalletName)
          const directConnection = readCurrentEvmConnection()
          if (!directConnection) {
            return {
              error: { code: 'CONNECTION_FAILED' },
              ok: false,
            }
          }
          connection = directConnection
        } else {
          connection = await waitForExplicitEvmConnection(
            signal,
            () => open({ namespace: 'eip155', view: 'Connect' }),
            requiresDifferentConnection,
          )
          await close()
        }

        if (await isActiveWalletSource(connection.address, signal)) {
          duplicateWalletAttempt.current = true
          return {
            error: { code: 'SOURCE_ALREADY_CONNECTED' },
            ok: false,
          }
        }

        const network = getEvmWalletNetwork(connection.chainId)
        if (!network) {
          return {
            error: { code: 'CONNECTION_FAILED' },
            ok: false,
          }
        }

        return {
          ok: true,
          wallet: {
            address: connection.address,
            chainId: connection.chainId,
            network: network.label,
            provider,
          },
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        const failureCode = getWalletConnectionFailureCode(error)
        return {
          error: {
            code: failureCode ??
              (isUserRejection(error)
                ? 'CONNECTION_REJECTED'
                : 'CONNECTION_FAILED'),
          },
          ok: false,
        }
      }
    },
    [close, open, walletButton],
  )

  const requestSignature = useCallback<RequestOwnershipSignature>(
    async ({ signal, wallet }) => {
      try {
        const walletProvider =
          injectedProviders.current.get(wallet.address.toLowerCase()) ??
          reownAppKit?.getProvider<Provider>('eip155')
        if (!walletProvider) {
          return {
            error: { code: 'SIGNATURE_FAILED' },
            ok: false,
          }
        }

        const provider = new BrowserProvider(walletProvider)
        const signer = await provider.getSigner()
        const challenge = await createWalletChallenge({
          address: wallet.address,
          chainId: wallet.chainId,
          signal,
        })
        const signature = await signer.signMessage(challenge.message)

        if (signal.aborted) {
          throw new DOMException('Wallet signature aborted.', 'AbortError')
        }

        const code = await provider.getCode(wallet.address)
        if (code === '0x') {
          const recoveredAddress = verifyMessage(challenge.message, signature)
          if (recoveredAddress.toLowerCase() !== wallet.address.toLowerCase()) {
            return { error: { code: 'SIGNATURE_ADDRESS_MISMATCH' }, ok: false }
          }
        }
        pendingSignatures.current.set(challenge.challengeId, signature)

        return {
          ok: true,
          verificationId: challenge.challengeId,
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        return {
          error: {
            code: isUserRejection(error)
              ? 'SIGNATURE_REJECTED'
              : 'SIGNATURE_FAILED',
          },
          ok: false,
        }
      }
    },
    [],
  )

  const completeConnection = useCallback<CompleteWalletConnection>(
    async ({ chainIds, intentKey, period, signal, verificationId }) => {
      const signature = pendingSignatures.current.get(verificationId)
      if (!signature) {
        return { error: { code: 'SOURCE_SAVE_FAILED' }, ok: false }
      }

      let sourceId = pendingSourceIds.current.get(verificationId)
      try {
        if (!sourceId) {
          const source = await registerWalletSource({
            challengeId: verificationId,
            signature,
            chainIds,
            signal,
          })
          sourceId = source.id
          pendingSourceIds.current.set(verificationId, sourceId)
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        return { error: { code: 'SOURCE_SAVE_FAILED' }, ok: false }
      }

      const normalizedPeriod = normalizeEvmWalletPeriod(period)
      try {
        const { job } = await createSyncJob({
          coverageEnd: normalizedPeriod.endDate,
          coverageStart: normalizedPeriod.startDate,
          intentKey,
          signal,
          sourceId,
        })
        pendingSignatures.current.delete(verificationId)
        pendingSourceIds.current.delete(verificationId)
        return {
          jobId: job.id,
          jobStatus: 'BACKFILLING',
          normalizedPeriod,
          ok: true,
          sourceId,
          sourceStatus: 'SOURCE_SAVED',
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        return { error: { code: 'BACKFILL_FAILED' }, ok: false }
      }
    },
    [],
  )

  const handleInitialConnectionResult = useCallback(
    (result: ConnectWalletResult) => {
      if (result.ok) {
        setInitialConnectionComplete(true)
        return
      }
      if (duplicateWalletAttempt.current) {
        duplicateWalletAttempt.current = false
        onAlreadyConnected?.()
        return
      }
      onLaunchFailed?.(result)
    },
    [onAlreadyConnected, onLaunchFailed],
  )

  return (
    <>
      {launchImmediately && !initialConnectionComplete ? pendingView : null}
      <div hidden={launchImmediately && !initialConnectionComplete}>
        <EvmWalletConnectionPage
          autoConnectProvider={launchImmediately ? 'other' : undefined}
          completeConnection={completeConnection}
          connectWallet={connectWallet}
          onExitRequested={onExitRequested}
          onInitialConnectionResult={handleInitialConnectionResult}
          presentation={presentation}
          requestSignature={requestSignature}
          watchSyncJob={watchSyncJob}
        />
      </div>
    </>
  )
}

export function ReownEvmWalletConnectionRoute(props: ReownRouteProps = {}) {
  return isReownAppKitConfigured ? (
    <ConfiguredReownRoute {...props} />
  ) : (
    <MissingReownConfigurationRoute {...props} />
  )
}
