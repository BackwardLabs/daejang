import { requestApi } from '../../api/client.ts'
import type {
  WalletSyncJobSnapshot,
  WalletSyncJobState,
  WatchWalletSyncJob,
} from './evmWalletFlow.ts'

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
  state: WalletSyncJobState
  phase: 'QUEUED' | 'VALIDATE_SOURCE' | 'EXTRACT' | 'NORMALIZE' | 'PUBLISH' | 'COMPLETE'
  attempts: number | string
  processedRecords: number | string
  failureCode?: string
  failureMessage?: string
  outputFragmentId?: string
  requestedCoverageStart?: string
  requestedCoverageEnd?: string
  trigger?: string
  upstreamJitRunId?: string
  createdAt: string
  updatedAt: string
}

export type SourceCapabilities = {
  upbitPdf: {
    registrationEnabled: boolean
    encryptedPdfSupported: boolean
  }
}

export async function getSourceCapabilities(signal?: AbortSignal) {
  const value = await requestApi<unknown>('/sources/capabilities', { signal })
  if (
    typeof value !== 'object' ||
    value === null ||
    !('upbitPdf' in value) ||
    typeof value.upbitPdf !== 'object' ||
    value.upbitPdf === null ||
    !('registrationEnabled' in value.upbitPdf) ||
    typeof value.upbitPdf.registrationEnabled !== 'boolean' ||
    !('encryptedPdfSupported' in value.upbitPdf) ||
    typeof value.upbitPdf.encryptedPdfSupported !== 'boolean'
  ) {
    throw new Error('Invalid source capability response')
  }
  return value as SourceCapabilities
}

export async function listSources(signal?: AbortSignal) {
  return requestApi<{ items: SourceApiModel[] }>('/sources', { signal })
}

export async function listSyncJobs(signal?: AbortSignal) {
  return requestApi<{ items: SyncJobApiModel[] }>('/jobs', { signal })
}

export async function createSyncJob(input: {
  coverageEnd: string
  coverageStart: string
  intentKey: string
  signal: AbortSignal
  sourceId: string
}) {
  return requestApi<{ job: SyncJobApiModel }>('/syncs', {
    method: 'POST',
    signal: input.signal,
    body: JSON.stringify({
      sourceKind: 'EVM_WALLET',
      sourceId: input.sourceId,
      coverageStart: input.coverageStart,
      coverageEnd: input.coverageEnd,
      trigger: 'USER_REQUEST',
      intentKey: input.intentKey,
    }),
  })
}

export async function retrySyncJob(input: {
  intentKey: string
  jobId: string
  signal: AbortSignal
}) {
  return requestApi<{ job: SyncJobApiModel }>(
    `/jobs/${encodeURIComponent(input.jobId)}/retry`,
    {
      method: 'POST',
      signal: input.signal,
      body: JSON.stringify({ intentKey: input.intentKey }),
    },
  )
}

export async function getSyncJob(jobId: string, signal?: AbortSignal) {
  return requestApi<{ job: SyncJobApiModel }>(
    `/jobs/${encodeURIComponent(jobId)}`,
    { signal },
  )
}

function waitForNextPoll(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Sync polling aborted.', 'AbortError'))
      return
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, duration)
    function handleAbort() {
      window.clearTimeout(timeoutId)
      reject(new DOMException('Sync polling aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function toWalletSyncSnapshot(job: SyncJobApiModel): WalletSyncJobSnapshot {
  return {
    id: job.id,
    state: job.state,
    processedRecords: job.processedRecords,
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
    ...(job.failureMessage ? { failureMessage: job.failureMessage } : {}),
  }
}

export const watchSyncJob: WatchWalletSyncJob = async ({
  jobId,
  onUpdate,
  signal,
}) => {
  for (;;) {
    const { job } = await getSyncJob(jobId, signal)
    const snapshot = toWalletSyncSnapshot(job)
    onUpdate(snapshot)
    if (snapshot.state === 'SUCCEEDED' || snapshot.state === 'FAILED') {
      return snapshot
    }
    await waitForNextPoll(1_500, signal)
  }
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
