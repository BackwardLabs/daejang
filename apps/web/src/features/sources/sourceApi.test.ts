import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSyncJob,
  findLatestSyncJob,
  getSourceCapabilities,
  retrySyncJob,
  type SyncJobApiModel,
  updateWalletSourceNetworks,
  watchSyncJob,
} from './sourceApi.ts'

const syncJob = (
  overrides: Partial<SyncJobApiModel> = {},
): SyncJobApiModel => ({
  id: 'job-1',
  sourceId: 'source-1',
  sourceKind: 'EVM_WALLET',
  state: 'FAILED',
  phase: 'VALIDATE_SOURCE',
  attempts: 1,
  processedRecords: 0,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('EVM sync API integration', () => {
  it('selects the newest source job regardless of API return order', () => {
    const olderFailure = syncJob({
      id: 'job-old',
      failureCode: 'JIT_START_FAILED',
    })
    const newerSuccess = syncJob({
      id: 'job-new',
      state: 'SUCCEEDED',
      phase: 'COMPLETE',
      failureCode: undefined,
      createdAt: '2026-07-30T00:01:00.000Z',
      updatedAt: '2026-07-30T00:02:00.000Z',
    })

    expect(
      findLatestSyncJob([olderFailure, newerSuccess], 'source-1'),
    ).toEqual(newerSuccess)
    expect(
      findLatestSyncJob([newerSuccess, olderFailure], 'source-1'),
    ).toEqual(newerSuccess)
    expect(findLatestSyncJob([newerSuccess], 'other-source')).toBeUndefined()
  })

  it('replaces the collection networks for an existing wallet source', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'source-1',
      type: 'EVM_WALLET',
      chainScopes: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await updateWalletSourceNetworks({
      chainIds: ['eip155:1', 'eip155:10'],
      sourceId: 'source/with spaces',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/sources/source%2Fwith%20spaces/chains',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          chainIds: ['eip155:1', 'eip155:10'],
        }),
      }),
    )
  })

  it('sends the selected inclusive period to the real sync endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      job: { id: 'job-1', sourceId: 'source-1', sourceKind: 'EVM_WALLET', state: 'QUEUED', phase: 'VALIDATE_SOURCE', attempts: 0, processedRecords: 0, createdAt: '', updatedAt: '' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const { job } = await createSyncJob({
      coverageStart: '2027-01-01',
      coverageEnd: '2027-12-31',
      intentKey: 'wallet-intent-1',
      signal: controller.signal,
      sourceId: 'source-1',
    })

    expect(job.id).toBe('job-1')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/syncs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sourceKind: 'EVM_WALLET',
        sourceId: 'source-1',
        coverageStart: '2027-01-01',
        coverageEnd: '2027-12-31',
        trigger: 'USER_REQUEST',
        intentKey: 'wallet-intent-1',
      }),
    }))
  })

  it('polls the real job detail endpoint until a terminal state', async () => {
    vi.useFakeTimers()
    const jobs = [
      { id: 'job-1', state: 'RUNNING', processedRecords: 4 },
      { id: 'job-1', state: 'SUCCEEDED', processedRecords: 9 },
    ]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ job: jobs.shift() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const updates: string[] = []
    const controller = new AbortController()

    const terminalPromise = watchSyncJob({
      jobId: 'job-1',
      signal: controller.signal,
      onUpdate: (job) => updates.push(job.state),
    })
    await vi.advanceTimersByTimeAsync(1_500)
    const terminal = await terminalPromise

    expect(terminal.state).toBe('SUCCEEDED')
    expect(updates).toEqual(['RUNNING', 'SUCCEEDED'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/jobs/job-1', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/jobs/job-1', expect.any(Object))
  })

  it('reuses the caller-owned intent key when retrying a failed job', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      job: {
        id: 'job-2',
        sourceId: 'source-1',
        sourceKind: 'EVM_WALLET',
        state: 'QUEUED',
        phase: 'QUEUED',
        attempts: 0,
        processedRecords: 0,
        createdAt: '',
        updatedAt: '',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await retrySyncJob({
      intentKey: 'stable-retry-intent',
      jobId: 'job/with spaces',
      signal: controller.signal,
    })
    await retrySyncJob({
      intentKey: 'stable-retry-intent',
      jobId: 'job/with spaces',
      signal: controller.signal,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/jobs/job%2Fwith%20spaces/retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ intentKey: 'stable-retry-intent' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/jobs/job%2Fwith%20spaces/retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ intentKey: 'stable-retry-intent' }),
      }),
    )
  })
})

describe('source capability API', () => {
  it('accepts an explicit fail-closed Upbit PDF capability response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            upbitPdf: {
              registrationEnabled: false,
              encryptedPdfSupported: false,
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    )

    await expect(getSourceCapabilities()).resolves.toEqual({
      upbitPdf: {
        registrationEnabled: false,
        encryptedPdfSupported: false,
      },
    })
  })

  it('rejects malformed capability responses instead of enabling registration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            upbitPdf: {
              registrationEnabled: 'yes',
              encryptedPdfSupported: false,
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    )

    await expect(getSourceCapabilities()).rejects.toThrow(
      'Invalid source capability response',
    )
  })
})
