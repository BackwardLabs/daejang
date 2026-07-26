import { useCallback } from 'react'
import {
  useAppKit,
  type Provider,
} from '@reown/appkit/react'
import { useAppKitWallet } from '@reown/appkit-wallet-button/react'
import { BrowserProvider, verifyMessage } from 'ethers'
import { EvmWalletConnectionPage } from './EvmWalletConnectionPage.tsx'
import {
  type ConnectWallet,
  type EvmWalletProviderId,
  type RequestOwnershipSignature,
} from './evmWalletFlow.ts'
import {
  isReownAppKitConfigured,
  reownAppKit,
} from './reownAppKit.ts'

const directWalletNames = {
  coinbase: 'coinbase',
  metamask: 'metamask',
  walletconnect: 'walletConnect',
} as const

function isUserRejection(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 4001
  )
}

function waitForEvmConnection(signal: AbortSignal) {
  return new Promise<{ address: string; chainId: string }>((resolve, reject) => {
    const startedAt = Date.now()

    function finish() {
      window.clearInterval(intervalId)
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

function createOwnershipMessage(address: string) {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000)

  return [
    'Daejang 지갑 소유권 확인',
    '',
    `도메인: ${window.location.host}`,
    `주소: ${address}`,
    `Nonce: ${globalThis.crypto.randomUUID()}`,
    `발급 시각: ${issuedAt.toISOString()}`,
    `만료 시각: ${expiresAt.toISOString()}`,
    '',
    '이 서명은 가스비, 거래 승인 또는 자산 이동을 발생시키지 않습니다.',
  ].join('\n')
}

function MissingReownConfigurationRoute() {
  const connectWallet = useCallback<ConnectWallet>(async () => ({
    error: { code: 'PROVIDER_UNAVAILABLE' },
    ok: false,
  }), [])

  return <EvmWalletConnectionPage connectWallet={connectWallet} />
}

function ConfiguredReownRoute() {
  const { open } = useAppKit()
  const walletButton = useAppKitWallet({ namespace: 'eip155' })

  const connectWallet = useCallback<ConnectWallet>(
    async ({ provider, signal }) => {
      try {
        const directWalletName = getDirectWalletName(provider)

        if (directWalletName) {
          await walletButton.connect(directWalletName)
        } else {
          await open({ namespace: 'eip155', view: 'Connect' })
        }

        const connection = await waitForEvmConnection(signal)

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
        const message = createOwnershipMessage(wallet.address)
        const signature = await signer.signMessage(message)

        if (signal.aborted) {
          throw new DOMException('Wallet signature aborted.', 'AbortError')
        }

        const recoveredAddress = verifyMessage(message, signature)
        if (recoveredAddress.toLowerCase() !== wallet.address.toLowerCase()) {
          return {
            error: { code: 'SIGNATURE_ADDRESS_MISMATCH' },
            ok: false,
          }
        }

        return {
          ok: true,
          verificationId: `reown_${globalThis.crypto.randomUUID()}`,
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

  return (
    <EvmWalletConnectionPage
      connectWallet={connectWallet}
      requestSignature={requestSignature}
    />
  )
}

export function ReownEvmWalletConnectionRoute() {
  return isReownAppKitConfigured ? (
    <ConfiguredReownRoute />
  ) : (
    <MissingReownConfigurationRoute />
  )
}
