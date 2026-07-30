import { describe, expect, it } from 'vitest'
import {
  evmWalletNetworkMetadata,
  evmWalletNetworks,
  getEvmWalletNetwork,
  giwaSepolia,
  toEvmCaipChainId,
} from './evmNetworks.ts'

describe('EVM wallet networks', () => {
  it('configures Ethereum, Optimism, and GIWA Sepolia in AppKit', () => {
    expect(evmWalletNetworks.map((network) => network.id)).toEqual([
      1,
      10,
      91_342,
    ])
    expect(evmWalletNetworkMetadata.map((network) => network.chainId)).toEqual([
      'eip155:1',
      'eip155:10',
      'eip155:91342',
    ])
  })

  it('defines the public GIWA Sepolia wallet metadata', () => {
    expect(giwaSepolia).toMatchObject({
      id: 91_342,
      name: 'GIWA Sepolia',
      rpcUrls: {
        default: { http: ['https://sepolia-rpc.giwa.io'] },
      },
      blockExplorers: {
        default: { url: 'https://sepolia-explorer.giwa.io' },
      },
    })
  })

  it('normalizes numeric and CAIP-2 chain IDs before resolving labels', () => {
    expect(toEvmCaipChainId(10)).toBe('eip155:10')
    expect(toEvmCaipChainId('eip155:91342')).toBe('eip155:91342')
    expect(getEvmWalletNetwork(1)?.label).toBe('Ethereum')
    expect(getEvmWalletNetwork('eip155:10')?.label).toBe('Optimism')
    expect(getEvmWalletNetwork(91_342)?.label).toBe('GIWA Sepolia')
    expect(getEvmWalletNetwork(137)).toBeUndefined()
  })
})
