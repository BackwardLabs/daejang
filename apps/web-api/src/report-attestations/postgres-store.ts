import {
  createHash,
  randomUUID,
} from 'node:crypto'

import type {
  Pool,
  PoolClient,
} from 'pg'

import type { ReportAttestationDeploymentConfig } from '../config.js'
import type { ReportAttestationPublicationSource } from './publication-source.js'
import type {
  Hex32,
  RedactedExecutionResult,
  ReportAttestationFailureCode,
  ReportAttestationLifecycle,
  ReportAttestationRecord,
  ReportReviewOutcome,
} from './types.js'
import type {
  ReportAttestationCreateResult,
  ReportAttestationStore,
} from './store.js'

type ReportAttestationRow = {
  id: string
  user_id: string
  publication_key: string
  publication_source_version: string
  revision: number
  previous_submission_uid: string
  prepared_record_id: string
  contract_report_id: string
  network: string
  schema_uid: string
  evidence_schema_digest: string
  derivation_rule_digest: string | null
  safe_artifact_digest: string | null
  safe_manifest_digest: string | null
  commitment_nonce: Buffer | null
  commitment: string | null
  lifecycle: string
  desired_review_outcome: string
  submission_tx_hash: string | null
  submission_attestation_uid: string | null
  submission_status: string | null
  submission_reason_code: string | null
  review_tx_hash: string | null
  review_attestation_uid: string | null
  review_status: string | null
  review_reason_code: string | null
  failure_code: string | null
  state_version: string
  created_at: Date
  updated_at: Date
  submitted_at: Date | null
  reviewed_at: Date | null
}

