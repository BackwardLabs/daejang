import { requestApi } from '../../api/client.ts'

export type WalletSourceApiModel = {
  id: string
  type: 'EVM_WALLET'
  address: string
  accountType: 'EOA'
  verificationChainId: string
  verifiedAt: string
  label?: string
  status: 'ACTIVE' | 'DISCONNECTED'
  createdAt: string
  updatedAt: string
  disconnectedAt?: string
  chainScopes: Array<{
    chainId: string
    status: 'ACTIVE' | 'DISABLED'
  }>
}

export type DocumentSourceApiModel = {
  id: string
  type: 'UPBIT_PDF'
  provider: 'UPBIT'
  originalFilename: string
  mediaType: 'application/pdf'
  byteLength: number
  artifactDigest: string
  coverageStart: string
  coverageEnd: string
  status: 'ACTIVE' | 'DISCONNECTED'
  createdAt: string
  updatedAt: string
}
export type SourceApiModel = WalletSourceApiModel | DocumentSourceApiModel

export type SyncJobApiModel = {
  id: string
  sourceId: string
  sourceKind: 'UPBIT_PDF' | 'EVM_WALLET'
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  phase: 'VALIDATE_SOURCE' | 'EXTRACT' | 'NORMALIZE' | 'PUBLISH' | 'COMPLETE'
  attempts: number | string
  processedRecords: number | string
  failureCode?: string
  failureMessage?: string
  createdAt: string
  updatedAt: string
}

export async function listSources(signal?: AbortSignal) {
  return requestApi<{ items: SourceApiModel[] }>('/sources', { signal })
}

export async function listSyncJobs(signal?: AbortSignal) {
  return requestApi<{ items: SyncJobApiModel[] }>('/jobs', { signal })
}

export async function createWalletChallenge(input: {
  address: string
  chainId: string
  signal: AbortSignal
}) {
  return requestApi<{
    challengeId: string
    message: string
    expiresAt: string
  }>('/sources/wallets/challenges', {
    method: 'POST',
    signal: input.signal,
    body: JSON.stringify({ address: input.address, chainId: input.chainId }),
  })
}

export async function registerWalletSource(input: {
  challengeId: string
  signature: string
  chainIds: string[]
  signal: AbortSignal
}) {
  return requestApi<WalletSourceApiModel>('/sources/wallets', {
    method: 'POST',
    signal: input.signal,
    body: JSON.stringify({
      challengeId: input.challengeId,
      signature: input.signature,
      chainIds: input.chainIds,
    }),
  })
}

export async function disconnectWalletSource(sourceId: string) {
  return requestApi<WalletSourceApiModel>(`/sources/${sourceId}/disconnect`, {
    method: 'POST',
  })
}
