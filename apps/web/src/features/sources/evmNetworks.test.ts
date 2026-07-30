import { describe, expect, it } from 'vitest'
import {
  evmWalletNetworkMetadata,
  evmWalletNetworks,
  getEvmWalletNetwork,
  toEvmCaipChainId,
} from './evmNetworks.ts'

describe('EVM wallet networks', () => {
  it('configures the production collection networks in AppKit', () => {
    expect(evmWalletNetworks.map((network) => network.id)).toEqual([
      1,
      10,
    ])
    expect(evmWalletNetworkMetadata.map((network) => network.chainId)).toEqual([
      'eip155:1',
      'eip155:10',
    ])
  })

  it('normalizes numeric and CAIP-2 chain IDs before resolving labels', () => {
    expect(toEvmCaipChainId(10)).toBe('eip155:10')
    expect(toEvmCaipChainId('eip155:91342')).toBe('eip155:91342')
    expect(getEvmWalletNetwork(1)?.label).toBe('Ethereum')
    expect(getEvmWalletNetwork('eip155:10')?.label).toBe('Optimism')
    expect(getEvmWalletNetwork(91_342)).toBeUndefined()
    expect(getEvmWalletNetwork(137)).toBeUndefined()
  })
})
