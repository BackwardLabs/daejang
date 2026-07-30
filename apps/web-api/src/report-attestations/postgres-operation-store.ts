import { createHash } from 'node:crypto'

import type {
  Pool,
  PoolClient,
} from 'pg'

import type { Hex32 } from './types.js'

export type ReportAttestationOperationAction =
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'

export type ReportAttestationOperationResultStatus =
  | 'SUBMITTED'
  | 'USABLE'
  | 'UNUSABLE'

export type ReportAttestationOperationClaim =
  | Readonly<{
      disposition: 'CLAIMED'
      databaseOperationKey: string
    }>
  | Readonly<{
      disposition: 'REPLAY_CONFIRMED'
      databaseOperationKey: string
      transactionHash: Hex32
      attestationUID: Hex32
      resultStatus: ReportAttestationOperationResultStatus
    }>
  | Readonly<{
      disposition:
        | 'BLOCKED_IN_FLIGHT'
        | 'RECONCILIATION_REQUIRED'
      databaseOperationKey: string
      transactionHash: Hex32 | null
      reasonCode: string | null
    }>

export interface ReportAttestationOperationStore {
  claimForBroadcast(input: {
    canonicalOperationKey: string
    preparedRecordId: string
    action: ReportAttestationOperationAction
    planFingerprint: Hex32
    requestFingerprint: Hex32
  }): Promise<ReportAttestationOperationClaim>
  recordTransactionHash(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
  }): Promise<void>
  confirm(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
    attestationUID: Hex32
    resultStatus: ReportAttestationOperationResultStatus
  }): Promise<void>
  requireReconciliation(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32 | null
    reasonCode: string
  }): Promise<void>
}

type OperationRow = {
  operation_key: string
  record_id: string
  action: string
  plan_fingerprint: string
  request_fingerprint: string
  state:
    | 'RESERVED'
    | 'IN_FLIGHT'
    | 'CONFIRMED'
    | 'RECONCILIATION_REQUIRED'
  tx_hash: string | null
  attestation_uid: string | null
  result_status: string | null
  reason_code: string | null
  state_version: string
}

const hex32Pattern = /^0x[0-9a-f]{64}$/
const operationKeyPattern = /^op_[0-9a-f]{64}$/

const normalizeHex32 = (value: string, label: string): Hex32 => {
  const normalized = value.toLowerCase()
  if (!hex32Pattern.test(normalized)) {
    throw new Error(`${label} must be a bytes32 hex value`)
  }
  return normalized as Hex32
}

const withoutHexPrefix = (value: Hex32) => value.slice(2)

/**
 * The contracts package intentionally exposes a descriptive canonical key
 * (`issuer-submit:v1:...` / `reviewer-decision:v1:...`). The DB keeps a fixed,
 * non-sensitive key shape, so the canonical value is domain-separated and
 * hashed before persistence. Identical canonical keys always resolve to the
 * same primary key.
 */
export const databaseOperationKey = (
  canonicalOperationKey: string,
) => {
  if (
    typeof canonicalOperationKey !== 'string' ||
    canonicalOperationKey.length < 1 ||
    canonicalOperationKey.length > 1_024
  ) {
    throw new Error('Canonical operation key is invalid')
  }
  return `op_${createHash('sha256')
    .update('giwa.report-attestation.operation-key.v1')
    .update('\u0000')
    .update(canonicalOperationKey)
    .digest('hex')}`
}

const normalizeReasonCode = (value: string) => {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new Error('Operation reconciliation reason is invalid')
  }
  return value
}

const resultForAction = (
  action: ReportAttestationOperationAction,
): ReportAttestationOperationResultStatus =>
  action === 'SUBMIT'
    ? 'SUBMITTED'
    : action === 'APPROVE'
      ? 'USABLE'
      : 'UNUSABLE'

const asNullableHex32 = (
  value: string | null,
  label: string,
) => (value === null ? null : normalizeHex32(value, label))

