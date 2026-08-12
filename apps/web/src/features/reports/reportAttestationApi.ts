import { requestApi } from '../../api/client.ts'

export type ReportAttestationLifecycle =
  | 'PREPARING'
  | 'PREPARED'
  | 'PREPARATION_FAILED'
  | 'SUBMISSION_QUEUED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'SUBMISSION_FAILED'
  | 'REVIEW_QUEUED'
  | 'REVIEWING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PENDING'
  | 'MANUAL_REVIEW'
  | 'RETRY_REQUIRED'
  | 'RECONCILIATION_REQUIRED'
  | 'REVIEW_FAILED'

export type ReportVerificationResult =
  | 'USABLE'
  | 'UNUSABLE'
  | 'VERIFY_FAILED'

export type OnchainAttestationEvidence = Readonly<{
  transactionHash: string
  attestationUID: string
}>

export type ReportAttestationStatus = Readonly<{
  reportId: string
  lifecycle: ReportAttestationLifecycle
  failureCode: string | null
  submissionConfirmed: boolean
  reviewConfirmed: boolean
  submissionEvidence: OnchainAttestationEvidence | null
  reviewEvidence: OnchainAttestationEvidence | null
}>

export type ReportVerification = Readonly<{
  lifecycle: ReportAttestationLifecycle
  result: ReportVerificationResult
  reasonCode: string | null
}>

export type LocalReportAttestationApi = Readonly<{
  prepare(
    reportId: string,
    signal?: AbortSignal,
  ): Promise<ReportAttestationStatus>
  prepareFixture(signal?: AbortSignal): Promise<ReportAttestationStatus>
  submit(
    reportId: string,
    signal?: AbortSignal,
  ): Promise<ReportAttestationStatus>
  review(
    reportId: string,
    signal?: AbortSignal,
  ): Promise<ReportAttestationStatus>
  getStatus(
    reportId: string,
    signal?: AbortSignal,
  ): Promise<ReportAttestationStatus>
  getVerification(
    reportId: string,
    signal?: AbortSignal,
  ): Promise<ReportVerification>
}>

const lifecycleValues = new Set<ReportAttestationLifecycle>([
  'PREPARING',
  'PREPARED',
  'PREPARATION_FAILED',
  'SUBMISSION_QUEUED',
  'SUBMITTING',
  'SUBMITTED',
  'SUBMISSION_FAILED',
  'REVIEW_QUEUED',
  'REVIEWING',
  'APPROVED',
  'REJECTED',
  'PENDING',
  'MANUAL_REVIEW',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'REVIEW_FAILED',
])

const verificationValues = new Set<ReportVerificationResult>([
  'USABLE',
  'UNUSABLE',
  'VERIFY_FAILED',
])

const statusKeys = [
  'reportId',
  'lifecycle',
  'submission',
  'review',
  'failureCode',
  'createdAt',
  'updatedAt',
] as const
const receiptKeys = [
  'status',
  'transactionHash',
  'attestationUID',
  'reasonCode',
] as const
const verificationKeys = [
  'reportId',
  'lifecycle',
  'result',
  'reasonCode',
] as const
const nonTerminalReceiptStatuses = new Set([
  'PENDING',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
])
const failureCodes = new Set([
  'PREPARATION_EXECUTION_FAILED',
  'PREPARATION_RESULT_REJECTED',
  'ISSUER_EXECUTION_FAILED',
  'ISSUER_RESULT_REJECTED',
  'REVIEWER_EXECUTION_FAILED',
  'REVIEWER_RESULT_REJECTED',
  'REVIEW_RECONCILIATION_FAILED',
  'REVIEW_OUTCOME_MISMATCH',
  'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION',
  'RUNTIME_CLOSED',
])
const preparationFailureCodes = new Set([
  'PREPARATION_EXECUTION_FAILED',
  'PREPARATION_RESULT_REJECTED',
])
const submissionFailureCodes = new Set([
  'ISSUER_EXECUTION_FAILED',
  'ISSUER_RESULT_REJECTED',
  'RUNTIME_CLOSED',
])
const reasonCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isExactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

const isHex32 = (value: unknown) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const isNullableHex32 = (value: unknown) =>
  value === null || isHex32(value)

const isIsoTimestamp = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

type ParsedReceipt = Readonly<{
  kind: 'confirmed' | 'manual' | 'non-terminal' | 'failed'
  status: string
  transactionHash: string | null
  attestationUID: string | null
}>

const invalidStatusResponse = (): never => {
  throw new Error('REPORT_ATTESTATION_RESPONSE_INVALID')
}

