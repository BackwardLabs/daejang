import {
  LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
  type Hex32,
  type LocalReportAttestationRuntime,
  type PreparedReportInput,
  type PreparedSyntheticEvidence,
  type RedactedExecutionResult,
  type ReportReviewOutcome,
} from './types.js'

const CONTRACTS_MODULE_SPECIFIER =
  '@backward-labs/daejang-contracts/local-v1'
const CONTRACTS_FACTORY_EXPORT = 'createLocalDurableAttestationRuntimeV1'
const CONTRACTS_KIND_EXPORT = 'LOCAL_DURABLE_RUNTIME_KIND_V1'
const CONTRACTS_EXECUTION_STATUSES = new Set([
  'PENDING',
  'CONFIRMED',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
])
const LOCAL_MANUAL_REVIEW_REASON = 'LOCAL_FIXTURE_UNCERTAIN'

type UnknownRecord = Record<string, unknown>
type UnknownFunction = (...args: unknown[]) => unknown

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: UnknownRecord, expected: readonly string[]) => {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

const isHex32 = (value: unknown): value is Hex32 =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isNullableHex32 = (value: unknown): value is Hex32 | null =>
  value === null || isHex32(value)

const incompatibleRuntime = () =>
  new LocalContractsRuntimeError(
    'LOCAL_CONTRACTS_RUNTIME_INCOMPATIBLE',
    '설치된 로컬 contracts runtime의 인터페이스를 확인할 수 없습니다.',
  )

const validateExecutionResult = (
  value: unknown,
): RedactedExecutionResult => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'status',
      'transactionHash',
      'attestationUID',
      'reasonCode',
    ]) ||
    typeof value.status !== 'string' ||
    !CONTRACTS_EXECUTION_STATUSES.has(value.status) ||
    !isNullableHex32(value.transactionHash) ||
    !isNullableHex32(value.attestationUID) ||
    !isNullableString(value.reasonCode)
  ) {
    throw incompatibleRuntime()
  }
  if (
    (value.status === 'CONFIRMED' &&
      (!isHex32(value.transactionHash) ||
        !isHex32(value.attestationUID) ||
        value.reasonCode !== null)) ||
    (value.status === 'MANUAL_REVIEW' &&
      (value.transactionHash !== null ||
        value.attestationUID !== null ||
        value.reasonCode !== LOCAL_MANUAL_REVIEW_REASON)) ||
    (value.status !== 'CONFIRMED' &&
      value.status !== 'MANUAL_REVIEW' &&
      value.reasonCode !== null)
  ) {
    throw incompatibleRuntime()
  }
  return {
    status: value.status,
    transactionHash: value.transactionHash,
    attestationUID: value.attestationUID,
    reasonCode: value.reasonCode,
  }
}

const validatePreparedEvidence = (
  value: unknown,
): PreparedSyntheticEvidence => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'preparedRecordId',
      'reportId',
      'revision',
      'commitment',
    ]) ||
    typeof value.preparedRecordId !== 'string' ||
    !isHex32(value.reportId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    !isHex32(value.commitment)
  ) {
    throw incompatibleRuntime()
  }
  return {
    preparedRecordId: value.preparedRecordId,
    reportId: value.reportId,
    revision: value.revision as number,
    commitment: value.commitment,
  }
}

const validateVerification = (
  value: unknown,
): { result: 'USABLE' | 'UNUSABLE'; reason: string | null } => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['result', 'reason']) ||
    (value.result !== 'USABLE' && value.result !== 'UNUSABLE') ||
    !isNullableString(value.reason)
  ) {
    throw incompatibleRuntime()
  }
  return {
    result: value.result,
    reason: value.reason,
  }
}

export class LocalContractsRuntimeError extends Error {
  constructor(
    readonly code:
      | 'LOCAL_CONTRACTS_NOT_ALLOWED'
      | 'LOCAL_CONTRACTS_OUTCOME_LOCKED'
      | 'LOCAL_CONTRACTS_MODULE_UNAVAILABLE'
      | 'LOCAL_CONTRACTS_RUNTIME_INCOMPATIBLE',
    message: string,
  ) {
    super(message)
    this.name = 'LocalContractsRuntimeError'
  }
}

