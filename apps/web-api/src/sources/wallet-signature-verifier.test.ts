import { Interface, Wallet } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { EthersWalletSignatureVerifier, type WalletVerificationRpc } from './wallet-signature-verifier.js'

const erc1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const safe = new Interface(['function getThreshold() view returns (uint256)', 'function isOwner(address owner) view returns (bool)'])
const thresholdSelector = safe.getFunction('getThreshold')!.selector
const verifier = (rpc: WalletVerificationRpc) => new EthersWalletSignatureVerifier(
  new Map([['eip155:1', 'https://ethereum.example.com']]), () => rpc,
)

describe('EthersWalletSignatureVerifier', () => {
  it('accepts a matching EOA without RPC access', async () => {
    const wallet = Wallet.createRandom(); const message = 'challenge'
    await expect(new EthersWalletSignatureVerifier(new Map()).verify({
      address: wallet.address, message, signature: await wallet.signMessage(message), verificationChainId: 'eip155:1',
    })).resolves.toBe('VALID')
  })
  it('accepts an ERC-1271 contract signature', async () => {
    const owner = Wallet.createRandom(); const message = 'challenge'
    const rpc: WalletVerificationRpc = {
      getChainId: async () => 1n, getCode: async () => '0x1234',
      call: vi.fn(async () => erc1271.encodeFunctionResult('isValidSignature', ['0x1626ba7e'])),
    }
    await expect(verifier(rpc).verify({
      address: Wallet.createRandom().address, message, signature: await owner.signMessage(message), verificationChainId: 'eip155:1',
    })).resolves.toBe('VALID')
  })
  it('accepts a raw owner signature only for a threshold-one Safe', async () => {
    const owner = Wallet.createRandom(); const message = 'challenge'
    const rpc: WalletVerificationRpc = {
      getChainId: async () => 1n, getCode: async () => '0x1234',
      call: vi.fn(async ({ data }) => data.startsWith('0x1626ba7e')
        ? erc1271.encodeFunctionResult('isValidSignature', ['0xffffffff'])
        : data.startsWith(thresholdSelector)
          ? safe.encodeFunctionResult('getThreshold', [1n])
          : safe.encodeFunctionResult('isOwner', [true])),
    }
    await expect(verifier(rpc).verify({
      address: Wallet.createRandom().address, message, signature: await owner.signMessage(message), verificationChainId: 'eip155:1',
    })).resolves.toBe('VALID')
  })
})