const parseReceipt = (value: unknown): ParsedReceipt | null => {
  if (value === null) {
    return null
  }
  if (!isExactRecord(value, receiptKeys) || typeof value.status !== 'string') {
    return invalidStatusResponse()
  }

  if (value.status === 'CONFIRMED') {
    if (
      !isHex32(value.transactionHash) ||
      !isHex32(value.attestationUID) ||
      value.reasonCode !== null
    ) {
      return invalidStatusResponse()
    }
    return {
      kind: 'confirmed',
      status: value.status,
      transactionHash: value.transactionHash as string,
      attestationUID: value.attestationUID as string,
    }
  }
  if (value.status === 'MANUAL_REVIEW') {
    if (
      value.transactionHash !== null ||
      value.attestationUID !== null ||
      typeof value.reasonCode !== 'string' ||
      !reasonCodePattern.test(value.reasonCode)
    ) {
      return invalidStatusResponse()
    }
    return {
      kind: 'manual',
      status: value.status,
      transactionHash: null,
      attestationUID: null,
    }
  }
  if (nonTerminalReceiptStatuses.has(value.status)) {
    if (
      !isNullableHex32(value.transactionHash) ||
      !isNullableHex32(value.attestationUID) ||
      !(
        value.reasonCode === null ||
        (typeof value.reasonCode === 'string' &&
          reasonCodePattern.test(value.reasonCode))
      )
    ) {
      return invalidStatusResponse()
    }
    return {
      kind: 'non-terminal',
      status: value.status,
      transactionHash:
        typeof value.transactionHash === 'string'
          ? value.transactionHash
          : null,
      attestationUID:
        typeof value.attestationUID === 'string'
          ? value.attestationUID
          : null,
    }
  }
  if (value.status === 'FAILED') {
    if (
      value.transactionHash !== null ||
      value.attestationUID !== null ||
      value.reasonCode !== null
    ) {
      return invalidStatusResponse()
    }
    return {
      kind: 'failed',
      status: value.status,
      transactionHash: null,
      attestationUID: null,
    }
  }
  return invalidStatusResponse()
}

const hasLifecycleInvariant = (
  lifecycle: ReportAttestationLifecycle,
  submission: ParsedReceipt | null,
  review: ParsedReceipt | null,
  failureCode: string | null,
) => {
  const submissionConfirmed = submission?.kind === 'confirmed'
  const reviewConfirmed = review?.kind === 'confirmed'
  switch (lifecycle) {
    case 'PREPARING':
    case 'PREPARED':
      return submission === null && review === null && failureCode === null
    case 'PREPARATION_FAILED':
      return (
        submission === null &&
        review === null &&
        failureCode !== null &&
        preparationFailureCodes.has(failureCode)
      )
    case 'SUBMISSION_QUEUED':
    case 'SUBMITTING':
      return (
        review === null &&
        failureCode === null &&
        (submission === null || submission.kind === 'non-terminal')
      )
    case 'SUBMITTED':
      return submissionConfirmed && review === null && failureCode === null
    case 'SUBMISSION_FAILED':
      return (
        submission?.kind === 'failed' &&
        review === null &&
        failureCode !== null &&
        submissionFailureCodes.has(failureCode)
      )
    case 'REVIEW_QUEUED':
    case 'REVIEWING':
      return (
        submissionConfirmed &&
        failureCode === null &&
        (review === null ||
          review.kind === 'confirmed' ||
          review.kind === 'non-terminal')
      )
    case 'APPROVED':
    case 'REJECTED':
      return submissionConfirmed && reviewConfirmed && failureCode === null
    case 'MANUAL_REVIEW':
      return (
        submissionConfirmed &&
        review?.kind === 'manual' &&
        failureCode === null
      )
    case 'PENDING':
    case 'RETRY_REQUIRED':
    case 'RECONCILIATION_REQUIRED': {
      if (
        lifecycle === 'RECONCILIATION_REQUIRED' &&
        submissionConfirmed &&
        reviewConfirmed &&
        failureCode === 'REVIEW_RECONCILIATION_FAILED'
      ) {
        return true
      }
      if (
        lifecycle === 'RECONCILIATION_REQUIRED' &&
        failureCode === 'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION'
      ) {
        if (!submissionConfirmed) {
          return (
            submission?.kind === 'non-terminal' &&
            submission.status === 'RECONCILIATION_REQUIRED' &&
            review === null
          )
        }
        return (
          review?.kind === 'non-terminal' &&
          review.status === 'RECONCILIATION_REQUIRED'
        )
      }
      if (failureCode !== null) {
        return false
      }
      if (!submissionConfirmed) {
        return (
          submission?.kind === 'non-terminal' &&
          submission.status === lifecycle &&
          review === null
        )
      }
      return (
        review?.kind === 'non-terminal' && review.status === lifecycle
      )
    }
    case 'REVIEW_FAILED':
      if (!submissionConfirmed || review === null) {
        return false
      }
      if (
        failureCode === 'REVIEWER_EXECUTION_FAILED' ||
        failureCode === 'REVIEWER_RESULT_REJECTED' ||
        failureCode === 'RUNTIME_CLOSED'
      ) {
        return review.kind === 'failed'
      }
      if (failureCode === 'REVIEW_OUTCOME_MISMATCH') {
        return review.kind === 'confirmed' || review.kind === 'manual'
      }
      return false
  }
}

