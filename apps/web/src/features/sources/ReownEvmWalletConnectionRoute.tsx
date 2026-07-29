import { useEffect } from 'react'
import { useAppKit, type Provider } from '@reown/appkit/react'
import { BrowserProvider, verifyMessage } from 'ethers'
import type { ConnectedWallet } from './evmWalletFlow.ts'
import {
  isReownAppKitConfigured,
  reownAppKit,
} from './reownAppKit.ts'
import {
  createWalletChallenge,
  registerWalletSource,
} from './sourceApi.ts'

function getEvmConnection() {
  const caipAddress = reownAppKit?.getCaipAddress('eip155')
  const chainId = reownAppKit?.getChainId()

  if (!caipAddress || chainId === undefined) return null

  const address = caipAddress.split(':').at(-1)
  if (!address) return null

  return { address, chainId: `eip155:${chainId}` }
}

function isUserCancellation(error: unknown) {
  if (typeof error !== 'object' || error === null) return false

  const code = 'code' in error ? error.code : undefined
  return code === 4001 || code === 'ACTION_REJECTED'
}

function waitForEvmSessionClear(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now()

    const finish = (error?: Error) => {
      window.clearInterval(intervalId)
      signal.removeEventListener('abort', handleAbort)
      if (error) reject(error)
      else resolve()
    }

    const handleAbort = () => {
      finish(new DOMException('Wallet disconnect aborted.', 'AbortError'))
    }

    const check = () => {
      if (!getEvmConnection()) {
        finish()
        return
      }

      if (Date.now() - startedAt >= 5_000) {
        finish(new Error('Previous EVM wallet session did not disconnect.'))
      }
    }

    const intervalId = window.setInterval(check, 50)
    signal.addEventListener('abort', handleAbort, { once: true })
    check()
  })
}

async function registerConnectedWallet(
  wallet: ConnectedWallet,
  signal: AbortSignal,
) {
  const walletProvider = reownAppKit?.getProvider<Provider>('eip155')
  if (!walletProvider) {
    throw new Error('Connected EVM provider is unavailable.')
  }

  const challenge = await createWalletChallenge({
    address: wallet.address,
    chainId: wallet.chainId,
    signal,
  })
  const signer = await new BrowserProvider(walletProvider).getSigner()
  const signature = await signer.signMessage(challenge.message)

  if (signal.aborted) {
    throw new DOMException('Wallet registration aborted.', 'AbortError')
  }

  const recoveredAddress = verifyMessage(challenge.message, signature)
  if (recoveredAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('Wallet signature address does not match.')
  }

  await registerWalletSource({
    challengeId: challenge.challengeId,
    signature,
    chainIds: [wallet.chainId],
    signal,
  })
}

function ConfiguredReownLauncher({
  onCancelled,
  onConnected,
  onError,
}: {
  onCancelled?: () => void
  onConnected: (wallet: ConnectedWallet) => void
  onError?: () => void
}) {
  const { open } = useAppKit()

  useEffect(() => {
    const appKit = reownAppKit
    if (!appKit) {
      onError?.()
      return
    }

    const controller = new AbortController()
    let disposed = false
    let modalWasOpened = false
    let registrationStarted = false
    let settled = false
    let connectionInterval: number | undefined
    let modalCloseTimer: number | undefined
    let launchTimer: number | undefined
    let unsubscribeState: () => void = () => undefined

    const cleanup = () => {
      controller.abort()
      if (launchTimer !== undefined) {
        window.clearTimeout(launchTimer)
      }
      if (connectionInterval !== undefined) {
        window.clearInterval(connectionInterval)
      }
      if (modalCloseTimer !== undefined) {
        window.clearTimeout(modalCloseTimer)
      }
      unsubscribeState()
    }

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const handleFailure = (error: unknown) => {
      if (disposed || (error instanceof DOMException && error.name === 'AbortError')) {
        return
      }

      settle(() => {
        if (isUserCancellation(error)) onCancelled?.()
        else onError?.()
      })
    }

    const completeConnection = () => {
      const connection = getEvmConnection()
      if (!connection) return false
      if (registrationStarted) return true

      if (connection.chainId !== 'eip155:1') {
        settle(() => onError?.())
        return true
      }

      registrationStarted = true
      const wallet: ConnectedWallet = {
        address: connection.address,
        chainId: connection.chainId,
        network: 'Ethereum',
        provider: 'walletconnect',
      }

      void registerConnectedWallet(wallet, controller.signal)
        .then(() => {
          if (!disposed) settle(() => onConnected(wallet))
        })
        .catch(handleFailure)
      return true
    }

    const launch = async () => {
      try {
        if (getEvmConnection()) {
          await appKit.disconnect('eip155')
          await waitForEvmSessionClear(controller.signal)
        }
        if (disposed) return

        modalWasOpened = appKit.getState().open
        unsubscribeState = appKit.subscribeState((state) => {
          if (state.open) {
            modalWasOpened = true
            return
          }

          if (!modalWasOpened || settled) return

          modalCloseTimer = window.setTimeout(() => {
            if (!completeConnection()) {
              settle(() => onCancelled?.())
            }
          }, 0)
        })
        connectionInterval = window.setInterval(() => {
          completeConnection()
        }, 100)

        await open({ namespace: 'eip155', view: 'Connect' })
      } catch (error) {
        handleFailure(error)
      }
    }

    launchTimer = window.setTimeout(() => {
      launchTimer = undefined
      void launch()
    }, 0)

    return () => {
      if (settled) return
      disposed = true
      settled = true
      cleanup()
    }
  }, [onCancelled, onConnected, onError, open])

  return null
}

function MissingReownLauncher({ onError }: { onError?: () => void }) {
  useEffect(() => {
    onError?.()
  }, [onError])

  return null
}

export function ReownWalletLauncher({
  onCancelled,
  onConnected,
  onError,
}: {
  onCancelled?: () => void
  onConnected: (wallet: ConnectedWallet) => void
  onError?: () => void
}) {
  return isReownAppKitConfigured ? (
    <ConfiguredReownLauncher
      onCancelled={onCancelled}
      onConnected={onConnected}
      onError={onError}
    />
  ) : (
    <MissingReownLauncher onError={onError} />
  )
}
