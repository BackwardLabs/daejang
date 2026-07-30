import { requestApi } from '../../api/client.ts'
import type {
  OnchainAttestationEvidence,
  ReportAttestationLifecycle,
  ReportVerification,
  ReportVerificationResult,
} from './reportAttestationApi.ts'

const giwaNetwork = 'eip155:91342' as const
const giwaMode = 'SYNTHETIC_TESTNET' as const
const giwaExplorerBaseUrl =
  'https://sepolia-explorer.giwa.io' as const
const localNetwork = 'eip155:31337' as const
const localMode = 'LOCAL_ANVIL' as const

type SyntheticReportAttestationEnvironment =
  | Readonly<{
      network: typeof giwaNetwork
      mode: typeof giwaMode
      explorerBaseUrl: typeof giwaExplorerBaseUrl
    }>
  | Readonly<{
      network: typeof localNetwork
      mode: typeof localMode
      explorerBaseUrl: null
    }>

export type SyntheticReportAttestationCapability =
  SyntheticReportAttestationEnvironment &
    (
      | Readonly<{
          enabled: false
          reasonCode: string
        }>
      | Readonly<{
          enabled: true
          reasonCode: null
        }>
    )

export type SyntheticReportFixture = Readonly<{
  taxYear: 2025
  transactionCount: 12
  completeCount: 10
  exceptionCount: 2
  denomination: 'KRW'
}>

export type SyntheticReportAttestationStatus = Readonly<{
  lifecycle: ReportAttestationLifecycle
  failureCode: string | null
  reasonCode: string | null
  submissionConfirmed: boolean
  reviewConfirmed: boolean
  submissionEvidence: OnchainAttestationEvidence | null
  reviewEvidence: OnchainAttestationEvidence | null
}>

export type SyntheticReportAttestationSnapshot = Readonly<{
  capability: SyntheticReportAttestationCapability
  fixture: SyntheticReportFixture
  status: SyntheticReportAttestationStatus | null
  verification: ReportVerification | null
}>