const parseStatus = (
  value: unknown,
  expectedReportId?: string,
): ReportAttestationStatus => {
  if (
    !isExactRecord(value, statusKeys) ||
    typeof value.reportId !== 'string' ||
    value.reportId.length === 0 ||
    value.reportId.length > 120 ||
    (expectedReportId !== undefined && value.reportId !== expectedReportId) ||
    !lifecycleValues.has(value.lifecycle as ReportAttestationLifecycle) ||
    !(
      value.failureCode === null ||
      (typeof value.failureCode === 'string' &&
        failureCodes.has(value.failureCode))
    ) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt)
  ) {
    return invalidStatusResponse()
  }

  const lifecycle = value.lifecycle as ReportAttestationLifecycle
  const submission = parseReceipt(value.submission)
  const review = parseReceipt(value.review)
  const failureCode = value.failureCode
  if (
    !hasLifecycleInvariant(
      lifecycle,
      submission,
      review,
      failureCode,
    )
  ) {
    return invalidStatusResponse()
  }

  const confirmedEvidence = (
    receipt: ParsedReceipt | null,
  ): OnchainAttestationEvidence | null =>
    receipt?.kind === 'confirmed' &&
    receipt.transactionHash !== null &&
    receipt.attestationUID !== null
      ? {
          transactionHash: receipt.transactionHash,
          attestationUID: receipt.attestationUID,
        }
      : null

  return {
    reportId: value.reportId,
    lifecycle,
    failureCode,
    submissionConfirmed: submission?.kind === 'confirmed',
    reviewConfirmed: review?.kind === 'confirmed',
    submissionEvidence: confirmedEvidence(submission),
    reviewEvidence: confirmedEvidence(review),
  }
}

const parseVerification = (
  value: unknown,
  expectedReportId: string,
): ReportVerification => {
  if (
    !isExactRecord(value, verificationKeys) ||
    value.reportId !== expectedReportId ||
    !lifecycleValues.has(value.lifecycle as ReportAttestationLifecycle) ||
    !verificationValues.has(value.result as ReportVerificationResult) ||
    !(
      value.reasonCode === null ||
      (typeof value.reasonCode === 'string' &&
        reasonCodePattern.test(value.reasonCode))
    )
  ) {
    throw new Error('REPORT_VERIFICATION_RESPONSE_INVALID')
  }

  const lifecycle = value.lifecycle as ReportAttestationLifecycle
  const result = value.result as ReportVerificationResult
  if (
    (result === 'USABLE' &&
      (lifecycle !== 'APPROVED' || value.reasonCode !== null)) ||
    (result === 'VERIFY_FAILED' &&
      (lifecycle !== 'APPROVED' || value.reasonCode === null)) ||
    (result === 'UNUSABLE' && value.reasonCode === null)
  ) {
    throw new Error('REPORT_VERIFICATION_RESPONSE_INVALID')
  }

  return {
    lifecycle,
    result,
    reasonCode: value.reasonCode,
  }
}

const reportPath = (reportId: string) =>
  `/reports/${encodeURIComponent(reportId)}`

