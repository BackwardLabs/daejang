import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WalletSyncJobSnapshot, WatchWalletSyncJob } from './evmWalletFlow.ts'
import { createRegisterUpbitPdfApi } from './upbitPdfApi.ts'
import type { UpbitPdfRegistrationRequest } from './upbitPdfRegistration.ts'

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const registrationRequest = (
  onStageChange: UpbitPdfRegistrationRequest['onStageChange'],
  overrides: Partial<UpbitPdfRegistrationRequest> = {},
): UpbitPdfRegistrationRequest => ({
  file: new File(['%PDF-1.7\n%%EOF'], 'statement.pdf', {
    type: 'application/pdf',
  }),
  intentKey: 'upbit-intent',
  coverageStart: '2027-01-01',
  coverageEnd: '2027-12-31',
  onStageChange,
  signal: new AbortController().signal,
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Upbit PDF API registration', () => {
  it('waits for the returned sync job before reporting registration success', async () => {
    let resolveTerminal!: (job: WalletSyncJobSnapshot) => void
    const terminal = new Promise<WalletSyncJobSnapshot>((resolve) => {
      resolveTerminal = resolve
    })
    const watchJob = vi.fn<WatchWalletSyncJob>(() => terminal)
    const responses = [
      jsonResponse({ uploadId: 'upload-1', uploadUrl: '/api/v1/uploads/upload-1/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ source: { id: 'source-1' }, job: { id: 'job-1' } }, 201),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift() as Response))
    const stages: string[] = []
    let settled = false

    const resultPromise = createRegisterUpbitPdfApi(watchJob)(
      registrationRequest((stage) => stages.push(stage)),
    ).then((result) => {
      settled = true
      return result
    })

    await vi.waitFor(() => expect(watchJob).toHaveBeenCalled())
    expect(settled).toBe(false)
    resolveTerminal({ id: 'job-1', state: 'SUCCEEDED', processedRecords: 12 })

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      sourceId: 'source-1',
      sourceStatus: 'UPLOADED',
    })
    expect(stages).toEqual([
      'DOCUMENT_UPLOADING',
      'SOURCE_SUBMITTING',
      'DOCUMENT_PROCESSING',
    ])
    expect(watchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }))
  })

  it('maps a parser layout failure without showing a false completion', async () => {
    const watchJob = vi.fn<WatchWalletSyncJob>(async () => ({
      id: 'job-layout',
      state: 'FAILED',
      processedRecords: 0,
      failureCode: 'UPBIT_PDF_LAYOUT_UNSUPPORTED',
    }))
    const responses = [
      jsonResponse({ uploadId: 'upload-2', uploadUrl: '/api/v1/uploads/upload-2/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ source: { id: 'source-2' }, job: { id: 'job-layout' } }, 201),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift() as Response))

    await expect(
      createRegisterUpbitPdfApi(watchJob)(registrationRequest(() => undefined)),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED_DOCUMENT', requestId: 'job-layout' },
    })
  })

  it('maps a layout rejection returned directly by upload confirmation', async () => {
    const watchJob = vi.fn<WatchWalletSyncJob>()
    const responses = [
      jsonResponse({ uploadId: 'upload-layout', uploadUrl: '/api/v1/uploads/upload-layout/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({
        error: {
          code: 'UPBIT_PDF_LAYOUT_UNSUPPORTED',
          message: '지원하지 않는 거래내역서 형식입니다.',
        },
      }, 422),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift() as Response))

    await expect(
      createRegisterUpbitPdfApi(watchJob)(registrationRequest(() => undefined)),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_DOCUMENT',
        requestId: 'UPBIT_PDF_LAYOUT_UNSUPPORTED',
      },
    })
    expect(watchJob).not.toHaveBeenCalled()
  })

  it('bounds job polling and resumes the same known job on explicit retry', async () => {
    const watchJob = vi
      .fn<WatchWalletSyncJob>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        id: 'job-timeout',
        state: 'SUCCEEDED',
        processedRecords: 8,
      })
    const responses = [
      jsonResponse({ uploadId: 'upload-timeout', uploadUrl: '/api/v1/uploads/upload-timeout/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ source: { id: 'source-timeout' }, job: { id: 'job-timeout' } }, 201),
    ]
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift() as Response)
    vi.stubGlobal('fetch', fetchMock)
    const registerPdf = createRegisterUpbitPdfApi(watchJob, {
      jobTimeoutMs: 5,
    })

    const first = await registerPdf(registrationRequest(() => undefined))
    expect(first).toEqual({
      ok: false,
      error: {
        code: 'PROCESSING_TIMEOUT',
        requestId: 'job-timeout',
        retry: {
          mode: 'resume-job',
          sourceId: 'source-timeout',
          jobId: 'job-timeout',
        },
      },
    })
    if (first.ok || !first.error.retry) throw new Error('Expected retry context')

    await expect(
      registerPdf(registrationRequest(() => undefined, {
        retry: first.error.retry,
      })),
    ).resolves.toEqual({
      ok: true,
      sourceId: 'source-timeout',
      sourceStatus: 'UPLOADED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(watchJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ jobId: 'job-timeout' }),
    )
  })

  it('restarts a terminally failed job and reuses its intent after an ambiguous request', async () => {
    const watchJob = vi
      .fn<WatchWalletSyncJob>()
      .mockResolvedValueOnce({
        id: 'job-failed',
        state: 'FAILED',
        processedRecords: 0,
        failureCode: 'PROCESSOR_UNAVAILABLE',
      })
      .mockResolvedValueOnce({
        id: 'job-restarted',
        state: 'SUCCEEDED',
        processedRecords: 11,
      })
    const responses: Array<Response | Error> = [
      jsonResponse({ uploadId: 'upload-failed', uploadUrl: '/api/v1/uploads/upload-failed/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ source: { id: 'source-failed' }, job: { id: 'job-failed' } }, 201),
      new TypeError('Network connection closed before the response arrived.'),
      jsonResponse({ job: { id: 'job-restarted' } }, 201),
    ]
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const registerPdf = createRegisterUpbitPdfApi(watchJob)

    const failed = await registerPdf(registrationRequest(() => undefined))
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'PROCESSING_FAILED',
        requestId: 'job-failed',
        retry: {
          mode: 'restart-job',
          sourceId: 'source-failed',
          intentKey: expect.any(String),
        },
      },
    })
    if (
      failed.ok ||
      !failed.error.retry ||
      failed.error.retry.mode !== 'restart-job'
    ) {
      throw new Error('Expected restart context')
    }
    const restartRetry = failed.error.retry

    const ambiguous = await registerPdf(registrationRequest(() => undefined, {
      retry: restartRetry,
    }))
    expect(ambiguous).toEqual({
      ok: false,
      error: {
        code: 'PROCESSING_FAILED',
        retry: restartRetry,
      },
    })
    if (ambiguous.ok || !ambiguous.error.retry) {
      throw new Error('Expected the same restart context')
    }

    await expect(
      registerPdf(registrationRequest(() => undefined, {
        retry: ambiguous.error.retry,
      })),
    ).resolves.toEqual({
      ok: true,
      sourceId: 'source-failed',
      sourceStatus: 'UPLOADED',
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    const firstRestartBody = JSON.parse(
      String(fetchMock.mock.calls[3]?.[1]?.body),
    ) as { intentKey: string }
    const repeatedRestartBody = JSON.parse(
      String(fetchMock.mock.calls[4]?.[1]?.body),
    ) as { intentKey: string }
    expect(firstRestartBody.intentKey).toBe(restartRetry.intentKey)
    expect(repeatedRestartBody.intentKey).toBe(firstRestartBody.intentKey)
    expect(watchJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: 'job-restarted' }),
    )
  })

  it.each(['UPLOADED', 'CONFIRMED'] as const)(
    'continues a %s upload session without transmitting the PDF again',
    async (state) => {
      const watchJob = vi.fn<WatchWalletSyncJob>(async () => ({
        id: 'job-retry', state: 'SUCCEEDED', processedRecords: 3,
      }))
      const responses = [
        jsonResponse({ uploadId: 'upload-retry', uploadUrl: '/api/v1/uploads/upload-retry/content', state }, 201),
        jsonResponse({ source: { id: 'source-retry' }, job: { id: 'job-retry' } }, 201),
      ]
      const fetchMock = vi.fn<typeof fetch>(async () => responses.shift() as Response)
      vi.stubGlobal('fetch', fetchMock)

      const result = await createRegisterUpbitPdfApi(watchJob)(
        registrationRequest(() => undefined),
      )

      expect(result.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    },
  )

  it('restarts an upload with a new intent when its stored session is terminal', async () => {
    const watchJob = vi.fn<WatchWalletSyncJob>(async () => ({
      id: 'job-new-upload',
      state: 'SUCCEEDED',
      processedRecords: 4,
    }))
    const responses = [
      jsonResponse({ uploadId: 'upload-expired', uploadUrl: '/api/v1/uploads/upload-expired/content', state: 'EXPIRED' }, 201),
      jsonResponse({ uploadId: 'upload-new', uploadUrl: '/api/v1/uploads/upload-new/content', state: 'PENDING' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ source: { id: 'source-new-upload' }, job: { id: 'job-new-upload' } }, 201),
    ]
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift() as Response)
    vi.stubGlobal('fetch', fetchMock)
    const registerPdf = createRegisterUpbitPdfApi(watchJob)

    const expired = await registerPdf(registrationRequest(() => undefined))
    expect(expired).toMatchObject({
      ok: false,
      error: {
        code: 'UPLOAD_FAILED',
        retry: {
          intentKey: expect.any(String),
          mode: 'restart-upload',
        },
      },
    })
    if (
      expired.ok ||
      !expired.error.retry ||
      expired.error.retry.mode !== 'restart-upload'
    ) {
      throw new Error('Expected upload restart context')
    }

    await expect(
      registerPdf(registrationRequest(() => undefined, {
        retry: expired.error.retry,
      })),
    ).resolves.toEqual({
      ok: true,
      sourceId: 'source-new-upload',
      sourceStatus: 'UPLOADED',
    })
    const restartedUploadBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { intentKey: string }
    expect(restartedUploadBody.intentKey).toBe(expired.error.retry.intentKey)
    expect(watchJob).toHaveBeenCalledTimes(1)
  })
})