const assertBinding = (
  row: OperationRow,
  input: {
    databaseKey: string
    recordId?: string
    action?: ReportAttestationOperationAction
    planFingerprint: Hex32
    requestFingerprint?: Hex32
  },
) => {
  if (
    row.operation_key !== input.databaseKey ||
    (input.recordId !== undefined &&
      row.record_id !== input.recordId) ||
    (input.action !== undefined && row.action !== input.action) ||
    row.plan_fingerprint !==
      withoutHexPrefix(input.planFingerprint) ||
    (input.requestFingerprint !== undefined &&
      row.request_fingerprint !==
        withoutHexPrefix(input.requestFingerprint))
  ) {
    throw new Error('Report attestation operation binding conflict')
  }
}

export class PostgresReportAttestationOperationStore
  implements ReportAttestationOperationStore
{
  constructor(private readonly pool: Pool) {}

  async claimForBroadcast(input: {
    canonicalOperationKey: string
    preparedRecordId: string
    action: ReportAttestationOperationAction
    planFingerprint: Hex32
    requestFingerprint: Hex32
  }): Promise<ReportAttestationOperationClaim> {
    const databaseKey = databaseOperationKey(
      input.canonicalOperationKey,
    )
    const planFingerprint = normalizeHex32(
      input.planFingerprint,
      'Plan fingerprint',
    )
    const requestFingerprint = normalizeHex32(
      input.requestFingerprint,
      'Request fingerprint',
    )
    if (
      !/^(SUBMIT|APPROVE|REJECT)$/.test(input.action) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(input.preparedRecordId)
    ) {
      throw new Error('Operation context is invalid')
    }

    return this.#transaction(async (client) => {
      const recordResult = await client.query<{ id: string }>(
        `
          SELECT id
          FROM web_private.report_attestation_records
          WHERE prepared_record_id = $1
          FOR UPDATE
        `,
        [input.preparedRecordId],
      )
      const recordId = recordResult.rows[0]?.id
      if (!recordId) {
        throw new Error(
          'Prepared report record is unavailable for operation reservation',
        )
      }

      const existingResult = await client.query<OperationRow>(
        `
          SELECT *
          FROM web_private.report_attestation_operations
          WHERE operation_key = $1
             OR (
               record_id = $2
               AND (
                 ($3 = 'SUBMIT' AND action = 'SUBMIT')
                 OR (
                   $3 IN ('APPROVE', 'REJECT')
                   AND action IN ('APPROVE', 'REJECT')
                 )
               )
             )
          FOR UPDATE
        `,
        [databaseKey, recordId, input.action],
      )
      if (existingResult.rows.length > 1) {
        throw new Error(
          'Multiple report attestation operations claim the same action',
        )
      }
      let row = existingResult.rows[0]
      if (!row) {
        const inserted = await client.query<OperationRow>(
          `
            INSERT INTO web_private.report_attestation_operations (
              operation_key,
              record_id,
              action,
              plan_fingerprint,
              request_fingerprint
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [
            databaseKey,
            recordId,
            input.action,
            withoutHexPrefix(planFingerprint),
            withoutHexPrefix(requestFingerprint),
          ],
        )
        row = inserted.rows[0]
        if (!row) {
          throw new Error(
            'Report attestation operation reservation was not persisted',
          )
        }
      } else {
        assertBinding(row, {
          databaseKey,
          recordId,
          action: input.action,
          planFingerprint,
          requestFingerprint,
        })
      }

      if (row.state === 'CONFIRMED') {
        const transactionHash = asNullableHex32(
          row.tx_hash,
          'Stored operation transaction hash',
        )
        const attestationUID = asNullableHex32(
          row.attestation_uid,
          'Stored operation attestation UID',
        )
        const expectedResult = resultForAction(input.action)
        if (
          transactionHash === null ||
          attestationUID === null ||
          row.result_status !== expectedResult
        ) {
          throw new Error(
            'Confirmed report attestation operation is incomplete',
          )
        }
        return {
          disposition: 'REPLAY_CONFIRMED',
          databaseOperationKey: databaseKey,
          transactionHash,
          attestationUID,
          resultStatus: expectedResult,
        }
      }
      if (row.state === 'IN_FLIGHT') {
        return {
          disposition: 'BLOCKED_IN_FLIGHT',
          databaseOperationKey: databaseKey,
          transactionHash: asNullableHex32(
            row.tx_hash,
            'Stored operation transaction hash',
          ),
          reasonCode: null,
        }
      }
      if (row.state === 'RECONCILIATION_REQUIRED') {
        return {
          disposition: 'RECONCILIATION_REQUIRED',
          databaseOperationKey: databaseKey,
          transactionHash: asNullableHex32(
            row.tx_hash,
            'Stored operation transaction hash',
          ),
          reasonCode: row.reason_code,
        }
      }

      /*
       * A RESERVED row should only exist inside this transaction. If one was
       * committed by another implementation, do not assume that no broadcast
       * occurred; fail closed and require reconciliation.
       */
      if (existingResult.rows[0]) {
        await this.#markReconciliation(
          client,
          row,
          null,
          'INTERRUPTED_BEFORE_BROADCAST',
        )
        return {
          disposition: 'RECONCILIATION_REQUIRED',
          databaseOperationKey: databaseKey,
          transactionHash: null,
          reasonCode: 'INTERRUPTED_BEFORE_BROADCAST',
        }
      }

      const claimed = await client.query<OperationRow>(
        `
          UPDATE web_private.report_attestation_operations
          SET
            state = 'IN_FLIGHT',
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            ),
            in_flight_at = clock_timestamp()
          WHERE operation_key = $1
            AND state = 'RESERVED'
            AND state_version = $2
          RETURNING *
        `,
        [databaseKey, row.state_version],
      )
      if (!claimed.rows[0]) {
        throw new Error(
          'Report attestation operation claim lost its version race',
        )
      }
      return {
        disposition: 'CLAIMED',
        databaseOperationKey: databaseKey,
      }
    })
  }

  async recordTransactionHash(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
  }) {
    const databaseKey = databaseOperationKey(
      input.canonicalOperationKey,
    )
    const planFingerprint = normalizeHex32(
      input.planFingerprint,
      'Plan fingerprint',
    )
    const transactionHash = normalizeHex32(
      input.transactionHash,
      'Transaction hash',
    )
    await this.#transaction(async (client) => {
      const row = await this.#readForUpdate(client, databaseKey)
      assertBinding(row, { databaseKey, planFingerprint })
      if (row.state === 'CONFIRMED') {
        if (row.tx_hash !== transactionHash) {
          throw new Error(
            'Confirmed operation transaction hash conflict',
          )
        }
        return
      }
      if (row.state !== 'IN_FLIGHT') {
        throw new Error(
          'Transaction hash cannot be attached outside IN_FLIGHT',
        )
      }
      if (row.tx_hash !== null) {
        if (row.tx_hash !== transactionHash) {
          throw new Error(
            'Operation transaction hash conflict',
          )
        }
        return
      }
      const result = await client.query(
        `
          UPDATE web_private.report_attestation_operations
          SET
            tx_hash = $2,
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            )
          WHERE operation_key = $1
            AND state = 'IN_FLIGHT'
            AND tx_hash IS NULL
            AND state_version = $3
        `,
        [databaseKey, transactionHash, row.state_version],
      )
      if (result.rowCount !== 1) {
        throw new Error(
          'Operation transaction hash update lost its version race',
        )
      }
    })
  }

  async confirm(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
    attestationUID: Hex32
    resultStatus: ReportAttestationOperationResultStatus
  }) {
    const databaseKey = databaseOperationKey(
      input.canonicalOperationKey,
    )
    const planFingerprint = normalizeHex32(
      input.planFingerprint,
      'Plan fingerprint',
    )
    const transactionHash = normalizeHex32(
      input.transactionHash,
      'Transaction hash',
    )
    const attestationUID = normalizeHex32(
      input.attestationUID,
      'Attestation UID',
    )
    await this.#transaction(async (client) => {
      const row = await this.#readForUpdate(client, databaseKey)
      assertBinding(row, { databaseKey, planFingerprint })
      const expectedResult = resultForAction(
        row.action as ReportAttestationOperationAction,
      )
      if (input.resultStatus !== expectedResult) {
        throw new Error(
          'Operation result does not match its action',
        )
      }
      if (row.state === 'CONFIRMED') {
        if (
          row.tx_hash !== transactionHash ||
          row.attestation_uid !== attestationUID ||
          row.result_status !== input.resultStatus
        ) {
          throw new Error('Operation confirmation conflict')
        }
        return
      }
      if (
        row.state !== 'IN_FLIGHT' &&
        row.state !== 'RECONCILIATION_REQUIRED'
      ) {
        throw new Error(
          'Operation cannot be confirmed from its current state',
        )
      }
      if (
        row.tx_hash !== null &&
        row.tx_hash !== transactionHash
      ) {
        throw new Error(
          'Operation confirmation transaction hash conflict',
        )
      }
      const result = await client.query(
        `
          UPDATE web_private.report_attestation_operations
          SET
            state = 'CONFIRMED',
            tx_hash = $2,
            attestation_uid = $3,
            result_status = $4,
            reason_code = NULL,
            state_version = state_version + 1,
            updated_at = GREATEST(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            ),
            confirmed_at = clock_timestamp(),
            reconciliation_required_at = NULL
          WHERE operation_key = $1
            AND state_version = $5
        `,
        [
          databaseKey,
          transactionHash,
          attestationUID,
          input.resultStatus,
          row.state_version,
        ],
      )
      if (result.rowCount !== 1) {
        throw new Error(
          'Operation confirmation lost its version race',
        )
      }
    })
  }

  async requireReconciliation(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32 | null
    reasonCode: string
  }) {
    const databaseKey = databaseOperationKey(
      input.canonicalOperationKey,
    )
    const planFingerprint = normalizeHex32(
      input.planFingerprint,
      'Plan fingerprint',
    )
    const transactionHash =
      input.transactionHash === null
        ? null
        : normalizeHex32(
            input.transactionHash,
            'Transaction hash',
          )
    const reasonCode = normalizeReasonCode(input.reasonCode)
    await this.#transaction(async (client) => {
      const row = await this.#readForUpdate(client, databaseKey)
      assertBinding(row, { databaseKey, planFingerprint })
      if (row.state === 'CONFIRMED') return
      if (row.state === 'RECONCILIATION_REQUIRED') {
        if (
          row.tx_hash !== null &&
          transactionHash !== null &&
          row.tx_hash !== transactionHash
        ) {
          throw new Error(
            'Operation reconciliation transaction hash conflict',
          )
        }
        return
      }
      await this.#markReconciliation(
        client,
        row,
        transactionHash,
        reasonCode,
      )
    })
  }

  async recoverInterruptedOperations() {
    const result = await this.pool.query(
      `
        UPDATE web_private.report_attestation_operations
        SET
          state = 'RECONCILIATION_REQUIRED',
          reason_code = 'PROCESS_INTERRUPTED',
          state_version = state_version + 1,
          updated_at = GREATEST(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          ),
          reconciliation_required_at = clock_timestamp()
        WHERE state IN ('RESERVED', 'IN_FLIGHT')
      `,
    )
    return result.rowCount ?? 0
  }

  async #readForUpdate(
    client: PoolClient,
    databaseKey: string,
  ) {
    if (!operationKeyPattern.test(databaseKey)) {
      throw new Error('Database operation key is invalid')
    }
    const result = await client.query<OperationRow>(
      `
        SELECT *
        FROM web_private.report_attestation_operations
        WHERE operation_key = $1
        FOR UPDATE
      `,
      [databaseKey],
    )
    const row = result.rows[0]
    if (!row) {
      throw new Error(
        'Report attestation operation is unavailable',
      )
    }
    return row
  }

  async #markReconciliation(
    client: PoolClient,
    row: OperationRow,
    transactionHash: Hex32 | null,
    reasonCode: string,
  ) {
    const effectiveHash = transactionHash ?? row.tx_hash
    if (
      effectiveHash !== null &&
      !hex32Pattern.test(effectiveHash)
    ) {
      throw new Error('Stored transaction hash is invalid')
    }
    const result = await client.query(
      `
        UPDATE web_private.report_attestation_operations
        SET
          state = 'RECONCILIATION_REQUIRED',
          tx_hash = $2,
          reason_code = $3,
          state_version = state_version + 1,
          updated_at = GREATEST(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          ),
          reconciliation_required_at = clock_timestamp()
        WHERE operation_key = $1
          AND state_version = $4
      `,
      [
        row.operation_key,
        effectiveHash,
        normalizeReasonCode(reasonCode),
        row.state_version,
      ],
    )
    if (result.rowCount !== 1) {
      throw new Error(
        'Operation reconciliation update lost its version race',
      )
    }
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
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