export const localReportAttestationApi: LocalReportAttestationApi = {
  async prepare(reportId, signal) {
    return parseStatus(
      await requestApi<unknown>(
        `${reportPath(reportId)}/attestation-preparation`,
        {
          method: 'POST',
          signal,
        },
      ),
      reportId,
    )
  },

  async prepareFixture(signal) {
    return parseStatus(
      await requestApi<unknown>('/dev/reports/attestation-fixture', {
        method: 'POST',
        signal,
      }),
    )
  },

  async submit(reportId, signal) {
    return parseStatus(
      await requestApi<unknown>(`${reportPath(reportId)}/attestations`, {
        method: 'POST',
        signal,
      }),
      reportId,
    )
  },

  async review(reportId, signal) {
    return parseStatus(
      await requestApi<unknown>(
        `/dev${reportPath(reportId)}/attestation-review`,
        {
          method: 'POST',
          signal,
        },
      ),
      reportId,
    )
  },

  async getStatus(reportId, signal) {
    return parseStatus(
      await requestApi<unknown>(`${reportPath(reportId)}/attestation`, {
        signal,
      }),
      reportId,
    )
  },

  async getVerification(reportId, signal) {
    return parseVerification(
      await requestApi<unknown>(`${reportPath(reportId)}/verification`, {
        signal,
      }),
      reportId,
    )
  },
}

export class ReportAttestationPollingTimeoutError extends Error {
  constructor() {
    super('REPORT_ATTESTATION_POLLING_TIMEOUT')
    this.name = 'ReportAttestationPollingTimeoutError'
  }
}

export class ReportAttestationLifecycleError extends Error {
  readonly lifecycle: ReportAttestationLifecycle

  constructor(lifecycle: ReportAttestationLifecycle) {
    super('REPORT_ATTESTATION_LIFECYCLE_FAILED')
    this.name = 'ReportAttestationLifecycleError'
    this.lifecycle = lifecycle
  }
}

const abortError = () =>
  new DOMException('The operation was aborted.', 'AbortError')

const positiveFinite = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback

export async function runReportAttestationRequestWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: Readonly<{
    signal?: AbortSignal
    timeoutMs: number
  }>,
) {
  if (options.signal?.aborted) {
    throw abortError()
  }

  const childController = new AbortController()
  const timeoutMs = Math.max(
    1,
    positiveFinite(options.timeoutMs, 15_000),
  )
  let timeout: number | undefined
  let rejectExternalAbort: (error: DOMException) => void = () => undefined
  const externalAbortPromise = new Promise<T>((_, reject) => {
    rejectExternalAbort = reject
  })
  const onExternalAbort = () => {
    rejectExternalAbort(abortError())
    childController.abort()
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = window.setTimeout(() => {
      reject(new ReportAttestationPollingTimeoutError())
      childController.abort()
    }, timeoutMs)
  })
  const operationPromise = Promise.resolve().then(() =>
    operation(childController.signal),
  )

  try {
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      externalAbortPromise,
    ])
  } finally {
    if (timeout !== undefined) {
      window.clearTimeout(timeout)
    }
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    let timeout: number | undefined
    const cleanup = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    timeout = window.setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export async function pollReportAttestationStatus(
  loadStatus: (
    reportId: string,
    signal?: AbortSignal,
  ) => Promise<ReportAttestationStatus>,
  reportId: string,
  options: Readonly<{
    done: (status: ReportAttestationStatus) => boolean
    failed: (status: ReportAttestationStatus) => boolean
    signal?: AbortSignal
    intervalMs?: number
    timeoutMs?: number
    requestRetries?: number
  }>,
) {
  const intervalMs = Math.max(
    1,
    positiveFinite(options.intervalMs, 250),
  )
  const timeoutMs = Math.max(
    1,
    positiveFinite(options.timeoutMs, 15_000),
  )
  const requestRetries =
    options.requestRetries !== undefined &&
    Number.isFinite(options.requestRetries) &&
    options.requestRetries >= 0
      ? Math.floor(options.requestRetries)
      : 2
  const deadline = Date.now() + timeoutMs
  let consecutiveErrors = 0

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) {
      throw abortError()
    }

    try {
      const remainingRequestMs = deadline - Date.now()
      if (remainingRequestMs <= 0) {
        break
      }
      const status = await runReportAttestationRequestWithTimeout(
        (requestSignal) => loadStatus(reportId, requestSignal),
        {
          signal: options.signal,
          timeoutMs: remainingRequestMs,
        },
      )
      consecutiveErrors = 0
      if (options.failed(status)) {
        throw new ReportAttestationLifecycleError(status.lifecycle)
      }
      if (options.done(status)) {
        return status
      }
    } catch (error) {
      if (
        error instanceof ReportAttestationLifecycleError ||
        error instanceof ReportAttestationPollingTimeoutError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error
      }
      consecutiveErrors += 1
      if (consecutiveErrors > requestRetries) {
        throw error
      }
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      break
    }
    await wait(Math.min(intervalMs, remainingMs), options.signal)
  }

  throw new ReportAttestationPollingTimeoutError()
}
