import { createHmac, randomBytes } from 'node:crypto'

import type {
  Hex32,
  LocalReportAttestationRuntime,
  PreparedSyntheticEvidence,
  RedactedExecutionResult,
  ReportAttestationFailureCode,
  ReportAttestationRecord,
  ReportAttestationStatus,
  ReportReviewOutcome,
  ReportVerification,
} from './types.js'
import { MemoryReportAttestationStore } from './memory-store.js'
import type { MockReportPublication } from './mock-publication-source.js'

const EMPTY_RESULT: RedactedExecutionResult = Object.freeze({
  status: 'FAILED',
  transactionHash: null,
  attestationUID: null,
  reasonCode: null,
})

const IDENTITY_KEY_BYTES = 32
const IDENTITY_DOMAIN = 'giwa.local-report-attestation.identity.v1'

const isHex32 = (value: unknown): value is Hex32 =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const isNonTerminalRuntimeStatus = (status: string) =>
  status === 'PENDING' ||
  status === 'MANUAL_REVIEW' ||
  status === 'RETRY_REQUIRED' ||
  status === 'RECONCILIATION_REQUIRED'

const isConfirmedExecutionResult = (
  result: RedactedExecutionResult,
) =>
  result.status === 'CONFIRMED' &&
  isHex32(result.transactionHash) &&
  isHex32(result.attestationUID) &&
  result.reasonCode === null

const sanitizeResult = (
  result: RedactedExecutionResult,
): RedactedExecutionResult => ({
  status: /^[A-Z][A-Z0-9_]{0,63}$/.test(result.status)
    ? result.status
    : 'UNKNOWN',
  transactionHash:
    result.transactionHash &&
    /^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)
      ? result.transactionHash
      : null,
  attestationUID: isHex32(result.attestationUID)
    ? result.attestationUID
    : null,
  reasonCode:
    result.reasonCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.reasonCode)
      ? result.reasonCode
      : null,
})

const serializeStatus = (
  record: ReportAttestationRecord,
): ReportAttestationStatus => ({
  reportId: record.reportId,
  lifecycle: record.lifecycle,
  submission: record.submission ?? null,
  review: record.review ?? null,
  failureCode: record.failureCode ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
})

export class ReportAttestationConflictError extends Error {
  constructor(readonly code: 'NOT_PREPARED' | 'NOT_SUBMITTED' | 'ALREADY_STARTED') {
    super(code)
    this.name = 'ReportAttestationConflictError'
  }
}

export class ReportAttestationServiceClosedError extends Error {
  constructor() {
    super('Report attestation service is closed')
    this.name = 'ReportAttestationServiceClosedError'
  }
}

export class LocalReportFixtureUnavailableError extends Error {
  constructor() {
    super('The local report fixture is already claimed')
    this.name = 'LocalReportFixtureUnavailableError'
  }
}

export class ReportAttestationPreparationError extends Error {
  constructor() {
    super('Local report fixture preparation failed')
    this.name = 'ReportAttestationPreparationError'
  }
}

export class ReportAttestationService {
  readonly #store: MemoryReportAttestationStore
  readonly #runtime: LocalReportAttestationRuntime
  readonly #reviewOutcome: ReportReviewOutcome
  readonly #now: () => Date
  readonly #identityKey: Buffer
  #tail: Promise<void> = Promise.resolve()
  #closePromise: Promise<void> | undefined
  #acceptingJobs = true

  constructor(options: {
    runtime: LocalReportAttestationRuntime
    reviewOutcome: ReportReviewOutcome
    store?: MemoryReportAttestationStore
    now?: () => Date
    identityKey?: Uint8Array
  }) {
    this.#runtime = options.runtime
    this.#reviewOutcome = options.reviewOutcome
    this.#store = options.store ?? new MemoryReportAttestationStore()
    this.#now = options.now ?? (() => new Date())
    const identityKey = options.identityKey ?? randomBytes(IDENTITY_KEY_BYTES)
    if (identityKey.byteLength !== IDENTITY_KEY_BYTES) {
      throw new Error('Report attestation identity key must contain 32 bytes')
    }
    this.#identityKey = Buffer.from(identityKey)
  }