const hex32Pattern = /^0x[0-9a-f]{64}$/
const ZERO_HEX32 = `0x${'0'.repeat(64)}` as Hex32
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
const executionStatusValues = new Set([
  'CONFIRMED',
  'PENDING',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
  'FAILED',
])
const failureCodeValues = new Set<ReportAttestationFailureCode>([
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
const reviewOutcomes = new Set<ReportReviewOutcome>([
  'APPROVE',
  'REJECT',
  'MANUAL_REVIEW',
])

const asHex32 = (value: string | null): Hex32 | undefined => {
  if (value === null) return undefined
  const normalized = value.toLowerCase()
  if (!hex32Pattern.test(normalized)) {
    throw new Error('Stored report attestation bytes32 is invalid')
  }
  return normalized as Hex32
}

const asRequiredHex32 = (value: string | null, label: string): Hex32 => {
  const normalized = asHex32(value)
  if (!normalized) {
    throw new Error(`Stored report attestation ${label} is missing`)
  }
  return normalized
}

const nonceAsHex32 = (value: Buffer | null) => {
  if (value === null) return undefined
  if (value.byteLength !== 32) {
    throw new Error('Stored report attestation nonce is invalid')
  }
  return `0x${value.toString('hex')}` as Hex32
}

const artifactDigest = (bytes: Uint8Array) =>
  `0x${createHash('sha256').update(bytes).digest('hex')}` as Hex32

const executionResult = (
  status: string | null,
  transactionHash: string | null,
  attestationUID: string | null,
  reasonCode: string | null,
): RedactedExecutionResult | undefined => {
  if (status === null) {
    if (
      transactionHash !== null ||
      attestationUID !== null ||
      reasonCode !== null
    ) {
      throw new Error(
        'Stored report attestation execution result is incomplete',
      )
    }
    return undefined
  }
  const normalizedTransactionHash =
    transactionHash?.toLowerCase() ?? null
  const normalizedAttestationUID =
    attestationUID?.toLowerCase() ?? null
  const validReason =
    reasonCode !== null &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)
  const validShape =
    (status === 'CONFIRMED' &&
      normalizedTransactionHash !== null &&
      normalizedAttestationUID !== null &&
      reasonCode === null) ||
    (status === 'MANUAL_REVIEW' &&
      normalizedTransactionHash === null &&
      normalizedAttestationUID === null &&
      validReason) ||
    ((status === 'PENDING' ||
      status === 'RETRY_REQUIRED' ||
      status === 'RECONCILIATION_REQUIRED') &&
      validReason) ||
    (status === 'FAILED' && reasonCode === null)
  if (
    !executionStatusValues.has(status) ||
    (normalizedTransactionHash !== null &&
      !hex32Pattern.test(normalizedTransactionHash)) ||
    (normalizedAttestationUID !== null &&
      !hex32Pattern.test(normalizedAttestationUID)) ||
    !validShape
  ) {
    throw new Error(
      'Stored report attestation execution result is invalid',
    )
  }
  return {
    status,
    transactionHash: normalizedTransactionHash,
    attestationUID: normalizedAttestationUID,
    reasonCode,
  }
}

const normalizeExecutionResult = (
  result: RedactedExecutionResult | undefined,
) =>
  result
    ? executionResult(
        result.status,
        result.transactionHash,
        result.attestationUID,
        result.reasonCode,
      )
    : undefined

const clearsSubmissionReceipt = (
  lifecycle: ReportAttestationLifecycle,
) =>
  lifecycle === 'PREPARING' ||
  lifecycle === 'PREPARATION_FAILED' ||
  lifecycle === 'PREPARED' ||
  lifecycle === 'SUBMISSION_QUEUED' ||
  lifecycle === 'SUBMITTING'

const clearsReviewReceipt = (
  lifecycle: ReportAttestationLifecycle,
) =>
  clearsSubmissionReceipt(lifecycle) || lifecycle === 'SUBMITTED'

const immutableIdentityMatches = (
  previous: ReportAttestationRecord,
  next: ReportAttestationRecord,
) =>
  previous.ownerId === next.ownerId &&
  previous.reportId === next.reportId &&
  previous.publicationSourceVersion ===
    next.publicationSourceVersion &&
  previous.preparedRecordId === next.preparedRecordId &&
  previous.contractReportId.toLowerCase() ===
    next.contractReportId.toLowerCase() &&
  previous.revision === next.revision &&
  previous.previousSubmissionUID.toLowerCase() ===
    next.previousSubmissionUID.toLowerCase() &&
  previous.desiredReviewOutcome === next.desiredReviewOutcome

export class PostgresReportAttestationStore
  implements ReportAttestationStore
{
  readonly durable = true

  constructor(
    private readonly pool: Pool,
    private readonly publicationSource:
      ReportAttestationPublicationSource,
    private readonly deployment:
      ReportAttestationDeploymentConfig,
  ) {}

  async create(
    record: ReportAttestationRecord,
  ): Promise<ReportAttestationCreateResult> {
    if (
      record.lifecycle !== 'PREPARING' ||
      !Number.isInteger(record.revision) ||
      record.revision < 1 ||
      !hex32Pattern.test(
        record.previousSubmissionUID.toLowerCase(),
      ) ||
      (record.revision === 1
        ? record.previousSubmissionUID.toLowerCase() !== ZERO_HEX32
        : record.previousSubmissionUID.toLowerCase() === ZERO_HEX32) ||
      record.commitment !== undefined ||
      record.safeArtifactDigest !== undefined ||
      record.safeManifestDigest !== undefined ||
      record.derivationRuleDigest !== undefined ||
      record.commitmentNonce !== undefined ||
      record.submission !== undefined ||
      record.review !== undefined ||
      record.failureCode !== undefined ||
      !reviewOutcomes.has(record.desiredReviewOutcome)
    ) {
      throw new Error(
        'Report attestation records must be created in PREPARING state',
      )
    }
    const result = await this.pool.query<ReportAttestationRow>(
      `
        INSERT INTO web_private.report_attestation_records (
          id,
          user_id,
          publication_key,
          publication_source_version,
          revision,
          previous_submission_uid,
          prepared_record_id,
          contract_report_id,
          schema_uid,
          evidence_schema_digest,
          desired_review_outcome
        ) VALUES (
          $1, $2, $3, $4, $5, lower($6), $7, lower($8),
          lower($9), lower($10), $11
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        randomUUID(),
        record.ownerId,
        record.reportId,
        record.publicationSourceVersion,
        record.revision,
        record.previousSubmissionUID,
        record.preparedRecordId,
        record.contractReportId,
        this.deployment.schemaUID,
        this.deployment.evidenceSchemaDigest,
        record.desiredReviewOutcome,
      ],
    )
    const inserted = result.rows[0]
    if (inserted) {
      return {
        result: 'CREATED',
        record: await this.#hydrate(inserted),
      }
    }
    const existingResult =
      await this.pool.query<ReportAttestationRow>(
        `
          SELECT *
          FROM web_private.report_attestation_records
          WHERE
            user_id = $1
            AND publication_key = $2
            AND revision = $3
        `,
        [record.ownerId, record.reportId, record.revision],
      )
    const existing = existingResult.rows[0]
    if (existing) {
      return {
        result: 'EXISTS',
        record: await this.#hydrate(existing),
      }
    }
    const identityClaim = await this.pool.query<{ claimed: boolean }>(
      `
        SELECT true AS claimed
        FROM web_private.report_attestation_records
        WHERE prepared_record_id = $1
        LIMIT 1
      `,
      [record.preparedRecordId],
    )
    if (!identityClaim.rows[0]) {
      throw new Error(
        'Report attestation identity conflict could not be reconciled',
      )
    }
    return { result: 'IDENTITY_CLAIMED' }
  }

  async get(
    ownerId: string,
    reportId: string,
    revision?: number,
  ) {
    const result = await this.pool.query<ReportAttestationRow>(
      `
        SELECT *
        FROM web_private.report_attestation_records
        WHERE
          user_id = $1
          AND publication_key = $2
          AND ($3::bigint IS NULL OR revision = $3)
        ORDER BY revision DESC
        LIMIT 1
      `,
      [ownerId, reportId, revision ?? null],
    )
    const row = result.rows[0]
    return row ? this.#hydrate(row) : undefined
  }

  async getByPreparedRecordId(preparedRecordId: string) {
    const result = await this.pool.query<ReportAttestationRow>(
      `
        SELECT *
        FROM web_private.report_attestation_records
        WHERE prepared_record_id = $1
      `,
      [preparedRecordId],
    )
    const row = result.rows[0]
    return row
      ? {
          databaseId: row.id,
          record: await this.#hydrate(row),
        }
      : undefined
  }

  async update(
    ownerId: string,
    reportId: string,
    revision: number,
    transition: (
      current: ReportAttestationRecord,
    ) => ReportAttestationRecord | undefined,
  ) {
    return this.#transaction(async (client) => {
      const selected = await client.query<ReportAttestationRow>(
        `
          SELECT *
          FROM web_private.report_attestation_records
          WHERE
            user_id = $1
            AND publication_key = $2
            AND revision = $3
          LIMIT 1
          FOR UPDATE
        `,
        [ownerId, reportId, revision],
      )
      const row = selected.rows[0]
      if (!row) return undefined
      const current = await this.#hydrate(row)
      const replacement = transition(current)
      if (!replacement) return undefined
      if (!immutableIdentityMatches(current, replacement)) {
        throw new Error(
          'Report attestation identity fields cannot be changed',
        )
      }

      if (
        !lifecycleValues.has(replacement.lifecycle) ||
        (replacement.failureCode !== undefined &&
          !failureCodeValues.has(replacement.failureCode))
      ) {
        throw new Error(
          'Report attestation state transition is invalid',
        )
      }
      const digest = artifactDigest(replacement.safeArtifactBytes)
      if (
        replacement.safeArtifactDigest &&
        replacement.safeArtifactDigest.toLowerCase() !== digest
      ) {
        throw new Error(
          'Prepared report safe artifact digest does not match its bytes',
        )
      }
      if (
        replacement.lifecycle !== 'PREPARING' &&
        replacement.lifecycle !== 'PREPARATION_FAILED' &&
        (!replacement.safeManifestDigest ||
          !replacement.derivationRuleDigest ||
          !replacement.commitmentNonce ||
          !replacement.commitment)
      ) {
        throw new Error(
          'Prepared report commitment metadata is incomplete',
        )
      }
      const updatedAt = new Date(
        Math.max(
          replacement.updatedAt.getTime(),
          row.updated_at.getTime() + 1,
        ),
      )
      const submission = normalizeExecutionResult(
        clearsSubmissionReceipt(replacement.lifecycle)
          ? undefined
          : replacement.submission,
      )
      const review = normalizeExecutionResult(
        clearsReviewReceipt(replacement.lifecycle)
          ? undefined
          : replacement.review,
      )
      const updated = await client.query<ReportAttestationRow>(
        `
          UPDATE web_private.report_attestation_records
          SET
            derivation_rule_digest = $3,
            safe_artifact_digest = $4,
            safe_manifest_digest = $5,
            commitment_nonce = $6,
            commitment = $7,
            lifecycle = $8,
            submission_tx_hash = $9,
            submission_attestation_uid = $10,
            submission_status = $11,
            submission_reason_code = $12,
            review_tx_hash = $13,
            review_attestation_uid = $14,
            review_status = $15,
            review_reason_code = $16,
            failure_code = $17,
            state_version = state_version + 1,
            updated_at = $18,
            submitted_at = CASE
              WHEN $11::text IS NULL THEN NULL
              ELSE COALESCE(submitted_at, $18)
            END,
            reviewed_at = CASE
              WHEN $15::text IS NULL THEN NULL
              ELSE COALESCE(reviewed_at, $18)
            END
          WHERE id = $1 AND state_version = $2
          RETURNING *
        `,
        [
          row.id,
          row.state_version,
          replacement.derivationRuleDigest ?? null,
          replacement.lifecycle === 'PREPARING' ||
          replacement.lifecycle === 'PREPARATION_FAILED'
            ? null
            : digest,
          replacement.safeManifestDigest ?? null,
          replacement.commitmentNonce
            ? Buffer.from(
                replacement.commitmentNonce.slice(2),
                'hex',
              )
            : null,
          replacement.commitment ?? null,
          replacement.lifecycle,
          submission?.transactionHash ?? null,
          submission?.attestationUID ?? null,
          submission?.status ?? null,
          submission?.reasonCode ?? null,
          review?.transactionHash ?? null,
          review?.attestationUID ?? null,
          review?.status ?? null,
          review?.reasonCode ?? null,
          replacement.failureCode ?? null,
          updatedAt,
        ],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) {
        throw new Error(
          'Report attestation state transition lost its version race',
        )
      }
      return this.#hydrate(updatedRow)
    })
  }

  async recoverInterrupted() {
    return this.#transaction(async (client) => {
      const operations = await client.query(
        `
          UPDATE web_private.report_attestation_operations
          SET
            state = 'RECONCILIATION_REQUIRED',
            reason_code =
              'PROCESS_RESTART_REQUIRES_RECONCILIATION',
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            ),
            reconciliation_required_at = GREATEST(
              clock_timestamp(),
              created_at
            )
          WHERE state IN ('RESERVED', 'IN_FLIGHT')
        `,
      )
      const preparations = await client.query(
        `
          UPDATE web_private.report_attestation_records
          SET
            lifecycle = 'PREPARATION_FAILED',
            failure_code = 'PREPARATION_EXECUTION_FAILED',
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            )
          WHERE lifecycle = 'PREPARING'
        `,
      )
      const confirmedSubmissions = await client.query(
        `
          UPDATE web_private.report_attestation_records AS records
          SET
            lifecycle = 'SUBMITTED',
            submission_tx_hash = operations.tx_hash,
            submission_attestation_uid =
              operations.attestation_uid,
            submission_status = 'CONFIRMED',
            submission_reason_code = NULL,
            failure_code = NULL,
            state_version = records.state_version + 1,
            submitted_at = GREATEST(
              operations.confirmed_at,
              records.created_at
            ),
            updated_at = GREATEST(
              clock_timestamp(),
              records.updated_at + interval '1 microsecond',
              operations.confirmed_at
            )
          FROM
            web_private.report_attestation_operations
              AS operations
          WHERE operations.record_id = records.id
            AND operations.action = 'SUBMIT'
            AND operations.state = 'CONFIRMED'
            AND operations.result_status = 'SUBMITTED'
            AND records.lifecycle = 'SUBMITTING'
            AND records.submission_status IS NULL
        `,
      )
      const confirmedReviews = await client.query(
        `
          UPDATE web_private.report_attestation_records AS records
          SET
            lifecycle = 'RECONCILIATION_REQUIRED',
            review_tx_hash = operations.tx_hash,
            review_attestation_uid =
              operations.attestation_uid,
            review_status = 'CONFIRMED',
            review_reason_code = NULL,
            failure_code = 'REVIEW_RECONCILIATION_FAILED',
            state_version = records.state_version + 1,
            reviewed_at = GREATEST(
              operations.confirmed_at,
              records.submitted_at
            ),
            updated_at = GREATEST(
              clock_timestamp(),
              records.updated_at + interval '1 microsecond',
              operations.confirmed_at
            )
          FROM
            web_private.report_attestation_operations
              AS operations
          WHERE operations.record_id = records.id
            AND operations.action IN ('APPROVE', 'REJECT')
            AND operations.action =
              records.desired_review_outcome
            AND operations.state = 'CONFIRMED'
            AND (
              (
                operations.action = 'APPROVE'
                AND operations.result_status = 'USABLE'
              )
              OR (
                operations.action = 'REJECT'
                AND operations.result_status = 'UNUSABLE'
              )
            )
            AND records.lifecycle = 'REVIEWING'
            AND records.submission_status = 'CONFIRMED'
            AND records.review_status IS NULL
        `,
      )
      const records = await client.query(
        `
          UPDATE web_private.report_attestation_records
          SET
            lifecycle = 'RECONCILIATION_REQUIRED',
            submission_status = CASE
              WHEN lifecycle IN (
                'SUBMISSION_QUEUED',
                'SUBMITTING'
              )
                THEN 'RECONCILIATION_REQUIRED'
              ELSE submission_status
            END,
            submission_reason_code = CASE
              WHEN lifecycle IN (
                'SUBMISSION_QUEUED',
                'SUBMITTING'
              )
                THEN 'PROCESS_RESTART_REQUIRES_RECONCILIATION'
              ELSE submission_reason_code
            END,
            submitted_at = CASE
              WHEN lifecycle IN (
                'SUBMISSION_QUEUED',
                'SUBMITTING'
              )
                THEN COALESCE(
                  submitted_at,
                  GREATEST(clock_timestamp(), created_at)
                )
              ELSE submitted_at
            END,
            review_status = CASE
              WHEN lifecycle IN ('REVIEW_QUEUED', 'REVIEWING')
                AND review_status IS DISTINCT FROM 'CONFIRMED'
                THEN 'RECONCILIATION_REQUIRED'
              ELSE review_status
            END,
            review_reason_code = CASE
              WHEN lifecycle IN ('REVIEW_QUEUED', 'REVIEWING')
                AND review_status IS DISTINCT FROM 'CONFIRMED'
                THEN 'PROCESS_RESTART_REQUIRES_RECONCILIATION'
              ELSE review_reason_code
            END,
            reviewed_at = CASE
              WHEN lifecycle IN ('REVIEW_QUEUED', 'REVIEWING')
                THEN COALESCE(
                  reviewed_at,
                  GREATEST(clock_timestamp(), submitted_at)
                )
              ELSE reviewed_at
            END,
            failure_code = CASE
              WHEN lifecycle IN ('REVIEW_QUEUED', 'REVIEWING')
                AND review_status = 'CONFIRMED'
                THEN 'REVIEW_RECONCILIATION_FAILED'
              ELSE 'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION'
            END,
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            )
          WHERE lifecycle IN (
            'SUBMISSION_QUEUED',
            'SUBMITTING',
            'REVIEW_QUEUED',
            'REVIEWING'
          )
        `,
      )
      return Math.max(
        operations.rowCount ?? 0,
        preparations.rowCount ?? 0,
        confirmedSubmissions.rowCount ?? 0,
        confirmedReviews.rowCount ?? 0,
        records.rowCount ?? 0,
      )
    })
  }

  async #hydrate(row: ReportAttestationRow) {
    if (
      row.network !== this.deployment.network ||
      row.schema_uid.toLowerCase() !==
        this.deployment.schemaUID.toLowerCase() ||
      row.evidence_schema_digest.toLowerCase() !==
        this.deployment.evidenceSchemaDigest.toLowerCase() ||
      !lifecycleValues.has(
        row.lifecycle as ReportAttestationLifecycle,
      ) ||
      !reviewOutcomes.has(
        row.desired_review_outcome as ReportReviewOutcome,
      )
    ) {
      throw new Error(
        'Stored report attestation deployment binding is invalid',
      )
    }
    const publication =
      await this.publicationSource.getPublication(
        row.user_id,
        row.publication_key,
        row.revision,
      )
    if (
      !publication ||
      publication.reportId !== row.publication_key ||
      publication.revision !== row.revision ||
      (publication.sourceVersion ??
        'legacy-report-publication-v1') !==
        row.publication_source_version
    ) {
      throw new Error(
        'Stored report attestation publication is unavailable',
      )
    }
    const publicationPreviousSubmissionUID =
      asRequiredHex32(
        publication.previousSubmissionUID ?? ZERO_HEX32,
        'publication previous submission UID',
      )
    const storedPreviousSubmissionUID = asRequiredHex32(
      row.previous_submission_uid,
      'previous submission UID',
    )
    if (
      !Number.isInteger(row.revision) ||
      row.revision < 1 ||
      (row.revision === 1
        ? storedPreviousSubmissionUID !== ZERO_HEX32
        : storedPreviousSubmissionUID === ZERO_HEX32) ||
      publicationPreviousSubmissionUID.toLowerCase() !==
        storedPreviousSubmissionUID
    ) {
      throw new Error(
        'Stored report attestation previous submission changed',
      )
    }
    const digest = artifactDigest(publication.safeArtifactBytes)
    if (
      row.safe_artifact_digest !== null &&
      row.safe_artifact_digest.toLowerCase() !== digest
    ) {
      throw new Error(
        'Stored report attestation publication digest changed',
      )
    }
    const stateVersion = Number(row.state_version)
    if (
      !Number.isSafeInteger(stateVersion) ||
      stateVersion < 1 ||
      Number.isNaN(row.created_at.getTime()) ||
      Number.isNaN(row.updated_at.getTime())
    ) {
      throw new Error(
        'Stored report attestation state version is invalid',
      )
    }
    if (
      row.failure_code !== null &&
      !failureCodeValues.has(
        row.failure_code as ReportAttestationFailureCode,
      )
    ) {
      throw new Error(
        'Stored report attestation failure code is invalid',
      )
    }
    return {
      ownerId: row.user_id,
      reportId: row.publication_key,
      publicationSourceVersion: row.publication_source_version,
      preparedRecordId: row.prepared_record_id,
      contractReportId: asRequiredHex32(
        row.contract_report_id,
        'contract report ID',
      ),
      revision: row.revision,
      previousSubmissionUID: storedPreviousSubmissionUID,
      safeArtifactBytes: publication.safeArtifactBytes.slice(),
      commitment: asHex32(row.commitment),
      safeArtifactDigest: asHex32(row.safe_artifact_digest),
      safeManifestDigest: asHex32(row.safe_manifest_digest),
      derivationRuleDigest: asHex32(
        row.derivation_rule_digest,
      ),
      commitmentNonce: nonceAsHex32(row.commitment_nonce),
      desiredReviewOutcome:
        row.desired_review_outcome as ReportReviewOutcome,
      lifecycle: row.lifecycle as ReportAttestationLifecycle,
      submission: executionResult(
        row.submission_status,
        row.submission_tx_hash,
        row.submission_attestation_uid,
        row.submission_reason_code,
      ),
      review: executionResult(
        row.review_status,
        row.review_tx_hash,
        row.review_attestation_uid,
        row.review_reason_code,
      ),
      failureCode:
        (row.failure_code as
          | ReportAttestationFailureCode
          | null) ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    } satisfies ReportAttestationRecord
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original database error. The connection is released
        // below and the pool decides whether it can be reused.
      }
      throw error
    } finally {
      client.release()
    }
  }
}
