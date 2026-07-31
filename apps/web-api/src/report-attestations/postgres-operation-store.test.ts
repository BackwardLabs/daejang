import type { Pool } from 'pg'
import {
  describe,
  expect,
  it,
} from 'vitest'

import {
  databaseOperationKey,
  PostgresReportAttestationOperationStore,
} from './postgres-operation-store.js'
import type { Hex32 } from './types.js'

const hex32 = (byte: string) =>
  `0x${byte.repeat(64)}` as Hex32

type FakeOperationRow = {
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

class FakeOperationDatabase {
  row: FakeOperationRow | undefined
  commits = 0
  rollbacks = 0

  readonly client = {
    query: async (
      sql: string,
      parameters: unknown[] = [],
    ) => this.query(sql, parameters),
    release: () => undefined,
  }

  readonly pool = {
    connect: async () => this.client,
    query: async (
      sql: string,
      parameters: unknown[] = [],
    ) => this.query(sql, parameters),
  } as unknown as Pool

  query(sql: string, parameters: unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'BEGIN') {
      return { rows: [], rowCount: null }
    }
    if (normalized === 'COMMIT') {
      this.commits += 1
      return { rows: [], rowCount: null }
    }
    if (normalized === 'ROLLBACK') {
      this.rollbacks += 1
      return { rows: [], rowCount: null }
    }
    if (
      normalized.startsWith(
        'SELECT id FROM web_private.report_attestation_records',
      )
    ) {
      return parameters[0] === 'ep_record'
        ? { rows: [{ id: 'record-1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (
      normalized.startsWith(
        'SELECT * FROM web_private.report_attestation_operations',
      )
    ) {
      return {
        rows: this.row ? [{ ...this.row }] : [],
        rowCount: this.row ? 1 : 0,
      }
    }
    if (
      normalized.startsWith(
        'INSERT INTO web_private.report_attestation_operations',
      )
    ) {
      this.row = {
        operation_key: parameters[0] as string,
        record_id: parameters[1] as string,
        action: parameters[2] as string,
        plan_fingerprint: parameters[3] as string,
        request_fingerprint: parameters[4] as string,
        state: 'RESERVED',
        tx_hash: null,
        attestation_uid: null,
        result_status: null,
        reason_code: null,
        state_version: '1',
      }
      return { rows: [{ ...this.row }], rowCount: 1 }
    }
    if (
      normalized.includes("state = 'IN_FLIGHT'") &&
      normalized.includes("state = 'RESERVED'")
    ) {
      if (!this.row) return { rows: [], rowCount: 0 }
      this.row.state = 'IN_FLIGHT'
      this.row.state_version = String(
        Number(this.row.state_version) + 1,
      )
      return { rows: [{ ...this.row }], rowCount: 1 }
    }
    if (
      normalized.startsWith(
        'UPDATE web_private.report_attestation_operations',
      ) &&
      normalized.includes('tx_hash = $2') &&
      normalized.includes("state = 'IN_FLIGHT'") &&
      !normalized.includes("state = 'CONFIRMED'")
    ) {
      if (!this.row) return { rows: [], rowCount: 0 }
      this.row.tx_hash = parameters[1] as string
      this.row.state_version = String(
        Number(this.row.state_version) + 1,
      )
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes("state = 'CONFIRMED'")) {
      if (!this.row) return { rows: [], rowCount: 0 }
      this.row.state = 'CONFIRMED'
      this.row.tx_hash = parameters[1] as string
      this.row.attestation_uid = parameters[2] as string
      this.row.result_status = parameters[3] as string
      this.row.reason_code = null
      this.row.state_version = String(
        Number(this.row.state_version) + 1,
      )
      return { rows: [], rowCount: 1 }
    }
    if (
      normalized.includes(
        "state = 'RECONCILIATION_REQUIRED'",
      )
    ) {
      if (!this.row) return { rows: [], rowCount: 0 }
      this.row.state = 'RECONCILIATION_REQUIRED'
      this.row.tx_hash = parameters[1] as string | null
      this.row.reason_code = parameters[2] as string
      this.row.state_version = String(
        Number(this.row.state_version) + 1,
      )
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL in test: ${normalized}`)
  }
}

describe('Postgres report attestation operation store', () => {
  it('maps descriptive contracts keys to stable DB-safe keys', () => {
    const first = databaseOperationKey(
      'issuer-submit:v1:deployment:ep_record',
    )
    const second = databaseOperationKey(
      'issuer-submit:v1:deployment:ep_record',
    )
    expect(first).toBe(second)
    expect(first).toMatch(/^op_[0-9a-f]{64}$/)
  })

  it('persists reservation, tx hash, receipt, and replays without a new claim', async () => {
    const database = new FakeOperationDatabase()
    const store =
      new PostgresReportAttestationOperationStore(
        database.pool,
      )
    const operationKey =
      'issuer-submit:v1:deployment:ep_record'

    const claim = await store.claimForBroadcast({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'SUBMIT',
      planFingerprint: hex32('1'),
      requestFingerprint: hex32('2'),
    })
    expect(claim.disposition).toBe('CLAIMED')

    await store.recordTransactionHash({
      canonicalOperationKey: operationKey,
      planFingerprint: hex32('1'),
      transactionHash: hex32('3'),
    })
    await store.confirm({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'SUBMIT',
      planFingerprint: hex32('1'),
      transactionHash: hex32('3'),
      attestationUID: hex32('4'),
      resultStatus: 'SUBMITTED',
    })

    const replay = await store.claimForBroadcast({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'SUBMIT',
      planFingerprint: hex32('1'),
      requestFingerprint: hex32('2'),
    })
    expect(replay).toMatchObject({
      disposition: 'REPLAY_CONFIRMED',
      transactionHash: hex32('3'),
      attestationUID: hex32('4'),
      resultStatus: 'SUBMITTED',
    })
    expect(database.row?.state).toBe('CONFIRMED')
    expect(database.commits).toBe(4)
    expect(database.rollbacks).toBe(0)
  })

  it('returns an existing IN_FLIGHT claim without changing it', async () => {
    const database = new FakeOperationDatabase()
    const store =
      new PostgresReportAttestationOperationStore(
        database.pool,
      )
    const operationKey =
      'issuer-submit:v1:deployment:ep_record'
    await store.claimForBroadcast({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'SUBMIT',
      planFingerprint: hex32('1'),
      requestFingerprint: hex32('2'),
    })

    const blocked = await store.claimForBroadcast({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'SUBMIT',
      planFingerprint: hex32('1'),
      requestFingerprint: hex32('2'),
    })
    expect(blocked).toMatchObject({
      disposition: 'BLOCKED_IN_FLIGHT',
      transactionHash: null,
    })
    expect(database.row?.state).toBe('IN_FLIGHT')
  })

  it('fails closed when a reconciliation binding changes owner-scoped record, action, fingerprint, or tx', async () => {
    const database = new FakeOperationDatabase()
    const store =
      new PostgresReportAttestationOperationStore(
        database.pool,
      )
    const operationKey =
      'reviewer-decision:v1:submission_uid'
    await store.claimForBroadcast({
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'APPROVE',
      planFingerprint: hex32('1'),
      requestFingerprint: hex32('2'),
    })
    await store.recordTransactionHash({
      canonicalOperationKey: operationKey,
      planFingerprint: hex32('1'),
      transactionHash: hex32('3'),
    })
    await store.requireReconciliation({
      canonicalOperationKey: operationKey,
      planFingerprint: hex32('1'),
      transactionHash: hex32('3'),
      reasonCode: 'POST_STATE_NOT_VERIFIED',
    })

    const valid = {
      canonicalOperationKey: operationKey,
      preparedRecordId: 'ep_record',
      action: 'APPROVE' as const,
      planFingerprint: hex32('1'),
      transactionHash: hex32('3'),
    }
    await expect(
      store.verifyReconciliationBinding({
        ...valid,
        preparedRecordId: 'ep_other',
      }),
    ).rejects.toThrow()
    await expect(
      store.verifyReconciliationBinding({
        ...valid,
        action: 'REJECT',
      }),
    ).rejects.toThrow()
    await expect(
      store.verifyReconciliationBinding({
        ...valid,
        planFingerprint: hex32('4'),
      }),
    ).rejects.toThrow()
    await expect(
      store.verifyReconciliationBinding({
        ...valid,
        transactionHash: hex32('5'),
      }),
    ).rejects.toThrow()

    await expect(
      store.verifyReconciliationBinding(valid),
    ).resolves.toBeUndefined()
    expect(database.row?.state).toBe(
      'RECONCILIATION_REQUIRED',
    )
  })
})