  async prepareFixture(ownerId: string, fixture: MockReportPublication) {
    this.#assertOpen()
    const existing = await this.#store.get(ownerId, fixture.reportId)
    if (existing) {
      return serializeStatus(existing)
    }

    const now = this.#now()
    const identity = this.#deriveOwnerIdentity(ownerId)
    const claim = await this.#store.create({
      ownerId,
      reportId: fixture.reportId,
      preparedRecordId: identity.preparedRecordId,
      contractReportId: identity.contractReportId,
      revision: fixture.revision,
      safeArtifactBytes: fixture.safeArtifactBytes.slice(),
      commitment: undefined,
      lifecycle: 'PREPARING',
      submission: undefined,
      review: undefined,
      failureCode: undefined,
      createdAt: now,
      updatedAt: now,
    })
    if (claim.result === 'EXISTS') {
      return serializeStatus(claim.record)
    }
    if (claim.result === 'IDENTITY_CLAIMED') {
      throw new LocalReportFixtureUnavailableError()
    }

    let prepared: PreparedSyntheticEvidence
    try {
      prepared = await this.#runtime.prepareSyntheticEvidence({
        preparedRecordId: identity.preparedRecordId,
        reportId: identity.contractReportId,
        revision: fixture.revision,
        safeArtifactBytes: fixture.safeArtifactBytes.slice(),
      })
    } catch {
      await this.#markPreparationFailed(
        ownerId,
        fixture.reportId,
        'PREPARATION_EXECUTION_FAILED',
      )
      throw new ReportAttestationPreparationError()
    }
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      prepared.preparedRecordId !== identity.preparedRecordId ||
      !isHex32(prepared.reportId) ||
      prepared.reportId.toLowerCase() !== identity.contractReportId.toLowerCase() ||
      prepared.revision !== fixture.revision ||
      !isHex32(prepared.commitment)
    ) {
      await this.#markPreparationFailed(
        ownerId,
        fixture.reportId,
        'PREPARATION_RESULT_REJECTED',
      )
      throw new ReportAttestationPreparationError()
    }
    const completed = await this.#store.update(
      ownerId,
      fixture.reportId,
      (record) => ({
        ...record,
        commitment: prepared.commitment,
        lifecycle: 'PREPARED',
        failureCode: undefined,
        updatedAt: this.#now(),
      }),
    )
    if (!completed) {
      throw new ReportAttestationPreparationError()
    }
    return serializeStatus(completed)
  }

  async getStatus(ownerId: string, reportId: string) {
    const record = await this.#store.get(ownerId, reportId)
    return record ? serializeStatus(record) : undefined
  }

  async queueSubmission(ownerId: string, reportId: string) {
    this.#assertOpen()
    const queued = await this.#store.update(ownerId, reportId, (record) => {
      const retryableIssuer =
        (record.lifecycle === 'PENDING' ||
          record.lifecycle === 'RETRY_REQUIRED' ||
          record.lifecycle === 'RECONCILIATION_REQUIRED') &&
        !(
          record.submission?.status === 'CONFIRMED' &&
          isHex32(record.submission.attestationUID)
        )
      if (
        (record.lifecycle !== 'PREPARED' && !retryableIssuer) ||
        !isHex32(record.commitment ?? null)
      ) {
        return undefined
      }
      return {
        ...record,
        lifecycle: 'SUBMISSION_QUEUED',
        failureCode: undefined,
        updatedAt: this.#now(),
      }
    })
    if (!queued) {
      const current = await this.#store.get(ownerId, reportId)
      if (!current) {
        throw new ReportAttestationConflictError('NOT_PREPARED')
      }
      return serializeStatus(current)
    }

    this.#enqueue(async () => this.#runIssuer(ownerId, reportId))
    return serializeStatus(queued)
  }

  async queueReview(ownerId: string, reportId: string) {
    this.#assertOpen()
    const queued = await this.#store.update(ownerId, reportId, (record) => {
      if (
        (record.lifecycle !== 'SUBMITTED' &&
          !(
            (record.lifecycle === 'PENDING' ||
              record.lifecycle === 'RETRY_REQUIRED' ||
              record.lifecycle === 'RECONCILIATION_REQUIRED') &&
            record.submission?.status === 'CONFIRMED'
          )) ||
        !isHex32(record.submission?.attestationUID ?? null)
      ) {
        return undefined
      }
      return {
        ...record,
        lifecycle: 'REVIEW_QUEUED',
        failureCode: undefined,
        updatedAt: this.#now(),
      }
    })
    if (!queued) {
      const current = await this.#store.get(ownerId, reportId)
      if (!current) {
        throw new ReportAttestationConflictError('NOT_PREPARED')
      }
      if (
        current.submission?.status !== 'CONFIRMED' ||
        !isHex32(current.submission.attestationUID)
      ) {
        throw new ReportAttestationConflictError('NOT_SUBMITTED')
      }
      return serializeStatus(current)
    }

    this.#enqueue(async () => this.#runReviewer(ownerId, reportId))
    return serializeStatus(queued)
  }

  async verify(ownerId: string, reportId: string): Promise<ReportVerification | undefined> {
    const record = await this.#store.get(ownerId, reportId)
    if (!record) {
      return undefined
    }
    const approvalUID = record.review?.attestationUID ?? null
    if (record.lifecycle === 'REJECTED') {
      return {
        reportId,
        lifecycle: record.lifecycle,
        result: 'UNUSABLE',
        reasonCode: 'REVIEW_REJECTED',
      }
    }
    if (record.lifecycle !== 'APPROVED' || !isHex32(approvalUID)) {
      return {
        reportId,
        lifecycle: record.lifecycle,
        result: 'UNUSABLE',
        reasonCode: 'APPROVAL_NOT_AVAILABLE',
      }
    }

    try {
      const usable = await this.#runtime.isUsable(
        record.contractReportId,
        approvalUID,
      )
      if (!usable) {
        return {
          reportId,
          lifecycle: record.lifecycle,
          result: 'UNUSABLE',
          reasonCode: 'ONCHAIN_APPROVAL_NOT_USABLE',
        }
      }
      const verification = await this.#runtime.verifyPreparedReport({
        preparedRecordId: record.preparedRecordId,
        approvalUID,
        safeArtifactBytes: record.safeArtifactBytes.slice(),
      })
      return {
        reportId,
        lifecycle: record.lifecycle,
        result: verification.result,
        reasonCode:
          verification.result === 'USABLE'
            ? null
            : this.#sanitizeVerificationReason(verification.reason),
      }
    } catch {
      return {
        reportId,
        lifecycle: record.lifecycle,
        result: 'VERIFY_FAILED',
        reasonCode: 'VERIFICATION_EXECUTION_FAILED',
      }
    }
  }

  /**
   * Internal test hook only. It is intentionally not registered as an HTTP
   * route and cannot change owner, IDs, revision, or contract receipts.
   */
  async mutateSafeArtifactForTest(
    ownerId: string,
    reportId: string,
    mutation: (bytes: Uint8Array) => Uint8Array,
  ) {
    const updated = await this.#store.update(ownerId, reportId, (record) => ({
      ...record,
      safeArtifactBytes: mutation(record.safeArtifactBytes.slice()).slice(),
      updatedAt: this.#now(),
    }))
    return updated ? serializeStatus(updated) : undefined
  }

  async waitForIdle() {
    await this.#tail
  }

  close() {
    if (!this.#closePromise) {
      this.#acceptingJobs = false
      this.#closePromise = this.#tail.then(async () => {
        await this.#runtime.close()
      })
    }
    return this.#closePromise
  }

  #enqueue(job: () => Promise<void>) {
    const run = this.#tail.then(job, job)
    this.#tail = run.catch(() => undefined)
  }

  async #runIssuer(ownerId: string, reportId: string) {
    const submitting = await this.#store.update(ownerId, reportId, (record) =>
      record.lifecycle === 'SUBMISSION_QUEUED'
        ? {
            ...record,
            lifecycle: 'SUBMITTING',
            updatedAt: this.#now(),
          }
        : undefined,
    )
    if (!submitting) {
      return
    }

    let result: RedactedExecutionResult
    let failureCode: ReportAttestationFailureCode | undefined
    try {
      const rawResult =
        await this.#runtime.issuerExecutor.executeIssuer({
          preparedRecordId: submitting.preparedRecordId,
        })
      result = sanitizeResult(rawResult)
      if (
        rawResult.status === 'CONFIRMED' &&
        !isConfirmedExecutionResult(rawResult)
      ) {
        failureCode = 'ISSUER_RESULT_REJECTED'
      } else if (result.status === 'MANUAL_REVIEW') {
        failureCode = 'ISSUER_RESULT_REJECTED'
      } else if (
        result.status !== 'CONFIRMED' &&
        !isNonTerminalRuntimeStatus(result.status)
      ) {
        failureCode = 'ISSUER_RESULT_REJECTED'
      }
    } catch {
      result = EMPTY_RESULT
      failureCode = 'ISSUER_EXECUTION_FAILED'
    }
    await this.#store.update(ownerId, reportId, (record) => ({
      ...record,
      lifecycle: failureCode
        ? 'SUBMISSION_FAILED'
        : this.#mapExecutionLifecycle(result.status, 'SUBMITTED'),
      submission: result,
      failureCode,
      updatedAt: this.#now(),
    }))
  }

  async #runReviewer(ownerId: string, reportId: string) {
    const reviewing = await this.#store.update(ownerId, reportId, (record) =>
      record.lifecycle === 'REVIEW_QUEUED' &&
      isHex32(record.submission?.attestationUID ?? null)
        ? {
            ...record,
            lifecycle: 'REVIEWING',
            updatedAt: this.#now(),
          }
        : undefined,
    )
    const submissionUID = reviewing?.submission?.attestationUID ?? null
    if (!reviewing || !isHex32(submissionUID)) {
      return
    }

    let result: RedactedExecutionResult
    let failureCode: ReportAttestationFailureCode | undefined
    const preservedReceipt =
      reviewing.review &&
      isConfirmedExecutionResult(reviewing.review)
        ? reviewing.review
        : undefined
    if (preservedReceipt) {
      result = preservedReceipt
    } else {
      try {
        const rawResult =
          await this.#runtime.reviewerExecutor.executeReviewer({
            preparedRecordId: reviewing.preparedRecordId,
            submissionUID,
          })
        result = sanitizeResult(rawResult)
        if (
          rawResult.status === 'CONFIRMED' &&
          !isConfirmedExecutionResult(rawResult)
        ) {
          failureCode = 'REVIEWER_RESULT_REJECTED'
        } else if (rawResult.status === 'MANUAL_REVIEW') {
          if (
            rawResult.attestationUID !== null ||
            rawResult.transactionHash !== null ||
            this.#reviewOutcome !== 'MANUAL_REVIEW'
          ) {
            failureCode = 'REVIEW_OUTCOME_MISMATCH'
          }
        } else if (
          rawResult.status !== 'CONFIRMED' &&
          !isNonTerminalRuntimeStatus(rawResult.status)
        ) {
          failureCode = 'REVIEWER_RESULT_REJECTED'
        }
      } catch {
        result = EMPTY_RESULT
        failureCode = 'REVIEWER_EXECUTION_FAILED'
      }
    }

    if (
      !failureCode &&
      result.status === 'CONFIRMED' &&
      this.#reviewOutcome === 'MANUAL_REVIEW'
    ) {
      failureCode = 'REVIEW_OUTCOME_MISMATCH'
    }
    if (
      !failureCode &&
      result.status === 'CONFIRMED'
    ) {
      let runtimeApproved: boolean
      try {
        runtimeApproved = await this.#runtime.isUsable(
          reviewing.contractReportId,
          result.attestationUID as Hex32,
        )
      } catch {
        await this.#store.update(ownerId, reportId, (record) => ({
          ...record,
          lifecycle: 'RECONCILIATION_REQUIRED',
          review: result,
          failureCode: 'REVIEW_RECONCILIATION_FAILED',
          updatedAt: this.#now(),
        }))
        return
      }
      if (runtimeApproved !== (this.#reviewOutcome === 'APPROVE')) {
        failureCode = 'REVIEW_OUTCOME_MISMATCH'
      }
    }
    await this.#store.update(ownerId, reportId, (record) => ({
      ...record,
      lifecycle: failureCode
        ? 'REVIEW_FAILED'
        : this.#mapExecutionLifecycle(
            result.status,
            this.#reviewOutcome === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          ),
      review: result,
      failureCode,
      updatedAt: this.#now(),
    }))
  }

  #assertOpen() {
    if (!this.#acceptingJobs) {
      throw new ReportAttestationServiceClosedError()
    }
  }

  #deriveOwnerIdentity(ownerId: string): {
    preparedRecordId: string
    contractReportId: Hex32
  } {
    const derive = (purpose: 'prepared-record' | 'contract-report') =>
      createHmac('sha256', this.#identityKey)
        .update(IDENTITY_DOMAIN)
        .update('\u0000')
        .update(purpose)
        .update('\u0000')
        .update(ownerId)
        .digest('hex')

    return {
      preparedRecordId: `ep_${derive('prepared-record')}`,
      contractReportId: `0x${derive('contract-report')}`,
    }
  }

  async #markPreparationFailed(
    ownerId: string,
    reportId: string,
    failureCode:
      | 'PREPARATION_EXECUTION_FAILED'
      | 'PREPARATION_RESULT_REJECTED',
  ) {
    await this.#store.update(ownerId, reportId, (record) => ({
      ...record,
      lifecycle: 'PREPARATION_FAILED',
      failureCode,
      updatedAt: this.#now(),
    }))
  }

  #sanitizeVerificationReason(reason: string | null) {
    return reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)
      ? reason
      : 'PREPARED_REPORT_MISMATCH'
  }

  #mapExecutionLifecycle(
    status: string,
    confirmedLifecycle: 'SUBMITTED' | 'APPROVED' | 'REJECTED',
  ) {
    if (status === 'CONFIRMED') {
      return confirmedLifecycle
    }
    if (isNonTerminalRuntimeStatus(status)) {
      return status
    }
    return confirmedLifecycle === 'SUBMITTED'
      ? ('SUBMISSION_FAILED' as const)
      : ('REVIEW_FAILED' as const)
  }
}
