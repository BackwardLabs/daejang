import {
  defineChain,
  mainnet,
  optimism,
  type AppKitNetwork,
} from '@reown/appkit/networks'

export const GIWA_SEPOLIA_CHAIN_ID = 91_342
export const GIWA_SEPOLIA_CAIP_CHAIN_ID = 'eip155:91342'
export const GIWA_SEPOLIA_RPC_URL = 'https://sepolia-rpc.giwa.io'
export const GIWA_SEPOLIA_EXPLORER_URL =
  'https://sepolia-explorer.giwa.io'

export const giwaSepolia = defineChain({
  id: GIWA_SEPOLIA_CHAIN_ID,
  caipNetworkId: GIWA_SEPOLIA_CAIP_CHAIN_ID,
  chainNamespace: 'eip155',
  name: 'GIWA Sepolia',
  nativeCurrency: {
    decimals: 18,
    name: 'GIWA Sepolia ETH',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [GIWA_SEPOLIA_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'GIWA Sepolia Explorer',
      url: GIWA_SEPOLIA_EXPLORER_URL,
    },
  },
})

export const evmWalletNetworks = [
  mainnet,
  optimism,
  giwaSepolia,
] satisfies [AppKitNetwork, ...AppKitNetwork[]]

export const evmWalletNetworkMetadata = [
  { chainId: 'eip155:1', label: 'Ethereum' },
  { chainId: 'eip155:10', label: 'Optimism' },
  { chainId: GIWA_SEPOLIA_CAIP_CHAIN_ID, label: 'GIWA Sepolia' },
] as const

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