const createValidatedRuntime = async (
  reviewOutcome: ReportReviewOutcome,
): Promise<LocalReportAttestationRuntime> => {
  let loadedModule: unknown
  try {
    loadedModule = await import(CONTRACTS_MODULE_SPECIFIER)
  } catch {
    throw new LocalContractsRuntimeError(
      'LOCAL_CONTRACTS_MODULE_UNAVAILABLE',
      '로컬 contracts package를 불러오지 못했습니다.',
    )
  }
  if (!isRecord(loadedModule)) {
    throw incompatibleRuntime()
  }
  const exportedKind = loadedModule[CONTRACTS_KIND_EXPORT]
  const factory = loadedModule[CONTRACTS_FACTORY_EXPORT]
  if (
    exportedKind !== LOCAL_REPORT_ATTESTATION_RUNTIME_KIND ||
    typeof factory !== 'function'
  ) {
    throw incompatibleRuntime()
  }

  let rawRuntime: unknown
  try {
    rawRuntime = await (factory as UnknownFunction)({
      defaultFixtureReviewOutcome: reviewOutcome,
    })
  } catch {
    throw new LocalContractsRuntimeError(
      'LOCAL_CONTRACTS_MODULE_UNAVAILABLE',
      '로컬 contracts runtime을 시작하지 못했습니다.',
    )
  }
  if (
    !isRecord(rawRuntime) ||
    rawRuntime.kind !== LOCAL_REPORT_ATTESTATION_RUNTIME_KIND ||
    !isRecord(rawRuntime.issuerExecutor) ||
    typeof rawRuntime.issuerExecutor.executeIssuer !== 'function' ||
    !isRecord(rawRuntime.reviewerExecutor) ||
    typeof rawRuntime.reviewerExecutor.executeReviewer !== 'function' ||
    typeof rawRuntime.prepareSyntheticEvidence !== 'function' ||
    typeof rawRuntime.isUsable !== 'function' ||
    typeof rawRuntime.verifyPreparedReport !== 'function' ||
    typeof rawRuntime.close !== 'function'
  ) {
    if (
      isRecord(rawRuntime) &&
      typeof rawRuntime.close === 'function'
    ) {
      try {
        await (rawRuntime.close as UnknownFunction).call(rawRuntime)
      } catch {
        // The stable compatibility error below is the only surfaced failure.
      }
    }
    throw incompatibleRuntime()
  }

  const issuer = rawRuntime.issuerExecutor
  const reviewer = rawRuntime.reviewerExecutor
  const prepare = rawRuntime.prepareSyntheticEvidence as UnknownFunction
  const usable = rawRuntime.isUsable as UnknownFunction
  const verify = rawRuntime.verifyPreparedReport as UnknownFunction
  const closeRuntime = rawRuntime.close as UnknownFunction
  let closePromise: Promise<void> | undefined

  return {
    kind: LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
    issuerExecutor: {
      executeIssuer: async (input) =>
        validateExecutionResult(
          await (
            issuer.executeIssuer as UnknownFunction
          ).call(issuer, input),
        ),
    },
    reviewerExecutor: {
      executeReviewer: async (input) =>
        validateExecutionResult(
          await (
            reviewer.executeReviewer as UnknownFunction
          ).call(reviewer, input),
        ),
    },
    prepareSyntheticEvidence: async (
      input: PreparedReportInput,
    ): Promise<PreparedSyntheticEvidence> =>
      validatePreparedEvidence(
        await prepare.call(rawRuntime, {
          preparedRecordId: input.preparedRecordId,
          reportId: input.reportId,
          revision: input.revision,
          safeArtifactBytes: input.safeArtifactBytes,
          ...(input.previousSubmissionUID
            ? {
                previousSubmissionUID:
                  input.previousSubmissionUID,
              }
            : {}),
        }),
      ),
    isUsable: async (reportId, approvalUID) => {
      const result = await usable.call(rawRuntime, reportId, approvalUID)
      if (typeof result !== 'boolean') {
        throw incompatibleRuntime()
      }
      return result
    },
    verifyPreparedReport: async (input) =>
      validateVerification(await verify.call(rawRuntime, input)),
    close: () => {
      if (!closePromise) {
        closePromise = Promise.resolve()
          .then(async () => {
            await closeRuntime.call(rawRuntime)
          })
          .catch(() => {
            throw new LocalContractsRuntimeError(
              'LOCAL_CONTRACTS_RUNTIME_INCOMPATIBLE',
              '로컬 contracts runtime을 종료하지 못했습니다.',
            )
          })
      }
      return closePromise
    },
  }
}

let singleton:
  | {
      reviewOutcome: ReportReviewOutcome
      runtime: Promise<LocalReportAttestationRuntime>
    }
  | undefined

export const loadLocalReportAttestationRuntime = (options: {
  runtimeMode: 'development' | 'test' | 'production'
  reviewOutcome: ReportReviewOutcome
}) => {
  if (options.runtimeMode === 'production') {
    throw new LocalContractsRuntimeError(
      'LOCAL_CONTRACTS_NOT_ALLOWED',
      'production에서는 로컬 contracts runtime을 사용할 수 없습니다.',
    )
  }
  if (singleton) {
    if (singleton.reviewOutcome !== options.reviewOutcome) {
      throw new LocalContractsRuntimeError(
        'LOCAL_CONTRACTS_OUTCOME_LOCKED',
        '로컬 contracts runtime의 review outcome은 시작 후 변경할 수 없습니다.',
      )
    }
    return singleton.runtime
  }

  const runtime = createValidatedRuntime(options.reviewOutcome)
  singleton = {
    reviewOutcome: options.reviewOutcome,
    runtime,
  }
  return runtime
}
