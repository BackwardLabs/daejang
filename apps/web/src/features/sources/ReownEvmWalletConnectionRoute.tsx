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
  isReownAppKitConfigured,
  reownAppKit,
} from './reownAppKit.ts'
import {
  createSyncJob,
  createWalletChallenge,
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

function waitForEvmConnection(
  signal: AbortSignal,
  cancelWhenModalCloses = false,
) {
  return new Promise<{ address: string; chainId: string }>((resolve, reject) => {
    const startedAt = Date.now()
    let unsubscribeState: (() => void) | undefined

    function finish() {
      window.clearInterval(intervalId)
      unsubscribeState?.()
      signal.removeEventListener('abort', handleAbort)
    }

    function handleAbort() {
      finish()
      reject(new DOMException('Wallet connection aborted.', 'AbortError'))
    }

    const intervalId = window.setInterval(() => {
      const caipAddress = reownAppKit?.getCaipAddress('eip155')
      const chainId = reownAppKit?.getChainId()

      if (caipAddress && chainId !== undefined) {
        const address = caipAddress.split(':').at(-1)
        if (address) {
          finish()
          resolve({ address, chainId: `eip155:${chainId}` })
          return
        }
      }

      if (Date.now() - startedAt >= 120_000) {
        finish()
        reject(new Error('Wallet connection timed out.'))
      }
    }, 100)

    if (cancelWhenModalCloses) {
      unsubscribeState = reownAppKit?.subscribeState((state) => {
        if (!state.open && !reownAppKit?.getCaipAddress('eip155')) {
          finish()
          reject({ code: 4001 })
        }
      })
    }

    signal.addEventListener('abort', handleAbort, { once: true })
  })
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
  onLaunchFailed?: (result: ConnectWalletResult) => void
  onExitRequested?: () => void
  pendingView?: ReactNode
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
  pendingView,
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
      requestSignature={unavailableOwnershipSignature}
    />
  )
}

function ConfiguredReownRoute({
  launchImmediately = false,
  onExitRequested,
  onLaunchFailed,
  pendingView,
}: ReownRouteProps) {
  const { open } = useAppKit()
  const walletButton = useAppKitWallet({ namespace: 'eip155' })
  const [initialConnectionComplete, setInitialConnectionComplete] = useState(
    !launchImmediately,
  )
  const pendingSignatures = useRef(new Map<string, string>())
  const pendingSourceIds = useRef(new Map<string, string>())

  const connectWallet = useCallback<ConnectWallet>(
    async ({ provider, signal }) => {
      try {
        const directWalletName = getDirectWalletName(provider)

        if (directWalletName) {
          await walletButton.connect(directWalletName)
        } else {
          await open({ namespace: 'eip155', view: 'Connect' })
        }

        const connection = await waitForEvmConnection(
          signal,
          directWalletName === null,
        )

        if (connection.chainId !== 'eip155:1') {
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
            network: 'Ethereum',
            provider,
          },
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        return {
          error: {
            code: isUserRejection(error)
              ? 'CONNECTION_REJECTED'
              : 'CONNECTION_FAILED',
          },
          ok: false,
        }
      }
    },
    [open, walletButton],
  )

  const requestSignature = useCallback<RequestOwnershipSignature>(
    async ({ signal, wallet }) => {
      try {
        const walletProvider = reownAppKit?.getProvider<Provider>('eip155')
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

        const recoveredAddress = verifyMessage(challenge.message, signature)
        if (recoveredAddress.toLowerCase() !== wallet.address.toLowerCase()) {
          return {
            error: { code: 'SIGNATURE_ADDRESS_MISMATCH' },
            ok: false,
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
    async ({ intentKey, period, signal, verificationId, wallet }) => {
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
            chainIds: [wallet.chainId],
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
      onLaunchFailed?.(result)
    },
    [onLaunchFailed],
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
