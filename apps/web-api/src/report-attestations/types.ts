export const LOCAL_REPORT_ATTESTATION_RUNTIME_KIND =
  'LOCAL_ONLY_IN_MEMORY_ANVIL_V1' as const
export const GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND =
  'GIWA_SEPOLIA_REPORT_ATTESTATION_V1' as const

export type Hex32 = `0x${string}`

/**
 * Deliberately redacted execution receipt. The local contract runtime may keep
 * richer transaction details internally, but the API boundary only accepts
 * these four fields.
 */
export type RedactedExecutionResult = Readonly<{
  status: string
  transactionHash: string | null
  attestationUID: string | null
  reasonCode: string | null
}>

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

export type ReportAttestationFailureCode =
  | 'PREPARATION_EXECUTION_FAILED'
  | 'PREPARATION_RESULT_REJECTED'
  | 'ISSUER_EXECUTION_FAILED'
  | 'ISSUER_RESULT_REJECTED'
  | 'REVIEWER_EXECUTION_FAILED'
  | 'REVIEWER_RESULT_REJECTED'
  | 'REVIEW_RECONCILIATION_FAILED'
  | 'REVIEW_OUTCOME_MISMATCH'
  | 'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION'
  | 'RUNTIME_CLOSED'

export type ReportReviewOutcome = 'APPROVE' | 'REJECT' | 'MANUAL_REVIEW'

export type PreparedSyntheticEvidence = Readonly<{
  preparedRecordId: string
  reportId: Hex32
  revision: number
  commitment: Hex32
  safeArtifactDigest?: Hex32
  safeManifestDigest?: Hex32
  derivationRuleDigest?: Hex32
  commitmentNonce?: Hex32
}>

export type PreparedReportInput = Readonly<{
  preparedRecordId: string
  reportId: Hex32
  revision: number
  safeArtifactBytes: Uint8Array
  previousSubmissionUID?: Hex32
  derivationRuleDigest?: Hex32
}>

export interface ReportAttestationIssuerExecutor {
  executeIssuer(input: {
    preparedRecordId: string
  }): Promise<RedactedExecutionResult>
}

export interface ReportAttestationReviewerExecutor {
  executeReviewer(input: {
    preparedRecordId: string
    submissionUID: Hex32
  }): Promise<RedactedExecutionResult>
}

export interface ReportAttestationReviewerReconciler {
  reconcileReviewer(input: {
    preparedRecordId: string
    submissionUID: Hex32
    transactionHash: Hex32
  }): Promise<RedactedExecutionResult>
}

/**
 * Structural port for the optional local Anvil runtime. Keeping this interface
 * in the web API means ordinary lint/typecheck/test/build never import the
 * separately packaged contracts implementation.
 */
export interface ReportAttestationRuntime {
  readonly kind: string
  readonly issuerExecutor: ReportAttestationIssuerExecutor
  readonly reviewerExecutor: ReportAttestationReviewerExecutor
  readonly reviewerReconciler?: ReportAttestationReviewerReconciler
  prepareSyntheticEvidence(
    input: PreparedReportInput,
  ): Promise<PreparedSyntheticEvidence>
  isUsable(reportId: Hex32, approvalUID: Hex32): Promise<boolean>
  verifyPreparedReport(input: {
    preparedRecordId: string
    approvalUID: Hex32
    safeArtifactBytes: Uint8Array
  }): Promise<{
    result: 'USABLE' | 'UNUSABLE'
    reason: string | null
  }>
  close(): Promise<void>
}

export interface LocalReportAttestationRuntime
  extends ReportAttestationRuntime {
  readonly kind: typeof LOCAL_REPORT_ATTESTATION_RUNTIME_KIND
}

export interface GiwaSepoliaReportAttestationRuntime
  extends ReportAttestationRuntime {
  readonly kind: typeof GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND
  readonly reviewerReconciler: ReportAttestationReviewerReconciler
}

export type ReportAttestationRecord = {
  ownerId: string
  reportId: string
  publicationSourceVersion: string
  preparedRecordId: string
  contractReportId: Hex32
  revision: number
  previousSubmissionUID: Hex32
  safeArtifactBytes: Uint8Array
  commitment: Hex32 | undefined
  safeArtifactDigest: Hex32 | undefined
  safeManifestDigest: Hex32 | undefined
  derivationRuleDigest: Hex32 | undefined
  commitmentNonce: Hex32 | undefined
  desiredReviewOutcome: ReportReviewOutcome
  lifecycle: ReportAttestationLifecycle
  submission: RedactedExecutionResult | undefined
  review: RedactedExecutionResult | undefined
  failureCode: ReportAttestationFailureCode | undefined
  createdAt: Date
  updatedAt: Date
}

export type ReportAttestationStatus = Readonly<{
  reportId: string
  lifecycle: ReportAttestationLifecycle
  submission: RedactedExecutionResult | null
  review: RedactedExecutionResult | null
  failureCode: ReportAttestationFailureCode | null
  createdAt: string
  updatedAt: string
}>

export type ReportVerification = Readonly<{
  reportId: string
  lifecycle: ReportAttestationLifecycle
  result: 'USABLE' | 'UNUSABLE' | 'VERIFY_FAILED'
  reasonCode: string | null
}>
