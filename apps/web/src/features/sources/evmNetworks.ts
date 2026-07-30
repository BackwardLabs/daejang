import {
  mainnet,
  optimism,
  type AppKitNetwork,
} from '@reown/appkit/networks'

export const evmWalletNetworks = [
  mainnet,
  optimism,
] satisfies [AppKitNetwork, ...AppKitNetwork[]]

export const evmWalletNetworkMetadata = [
  { chainId: 'eip155:1', label: 'Ethereum' },
  { chainId: 'eip155:10', label: 'Optimism' },
] as const

export const EVM_WALLET_SUPPORTED_CHAIN_IDS =
  evmWalletNetworkMetadata.map((network) => network.chainId)

const networkMetadataByChainId = new Map<
  string,
  (typeof evmWalletNetworkMetadata)[number]
>(
  evmWalletNetworkMetadata.map((network) => [network.chainId, network]),
)

export function toEvmCaipChainId(chainId: string | number) {
  const normalized = String(chainId)
  return normalized.startsWith('eip155:')
    ? normalized
    : `eip155:${normalized}`
}

export function getEvmWalletNetwork(chainId: string | number) {
  return networkMetadataByChainId.get(toEvmCaipChainId(chainId))
}
