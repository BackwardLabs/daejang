import { ApiClientError, requestApi, requestRaw } from '../../api/client.ts'
import { watchSyncJob } from './sourceApi.ts'
import type { WatchWalletSyncJob } from './evmWalletFlow.ts'
import {
  createUpbitPdfIntentKey,
  type RegisterUpbitPdf,
  type UpbitPdfRegistrationErrorCode,
  type UpbitPdfRetryContext,
} from './upbitPdfRegistration.ts'

const DEFAULT_UPBIT_JOB_TIMEOUT_MS = 5 * 60_000

class UpbitJobTimeoutError extends Error {
  constructor() {
    super('Upbit PDF processing timed out.')
    this.name = 'UpbitJobTimeoutError'
  }
}

class UploadSessionUnavailableError extends Error {
  readonly retry: UpbitPdfRetryContext

  constructor(state: string) {
    super(`Upload session cannot continue from state ${state}.`)
    this.name = 'UploadSessionUnavailableError'
    this.retry = {
      intentKey: createUpbitPdfIntentKey(),
      mode: 'restart-upload',
    }
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

const errorCode = (error: unknown): UpbitPdfRegistrationErrorCode => {
  if (isAbortError(error)) return 'UPLOAD_CANCELLED'
  if (error instanceof ApiClientError) {
    if (error.status === 409) return 'DUPLICATE_SOURCE'
    if (error.code === 'UPBIT_PDF_LAYOUT_UNSUPPORTED') {
      return 'UNSUPPORTED_DOCUMENT'
    }
    if (error.code === 'ENCRYPTED_PDF' || error.code === 'INVALID_PDF') {
      return 'ENCRYPTED_OR_DAMAGED_DOCUMENT'
    }
    if (
      error.code === 'INVALID_COVERAGE_PERIOD' ||
      error.code === 'INVALID_SYNC_PERIOD'
    ) {
      return 'INVALID_PERIOD'
    }
    if (error.status >= 500) return 'PROCESSING_FAILED'
  }
  return 'UPLOAD_FAILED'
}

const jobErrorCode = (failureCode?: string): UpbitPdfRegistrationErrorCode => {
  if (failureCode === 'UPBIT_PDF_LAYOUT_UNSUPPORTED') return 'UNSUPPORTED_DOCUMENT'
  if (failureCode === 'INVALID_PDF' || failureCode === 'DIGEST_MISMATCH') {
    return 'ENCRYPTED_OR_DAMAGED_DOCUMENT'
  }
  return 'PROCESSING_FAILED'
}

async function watchJobWithin(
  watchJob: WatchWalletSyncJob,
  request: {
    jobId: string
    signal: AbortSignal
  },
  timeoutMs: number,
) {
  if (request.signal.aborted) {
    throw new DOMException('Upbit PDF processing was aborted.', 'AbortError')
  }

  const watchController = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let handleAbort = () => undefined
  const boundary = new Promise<never>((_resolve, reject) => {
    handleAbort = () => {
      reject(new DOMException('Upbit PDF processing was aborted.', 'AbortError'))
      watchController.abort()
    }
    request.signal.addEventListener('abort', handleAbort, { once: true })
    timeoutId = globalThis.setTimeout(() => {
      reject(new UpbitJobTimeoutError())
      watchController.abort()
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      watchJob({
        jobId: request.jobId,
        onUpdate: () => undefined,
        signal: watchController.signal,
      }),
      boundary,
    ])
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    request.signal.removeEventListener('abort', handleAbort)
    watchController.abort()
  }
}

function retryForTerminalFailure(
  code: UpbitPdfRegistrationErrorCode,
  sourceId: string,
): UpbitPdfRetryContext | undefined {
  if (code !== 'PROCESSING_FAILED') return undefined

  return {
    mode: 'restart-job',
    sourceId,
    intentKey: createUpbitPdfIntentKey(),
  }
}

export const createRegisterUpbitPdfApi = (
  watchJob: WatchWalletSyncJob,
  { jobTimeoutMs = DEFAULT_UPBIT_JOB_TIMEOUT_MS }: { jobTimeoutMs?: number } = {},
): RegisterUpbitPdf => async ({
  file,
  intentKey,
  retry,
  coverageStart,
  coverageEnd,
  onStageChange,
  signal,
}) => {
    let activeJobId: string | undefined
    let activeRetry = retry

    try {
      let sourceId: string

      if (retry?.mode === 'resume-job') {
        sourceId = retry.sourceId
        activeJobId = retry.jobId
      } else if (retry?.mode === 'restart-job') {
        onStageChange('SOURCE_SUBMITTING')
        const result = await requestApi<{ job: { id: string } }>('/syncs', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            sourceKind: 'UPBIT_PDF',
            sourceId: retry.sourceId,
            coverageStart,
            coverageEnd,
            trigger: 'USER_REQUEST',
            intentKey: retry.intentKey,
          }),
        })
        sourceId = retry.sourceId
        activeJobId = result.job.id
        activeRetry = {
          mode: 'resume-job',
          sourceId,
          jobId: activeJobId,
        }
      } else {
        onStageChange('DOCUMENT_UPLOADING')
        const upload = await requestApi<{
          uploadId: string
          uploadUrl: string
          state: string
        }>('/uploads', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            filename: file.name,
            mediaType: 'application/pdf',
            sizeBytes: file.size,
            intentKey:
              retry?.mode === 'restart-upload'
                ? retry.intentKey
                : intentKey,
          }),
        })
        if (upload.state === 'PENDING') {
          await requestRaw(upload.uploadUrl.replace(/^\/api\/v1/, ''), {
            method: 'PUT',
            signal,
            body: file,
            headers: { 'content-type': 'application/pdf' },
          })
        } else if (
          upload.state !== 'UPLOADED' &&
          upload.state !== 'CONFIRMED'
        ) {
          throw new UploadSessionUnavailableError(upload.state)
        }
        onStageChange('SOURCE_SUBMITTING')
        const result = await requestApi<{
          source: { id: string }
          job: { id: string }
        }>(`/uploads/${upload.uploadId}/confirm`, {
          method: 'POST',
          signal,
          body: JSON.stringify({ coverageStart, coverageEnd }),
        })
        sourceId = result.source.id
        activeJobId = result.job.id
        activeRetry = {
          mode: 'resume-job',
          sourceId,
          jobId: activeJobId,
        }
      }

      onStageChange('DOCUMENT_PROCESSING')
      const terminal = await watchJobWithin(
        watchJob,
        { jobId: activeJobId, signal },
        Math.max(1, jobTimeoutMs),
      )
      if (terminal.state === 'FAILED') {
        const code = jobErrorCode(terminal.failureCode)
        const terminalRetry = retryForTerminalFailure(code, sourceId)
        return {
          ok: false,
          error: {
            code,
            requestId: terminal.id,
            ...(terminalRetry ? { retry: terminalRetry } : {}),
          },
        }
      }
      return { ok: true, sourceId, sourceStatus: 'UPLOADED' }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (error instanceof UploadSessionUnavailableError) {
        return {
          ok: false,
          error: {
            code: 'UPLOAD_FAILED',
            retry: error.retry,
          },
        }
      }
      if (error instanceof UpbitJobTimeoutError) {
        return {
          ok: false,
          error: {
            code: 'PROCESSING_TIMEOUT',
            ...(activeJobId ? { requestId: activeJobId } : {}),
            ...(activeRetry ? { retry: activeRetry } : {}),
          },
        }
      }

      const mappedCode = errorCode(error)
      const retryTargetsJob =
        activeRetry?.mode === 'resume-job' ||
        activeRetry?.mode === 'restart-job'
      const code =
        retryTargetsJob && mappedCode === 'UPLOAD_FAILED'
          ? 'PROCESSING_FAILED'
          : mappedCode
      const canRetryExistingWork =
        activeRetry && (code === 'PROCESSING_FAILED' || code === 'UPLOAD_FAILED')
      return {
        ok: false,
        error: {
          code,
          ...(activeJobId || error instanceof ApiClientError
            ? { requestId: activeJobId ?? (error as ApiClientError).code }
            : {}),
          ...(canRetryExistingWork ? { retry: activeRetry } : {}),
        },
      }
    }
  }

export const registerUpbitPdfApi = createRegisterUpbitPdfApi(watchSyncJob)