export type SyntheticReportAttestationApi = Readonly<{
  load(signal?: AbortSignal): Promise<SyntheticReportAttestationSnapshot>
  submit(signal?: AbortSignal): Promise<SyntheticReportAttestationSnapshot>
  review(signal?: AbortSignal): Promise<SyntheticReportAttestationSnapshot>
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

const nonTerminalReceiptStatuses = new Set([
  'PENDING',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
])

const capabilityKeys = [
  'enabled',
  'network',
  'mode',
  'explorerBaseUrl',
  'reasonCode',
] as const
const fixtureKeys = [
  'taxYear',
  'transactionCount',
  'completeCount',
  'exceptionCount',
  'denomination',
] as const
const snapshotKeys = [
  'capability',
  'fixture',
  'status',
  'verification',
] as const
const statusKeys = [
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
  'lifecycle',
  'result',
  'reasonCode',
] as const

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

const isHex32 = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const isNullableHex32 = (value: unknown): value is string | null =>
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

const invalidResponse = (): never => {
  throw new Error('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')
}

type ParsedReceipt = Readonly<{
  kind: 'confirmed' | 'manual' | 'non-terminal' | 'failed'
  status: string
  transactionHash: string | null
  attestationUID: string | null
  reasonCode: string | null
}>

const parseReceipt = (value: unknown): ParsedReceipt | null => {
  if (value === null) return null
  if (!isExactRecord(value, receiptKeys) || typeof value.status !== 'string') {
    return invalidResponse()
  }

  if (value.status === 'CONFIRMED') {
    if (
      !isHex32(value.transactionHash) ||
      !isHex32(value.attestationUID) ||
      value.reasonCode !== null
    ) {
      return invalidResponse()
    }
    return {
      kind: 'confirmed',
      status: value.status,
      transactionHash: value.transactionHash,
      attestationUID: value.attestationUID,
      reasonCode: null,
    }
  }

  if (value.status === 'MANUAL_REVIEW') {
    if (
      value.transactionHash !== null ||
      value.attestationUID !== null ||
      typeof value.reasonCode !== 'string' ||
      !reasonCodePattern.test(value.reasonCode)
    ) {
      return invalidResponse()
    }
    return {
      kind: 'manual',
      status: value.status,
      transactionHash: null,
      attestationUID: null,
      reasonCode: value.reasonCode,
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
      return invalidResponse()
    }
    return {
      kind: 'non-terminal',
      status: value.status,
      transactionHash: value.transactionHash,
      attestationUID: value.attestationUID,
      reasonCode: value.reasonCode as string | null,
    }
  }

  if (value.status === 'FAILED') {
    if (
      value.transactionHash !== null ||
      value.attestationUID !== null ||
      value.reasonCode !== null
    ) {
      return invalidResponse()
    }
    return {
      kind: 'failed',
      status: value.status,
      transactionHash: null,
      attestationUID: null,
      reasonCode: null,
    }
  }

  return invalidResponse()
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
    case 'RECONCILIATION_REQUIRED':
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
        submission === null &&
        review === null &&
        failureCode ===
          'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION'
      ) {
        return true
      }
      if (failureCode !== null) return false
      if (!submissionConfirmed) {
        return (
          submission?.kind === 'non-terminal' &&
          submission.status === lifecycle &&
          review === null
        )
      }
      return review?.kind === 'non-terminal' && review.status === lifecycle
    case 'REVIEW_FAILED':
      if (!submissionConfirmed || review === null) return false
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

const parseCapability = (
  value: unknown,
): SyntheticReportAttestationCapability => {
  if (
    !isExactRecord(value, capabilityKeys)
  ) {
    return invalidResponse()
  }

  const environment: SyntheticReportAttestationEnvironment =
    value.network === giwaNetwork &&
    value.mode === giwaMode &&
    value.explorerBaseUrl === giwaExplorerBaseUrl
      ? {
          network: giwaNetwork,
          mode: giwaMode,
          explorerBaseUrl: giwaExplorerBaseUrl,
        }
      : import.meta.env.DEV &&
          import.meta.env.VITE_GIWA28_LOCAL_DEMO === 'true' &&
          value.network === localNetwork &&
          value.mode === localMode &&
          value.explorerBaseUrl === null
        ? {
            network: localNetwork,
            mode: localMode,
            explorerBaseUrl: null,
          }
        : invalidResponse()

  if (value.enabled === true && value.reasonCode === null) {
    return {
      ...environment,
      enabled: true,
      reasonCode: null,
    }
  }

  if (
    value.enabled === false &&
    typeof value.reasonCode === 'string' &&
    reasonCodePattern.test(value.reasonCode)
  ) {
    return {
      ...environment,
      enabled: false,
      reasonCode: value.reasonCode,
    }
  }

  return invalidResponse()
}

const parseFixture = (value: unknown): SyntheticReportFixture => {
  if (
    !isExactRecord(value, fixtureKeys) ||
    value.taxYear !== 2025 ||
    value.transactionCount !== 12 ||
    value.completeCount !== 10 ||
    value.exceptionCount !== 2 ||
    value.denomination !== 'KRW'
  ) {
    return invalidResponse()
  }
  return {
    taxYear: 2025,
    transactionCount: 12,
    completeCount: 10,
    exceptionCount: 2,
    denomination: 'KRW',
  }
}

const parseStatus = (
  value: unknown,
): SyntheticReportAttestationStatus | null => {
  if (value === null) return null
  if (
    !isExactRecord(value, statusKeys) ||
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
    return invalidResponse()
  }

  const lifecycle = value.lifecycle as ReportAttestationLifecycle
  const submission = parseReceipt(value.submission)
  const review = parseReceipt(value.review)
  const failureCode = value.failureCode as string | null
  if (!hasLifecycleInvariant(lifecycle, submission, review, failureCode)) {
    return invalidResponse()
  }

  const evidence = (
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
    lifecycle,
    failureCode,
    reasonCode:
      review?.reasonCode ??
      submission?.reasonCode ??
      failureCode,
    submissionConfirmed: submission?.kind === 'confirmed',
    reviewConfirmed: review?.kind === 'confirmed',
    submissionEvidence: evidence(submission),
    reviewEvidence: evidence(review),
  }
}

const parseVerification = (value: unknown): ReportVerification | null => {
  if (value === null) return null
  if (
    !isExactRecord(value, verificationKeys) ||
    !lifecycleValues.has(value.lifecycle as ReportAttestationLifecycle) ||
    !verificationValues.has(value.result as ReportVerificationResult) ||
    !(
      value.reasonCode === null ||
      (typeof value.reasonCode === 'string' &&
        reasonCodePattern.test(value.reasonCode))
    )
  ) {
    return invalidResponse()
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
    return invalidResponse()
  }

  return {
    lifecycle,
    result,
    reasonCode: value.reasonCode as string | null,
  }
}

export const parseSyntheticReportAttestationSnapshot = (
  value: unknown,
): SyntheticReportAttestationSnapshot => {
  if (!isExactRecord(value, snapshotKeys)) return invalidResponse()

  const capability = parseCapability(value.capability)
  const fixture = parseFixture(value.fixture)
  const status = parseStatus(value.status)
  const verification = parseVerification(value.verification)

  if (
    (verification !== null && status === null) ||
    (verification !== null &&
      status !== null &&
      verification.lifecycle !== status.lifecycle) ||
    (capability.enabled === false &&
      (status !== null || verification !== null))
  ) {
    return invalidResponse()
  }

  return { capability, fixture, status, verification }
}

const publicationPath = '/report-attestations/synthetic-publication'

const loadSnapshot = async (
  path: string,
  init: RequestInit,
): Promise<SyntheticReportAttestationSnapshot> =>
  parseSyntheticReportAttestationSnapshot(
    await requestApi<unknown>(path, init),
  )

export const syntheticReportAttestationApi: SyntheticReportAttestationApi = {
  load(signal) {
    return loadSnapshot(publicationPath, { signal })
  },
  submit(signal) {
    return loadSnapshot(`${publicationPath}/submission`, {
      method: 'POST',
      signal,
    })
  },
  review(signal) {
    return loadSnapshot(`${publicationPath}/review`, {
      method: 'POST',
      signal,
    })
  },
}

export const giwaExplorerTransactionUrl = (
  transactionHash: string,
  baseUrl: string = giwaExplorerBaseUrl,
) => `${baseUrl}/tx/${encodeURIComponent(transactionHash)}`
