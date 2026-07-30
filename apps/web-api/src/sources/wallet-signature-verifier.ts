import { Interface, JsonRpcProvider, hashMessage, verifyMessage } from 'ethers'

const erc1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const safe = new Interface([
  'function getThreshold() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
])

export type WalletSignatureVerification = 'VALID' | 'INVALID' | 'UNAVAILABLE'
export interface WalletSignatureVerifier {
  verify(input: Readonly<{ address: string; message: string; signature: string; verificationChainId: string }>): Promise<WalletSignatureVerification>
}
export interface WalletVerificationRpc {
  getChainId(): Promise<bigint>
  getCode(address: string): Promise<string>
  call(transaction: { data: string; to: string }): Promise<string>
}

const isCallException = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error &&
  (error as { code?: unknown }).code === 'CALL_EXCEPTION'

export class EthersWalletSignatureVerifier implements WalletSignatureVerifier {
  readonly #rpcs: ReadonlyMap<string, WalletVerificationRpc>

  constructor(
    rpcUrls: ReadonlyMap<string, string>,
    rpcFactory: (url: string) => WalletVerificationRpc = (url) => {
      const provider = new JsonRpcProvider(url)
      return {
        getChainId: async () => (await provider.getNetwork()).chainId,
        getCode: (address) => provider.getCode(address),
        call: (transaction) => provider.call(transaction),
      }
    },
  ) {
    this.#rpcs = new Map([...rpcUrls].map(([chainId, url]) => [chainId, rpcFactory(url)]))
  }

  async verify(input: Parameters<WalletSignatureVerifier['verify']>[0]) {
    let recoveredAddress: string | undefined
    try {
      recoveredAddress = verifyMessage(input.message, input.signature)
      if (recoveredAddress.toLowerCase() === input.address.toLowerCase()) return 'VALID'
    } catch {
      // Contract signatures do not need to be ECDSA signatures.
    }
    const rpc = this.#rpcs.get(input.verificationChainId)
    const chainId = /^eip155:([1-9][0-9]*)$/u.exec(input.verificationChainId)?.[1]
    if (!rpc || !chainId) return 'INVALID'
    try {
      if ((await rpc.getChainId()) !== BigInt(chainId)) return 'UNAVAILABLE'
      if ((await rpc.getCode(input.address)) === '0x') return 'INVALID'
      let result: string | undefined
      try {
        result = await rpc.call({
          to: input.address,
          data: erc1271.encodeFunctionData('isValidSignature', [hashMessage(input.message), input.signature]),
        })
      } catch (error) {
        if (!isCallException(error)) return 'UNAVAILABLE'
      }
      if (result !== undefined) {
        try {
          const [magic] = erc1271.decodeFunctionResult('isValidSignature', result)
          if (typeof magic === 'string' && magic.toLowerCase() === '0x1626ba7e') return 'VALID'
        } catch {
          // A threshold-one Safe may return its owner's personal signature.
        }
      }
      if (!recoveredAddress) return 'INVALID'
      const [thresholdResult, ownerResult] = await Promise.all([
        rpc.call({ to: input.address, data: safe.encodeFunctionData('getThreshold') }),
        rpc.call({ to: input.address, data: safe.encodeFunctionData('isOwner', [recoveredAddress]) }),
      ])
      const [threshold] = safe.decodeFunctionResult('getThreshold', thresholdResult)
      const [isOwner] = safe.decodeFunctionResult('isOwner', ownerResult)
      return threshold === 1n && isOwner === true ? 'VALID' : 'INVALID'
    } catch (error) {
      return isCallException(error) ? 'INVALID' : 'UNAVAILABLE'
    }
  }
}
