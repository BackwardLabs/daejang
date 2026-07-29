import { ApiError } from '../errors.js'
import type {
  CompleteWalletRegistration,
  SourceRequestContext,
  WalletOwnershipChallenge,
  WalletSourceStore,
} from './wallet-source-store.js'

export class UnavailableWalletSourceStore implements WalletSourceStore {
  readonly durable = true

  async createChallenge(_challenge: WalletOwnershipChallenge): Promise<never> {
    return this.#unavailable()
  }

  async getChallenge(_userId: string, _challengeId: string): Promise<never> {
    return this.#unavailable()
  }

  async completeRegistration(_input: CompleteWalletRegistration): Promise<never> {
    return this.#unavailable()
  }

  async listWallets(_context: SourceRequestContext): Promise<never> {
    return this.#unavailable()
  }

  async disconnectWallet(
    _context: SourceRequestContext,
    _sourceId: string,
    _now: Date,
  ): Promise<never> {
    return this.#unavailable()
  }

  #unavailable(): never {
    throw new ApiError(
      503,
      'WALLET_SOURCE_UNAVAILABLE',
      '지갑 연결 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    )
  }
}
