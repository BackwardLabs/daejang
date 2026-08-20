import { createHash } from 'node:crypto'

import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg'
import { describe, expect, it, vi } from 'vitest'

import type { ReportAttestationDeploymentConfig } from '../config.js'
import { PostgresReportAttestationStore } from './postgres-store.js'
import type {
  ReportAttestationPublication,
  ReportAttestationPublicationSource,
} from './publication-source.js'
import { reportAttestationEligibilityCheckCodes } from './publication-source.js'
import type {
  Hex32,
  ReportAttestationRecord,
} from './types.js'

const OWNER_ID = '00000000-0000-4000-8000-000000000028'
const REPORT_ID = 'giwa-sepolia-synthetic-report-2025'
const SOURCE_VERSION = 'giwa.sepolia.synthetic-publication.v1'
const PREPARED_RECORD_ID = `ep_${'1'.repeat(64)}`
const CONTRACT_REPORT_ID = `0x${'2'.repeat(64)}` as Hex32
const SCHEMA_UID = `0x${'3'.repeat(64)}`
const EVIDENCE_SCHEMA_DIGEST = `0x${'4'.repeat(64)}`
const DERIVATION_RULE_DIGEST = `0x${'5'.repeat(64)}` as Hex32
const SAFE_MANIFEST_DIGEST = `0x${'6'.repeat(64)}` as Hex32
const COMMITMENT = `0x${'7'.repeat(64)}` as Hex32
const COMMITMENT_NONCE = `0x${'8'.repeat(64)}` as Hex32
const ZERO_HEX32 = `0x${'0'.repeat(64)}` as Hex32
const DATABASE_ID = '00000000-0000-4000-8000-000000000128'
const ARTIFACT_BYTES = new TextEncoder().encode(
  '{"schemaVersion":"giwa.report.publication.v1","taxYear":2025}',
)

const deployment: ReportAttestationDeploymentConfig = {
  network: 'eip155:91342',
  rpcUrl: 'https://sepolia-rpc.giwa.io',
  easAddress: '0x4200000000000000000000000000000000000021',
  schemaRegistryAddress:
    '0x4200000000000000000000000000000000000020',
  reportRegistryProxyAddress:
    '0x956B9Eef2Fd152AEa4bf3E8B2B073173D9786B04',
  reportConsumerAddress:
    '0xcE84783A2b81570cb0D747f7E1E8ac2E8424A79f',
  governanceSafeAddress:
    '0x1111111111111111111111111111111111111111',
  schemaUID: SCHEMA_UID,
  evidenceSchemaDigest: EVIDENCE_SCHEMA_DIGEST,
}

const digest = (bytes: Uint8Array) =>
  `0x${createHash('sha256').update(bytes).digest('hex')}`

const publication = (
  bytes = ARTIFACT_BYTES,
): ReportAttestationPublication => ({
  reportId: REPORT_ID,
  sourceVersion: SOURCE_VERSION,
  revision: 1,
  safeArtifactBytes: bytes.slice(),
  previousSubmissionUID: ZERO_HEX32,
})

const publicationSource = (
  read: () => ReportAttestationPublication | undefined = () =>
    publication(),
): ReportAttestationPublicationSource => ({
  getEligibility: vi.fn(async () => ({
    reportId: REPORT_ID,
    eligible: true,
    checks: reportAttestationEligibilityCheckCodes.map((code) => ({
      code,
      status: 'PASSED' as const,
    })),
  })),
  getPublication: vi.fn(async () => read()),
})

type StoredRow = {
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

const storedRow = (
  overrides: Partial<StoredRow> = {},
): StoredRow => ({
  id: DATABASE_ID,
  user_id: OWNER_ID,
  publication_key: REPORT_ID,
  publication_source_version: SOURCE_VERSION,
  revision: 1,
  previous_submission_uid: ZERO_HEX32,
  prepared_record_id: PREPARED_RECORD_ID,
  contract_report_id: CONTRACT_REPORT_ID,
  network: deployment.network,
  schema_uid: SCHEMA_UID,
  evidence_schema_digest: EVIDENCE_SCHEMA_DIGEST,
  derivation_rule_digest: null,
  safe_artifact_digest: null,
  safe_manifest_digest: null,
  commitment_nonce: null,
  commitment: null,
  lifecycle: 'PREPARING',
  desired_review_outcome: 'APPROVE',
  submission_tx_hash: null,
  submission_attestation_uid: null,
  submission_status: null,
  submission_reason_code: null,
  review_tx_hash: null,
  review_attestation_uid: null,
  review_status: null,
  review_reason_code: null,
  failure_code: null,
  state_version: '1',
  created_at: new Date('2027-01-01T00:00:00.000Z'),
  updated_at: new Date('2027-01-01T00:00:00.000Z'),
  submitted_at: null,
  reviewed_at: null,
  ...overrides,
})

const preparedStoredRow = (
  overrides: Partial<StoredRow> = {},
) =>
  storedRow({
    derivation_rule_digest: DERIVATION_RULE_DIGEST,
    safe_artifact_digest: digest(ARTIFACT_BYTES),
    safe_manifest_digest: SAFE_MANIFEST_DIGEST,
    commitment_nonce: Buffer.from(
      COMMITMENT_NONCE.slice(2),
      'hex',
    ),
    commitment: COMMITMENT,
    lifecycle: 'PREPARED',
    state_version: '2',
    updated_at: new Date('2027-01-01T00:00:00.001Z'),
    ...overrides,
  })

const preparingRecord = (
  overrides: Partial<ReportAttestationRecord> = {},
): ReportAttestationRecord => ({
  ownerId: OWNER_ID,
  reportId: REPORT_ID,
  publicationSourceVersion: SOURCE_VERSION,
  preparedRecordId: PREPARED_RECORD_ID,
  contractReportId: CONTRACT_REPORT_ID,
  revision: 1,
  previousSubmissionUID: ZERO_HEX32,
  safeArtifactBytes: ARTIFACT_BYTES.slice(),
  commitment: undefined,
  safeArtifactDigest: undefined,
  safeManifestDigest: undefined,
  derivationRuleDigest: undefined,
  commitmentNonce: undefined,
  desiredReviewOutcome: 'APPROVE',
  lifecycle: 'PREPARING',
  submission: undefined,
  review: undefined,
  failureCode: undefined,
  createdAt: new Date('2027-01-01T00:00:00.000Z'),
  updatedAt: new Date('2027-01-01T00:00:00.000Z'),
  ...overrides,
})

const queryResult = <T extends QueryResultRow>(
  rows: T[],
  rowCount = rows.length,
): QueryResult<T> =>
  ({
    command: '',
    rowCount,
    oid: 0,
    fields: [],
    rows,
  }) as QueryResult<T>

const poolWithQuery = (
  query: ReturnType<typeof vi.fn>,
) =>
  ({
    query,
  }) as unknown as Pool

const transactionalPool = (
  query: ReturnType<typeof vi.fn>,
) => {
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(async () => client)
  return {
    pool: { connect } as unknown as Pool,
    connect,
    release,
  }
}

describe('PostgresReportAttestationStore DB53 adapter', () => {
  it('creates only bounded metadata and rehydrates artifact bytes from the source', async () => {
    const row = storedRow()
    const query = vi.fn(async () => queryResult([row]))
    const store = new PostgresReportAttestationStore(
      poolWithQuery(query),
      publicationSource(),
      deployment,
    )

    const created = await store.create(preparingRecord())

    expect(created).toMatchObject({
      result: 'CREATED',
      record: {
        lifecycle: 'PREPARING',
        contractReportId: CONTRACT_REPORT_ID,
      },
    })
    if (created.result !== 'CREATED') {
      throw new Error('expected a newly created record')
    }
    expect(created.record.safeArtifactBytes).toEqual(ARTIFACT_BYTES)
    expect(created.record.safeArtifactBytes).not.toBe(ARTIFACT_BYTES)

    const [sql, values] = query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ]
    expect(sql).toContain('ON CONFLICT DO NOTHING')
    expect(sql).toContain('previous_submission_uid')
    expect(sql).not.toContain('safe_artifact_bytes')
    expect(values[5]).toBe(ZERO_HEX32)
    expect(
      values.some((value) => value instanceof Uint8Array),
    ).toBe(false)
  })

  it('reconciles exact create retries but fails closed on a global identity collision', async () => {
    const exactRow = storedRow()
    const exactQuery = vi
      .fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([exactRow]))
    const exactStore = new PostgresReportAttestationStore(
      poolWithQuery(exactQuery),
      publicationSource(),
      deployment,
    )

    await expect(
      exactStore.create(preparingRecord()),
    ).resolves.toMatchObject({ result: 'EXISTS' })

    const collisionQuery = vi
      .fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(
        queryResult([{ claimed: true }]),
      )
    const collisionStore = new PostgresReportAttestationStore(
      poolWithQuery(collisionQuery),
      publicationSource(),
      deployment,
    )

    await expect(
      collisionStore.create(preparingRecord()),
    ).resolves.toEqual({ result: 'IDENTITY_CLAIMED' })
    const [identitySql, identityValues] =
      collisionQuery.mock.calls[2] as unknown as [
        string,
        unknown[],
      ]
    expect(identitySql).toContain('prepared_record_id = $1')
    expect(identitySql).not.toContain('contract_report_id')
    expect(identityValues).toEqual([PREPARED_RECORD_ID])
  })

  it('rejects non-PREPARING inserts before touching PostgreSQL', async () => {
    const query = vi.fn()
    const store = new PostgresReportAttestationStore(
      poolWithQuery(query),
      publicationSource(),
      deployment,
    )

    await expect(
      store.create(
        preparingRecord({
          lifecycle: 'PREPARED',
          commitment: COMMITMENT,
        }),
      ),
    ).rejects.toThrow(
      'records must be created in PREPARING state',
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('rehydrates only when the current source bytes still match the persisted digest', async () => {
    let currentBytes = ARTIFACT_BYTES.slice()
    const query = vi.fn(async () =>
      queryResult([preparedStoredRow()]),
    )
    const store = new PostgresReportAttestationStore(
      poolWithQuery(query),
      publicationSource(() => publication(currentBytes)),
      deployment,
    )

    await expect(
      store.get(OWNER_ID, REPORT_ID),
    ).resolves.toMatchObject({
      safeArtifactDigest: digest(ARTIFACT_BYTES),
      lifecycle: 'PREPARED',
    })

    currentBytes = new TextEncoder().encode(
      '{"schemaVersion":"giwa.report.publication.v1","taxYear":2026}',
    )
    await expect(
      store.get(OWNER_ID, REPORT_ID),
    ).rejects.toThrow('publication digest changed')
  })

  it('uses DB53 CAS, advances updated_at, and clears stale submission state before a retry', async () => {
    const current = preparedStoredRow({
      lifecycle: 'PENDING',
      submission_status: 'PENDING',
      submission_reason_code: 'SIMULATION_FAILED',
      submitted_at: new Date('2027-01-01T00:00:00.002Z'),
      state_version: '7',
      updated_at: new Date('2027-01-01T00:00:00.010Z'),
    })
    let selectSql = ''
    let selectValues: unknown[] = []
    let updateSql = ''
    let updateValues: unknown[] = []
    const query = vi.fn(
      async (sqlValue: string, values?: unknown[]) => {
        if (
          sqlValue === 'BEGIN' ||
          sqlValue === 'COMMIT' ||
          sqlValue === 'ROLLBACK'
        ) {
          return queryResult([])
        }
        if (sqlValue.includes('SELECT *')) {
          selectSql = sqlValue
          selectValues = values ?? []
          return queryResult([current])
        }
        if (sqlValue.includes('UPDATE web_private')) {
          updateSql = sqlValue
          updateValues = values ?? []
          return queryResult([
            {
              ...current,
              lifecycle: updateValues[7] as string,
              submission_tx_hash: updateValues[8] as string | null,
              submission_attestation_uid:
                updateValues[9] as string | null,
              submission_status: updateValues[10] as string | null,
              submission_reason_code:
                updateValues[11] as string | null,
              review_tx_hash: updateValues[12] as string | null,
              review_attestation_uid:
                updateValues[13] as string | null,
              review_status: updateValues[14] as string | null,
              review_reason_code:
                updateValues[15] as string | null,
              failure_code: updateValues[16] as string | null,
              state_version: '8',
              updated_at: updateValues[17] as Date,
              submitted_at: null,
              reviewed_at: null,
            },
          ])
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const { pool, release } = transactionalPool(query)
    const store = new PostgresReportAttestationStore(
      pool,
      publicationSource(),
      deployment,
    )

    const updated = await store.update(
      OWNER_ID,
      REPORT_ID,
      1,
      (record) => ({
        ...record,
        lifecycle: 'SUBMISSION_QUEUED',
        updatedAt: new Date('2027-01-01T00:00:00.000Z'),
      }),
    )

    expect(updated).toMatchObject({
      lifecycle: 'SUBMISSION_QUEUED',
      submission: undefined,
    })
    expect(selectSql).toMatch(/AND revision = \$3/)
    expect(selectValues).toEqual([OWNER_ID, REPORT_ID, 1])
    expect(updateSql).toContain(
      'WHERE id = $1 AND state_version = $2',
    )
    expect(updateSql).toMatch(
      /submitted_at = CASE\s+WHEN \$11::text IS NULL THEN NULL/,
    )
    expect(updateValues[1]).toBe('7')
    expect(updateValues[10]).toBeNull()
    expect(updateValues[17]).toBeInstanceOf(Date)
    expect(
      (updateValues[17] as Date).getTime(),
    ).toBeGreaterThan(current.updated_at.getTime())
    expect(release).toHaveBeenCalledOnce()
  })

  it('preserves a required nonterminal runtime reason for DB53', async () => {
    const current = preparedStoredRow({
      lifecycle: 'SUBMITTING',
      state_version: '4',
      updated_at: new Date('2027-01-01T00:00:00.004Z'),
    })
    let updateValues: unknown[] = []
    const query = vi.fn(
      async (sqlValue: string, values?: unknown[]) => {
        if (
          sqlValue === 'BEGIN' ||
          sqlValue === 'COMMIT'
        ) {
          return queryResult([])
        }
        if (sqlValue.includes('SELECT *')) {
          return queryResult([current])
        }
        if (sqlValue.includes('UPDATE web_private')) {
          updateValues = values ?? []
          return queryResult([
            {
              ...current,
              lifecycle: updateValues[7] as string,
              submission_tx_hash: updateValues[8] as string | null,
              submission_attestation_uid:
                updateValues[9] as string | null,
              submission_status: updateValues[10] as string | null,
              submission_reason_code:
                updateValues[11] as string | null,
              state_version: '5',
              updated_at: updateValues[17] as Date,
              submitted_at: updateValues[17] as Date,
            },
          ])
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const { pool } = transactionalPool(query)
    const store = new PostgresReportAttestationStore(
      pool,
      publicationSource(),
      deployment,
    )

    const updated = await store.update(
      OWNER_ID,
      REPORT_ID,
      1,
      (record) => ({
        ...record,
        lifecycle: 'PENDING',
        submission: {
          status: 'PENDING',
          transactionHash: null,
          attestationUID: null,
          reasonCode: 'SIMULATION_FAILED',
        },
        updatedAt: new Date('2027-01-01T00:00:00.005Z'),
      }),
    )

    expect(updateValues[11]).toBe('SIMULATION_FAILED')
    expect(updated?.submission).toEqual({
      status: 'PENDING',
      transactionHash: null,
      attestationUID: null,
      reasonCode: 'SIMULATION_FAILED',
    })
  })

  it('rolls back an incomplete prepared commitment before issuing an UPDATE', async () => {
    const current = storedRow()
    const query = vi.fn(
      async (sqlValue: string) => {
        if (
          sqlValue === 'BEGIN' ||
          sqlValue === 'ROLLBACK'
        ) {
          return queryResult([])
        }
        if (sqlValue.includes('SELECT *')) {
          return queryResult([current])
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const { pool } = transactionalPool(query)
    const store = new PostgresReportAttestationStore(
      pool,
      publicationSource(),
      deployment,
    )

    await expect(
      store.update(OWNER_ID, REPORT_ID, 1, (record) => ({
        ...record,
        lifecycle: 'PREPARED',
        commitment: COMMITMENT,
        updatedAt: new Date('2027-01-01T00:00:00.001Z'),
      })),
    ).rejects.toThrow('commitment metadata is incomplete')
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE web_private'),
      ),
    ).toBe(false)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rejects a previous submission pointer change before issuing an UPDATE', async () => {
    const current = preparedStoredRow()
    const query = vi.fn(
      async (sqlValue: string) => {
        if (
          sqlValue === 'BEGIN' ||
          sqlValue === 'ROLLBACK'
        ) {
          return queryResult([])
        }
        if (sqlValue.includes('SELECT *')) {
          return queryResult([current])
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const { pool } = transactionalPool(query)
    const store = new PostgresReportAttestationStore(
      pool,
      publicationSource(),
      deployment,
    )

    await expect(
      store.update(OWNER_ID, REPORT_ID, 1, (record) => ({
        ...record,
        previousSubmissionUID: `0x${'f'.repeat(64)}`,
        lifecycle: 'SUBMISSION_QUEUED',
        updatedAt: new Date('2027-01-01T00:00:00.002Z'),
      })),
    ).rejects.toThrow('identity fields cannot be changed')
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE web_private'),
      ),
    ).toBe(false)
  })

  it('projects confirmed operation receipts before marking unresolved writes for reconciliation', async () => {
    const query = vi.fn(
      async (sqlValue: string) => {
        if (
          sqlValue === 'BEGIN' ||
          sqlValue === 'COMMIT'
        ) {
          return queryResult([])
        }
        if (
          sqlValue.includes(
            'UPDATE web_private.report_attestation_operations',
          )
        ) {
          return queryResult([], 2)
        }
        if (
          sqlValue.includes(
            "operations.action = 'SUBMIT'",
          )
        ) {
          return queryResult([], 3)
        }
        if (
          sqlValue.includes(
            'UPDATE web_private.report_attestation_records',
          )
        ) {
          return queryResult([], 1)
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const { pool, release } = transactionalPool(query)
    const store = new PostgresReportAttestationStore(
      pool,
      publicationSource(),
      deployment,
    )

    await expect(store.recoverInterrupted()).resolves.toBe(3)

    const statements = query.mock.calls
      .map(([value]) => String(value))
    const sql = statements.join('\n')
    expect(sql).toContain("state IN ('RESERVED', 'IN_FLIGHT')")
    expect(sql).toContain(
      'PROCESS_RESTART_REQUIRES_RECONCILIATION',
    )
    expect(sql).toContain(
      "'INTERRUPTED_WRITE_REQUIRES_RECONCILIATION'",
    )
    expect(sql).toContain("lifecycle = 'PREPARATION_FAILED'")
    expect(sql).toContain("WHERE lifecycle = 'PREPARING'")
    expect(sql).toContain(
      "failure_code = 'PREPARATION_EXECUTION_FAILED'",
    )
    expect(sql).toContain(
      "THEN 'RECONCILIATION_REQUIRED'",
    )
    expect(sql).toContain(
      "review_status IS DISTINCT FROM 'CONFIRMED'",
    )
    expect(sql).toContain(
      'PROCESS_RESTART_REQUIRES_RECONCILIATION',
    )
    const confirmedSubmissionSql = statements.find(
      (value) => value.includes("operations.action = 'SUBMIT'"),
    )
    expect(confirmedSubmissionSql).toMatch(
      /lifecycle = 'SUBMITTED'/,
    )
    expect(confirmedSubmissionSql).toMatch(
      /submission_tx_hash = operations\.tx_hash/,
    )
    expect(confirmedSubmissionSql).toMatch(
      /submission_attestation_uid =\s+operations\.attestation_uid/,
    )
    expect(confirmedSubmissionSql).toMatch(
      /submission_status = 'CONFIRMED'/,
    )
    expect(confirmedSubmissionSql).toMatch(
      /operations\.state = 'CONFIRMED'/,
    )
    expect(confirmedSubmissionSql).toMatch(
      /records\.lifecycle = 'SUBMITTING'/,
    )

    const confirmedReviewSql = statements.find(
      (value) =>
        value.includes(
          "operations.action IN ('APPROVE', 'REJECT')",
        ),
    )
    expect(confirmedReviewSql).toMatch(
      /lifecycle = 'RECONCILIATION_REQUIRED'/,
    )
    expect(confirmedReviewSql).toMatch(
      /review_tx_hash = operations\.tx_hash/,
    )
    expect(confirmedReviewSql).toMatch(
      /review_attestation_uid =\s+operations\.attestation_uid/,
    )
    expect(confirmedReviewSql).toMatch(
      /review_status = 'CONFIRMED'/,
    )
    expect(confirmedReviewSql).toMatch(
      /failure_code = 'REVIEW_RECONCILIATION_FAILED'/,
    )
    expect(confirmedReviewSql).toMatch(
      /operations\.action =\s+records\.desired_review_outcome/,
    )
    expect(confirmedReviewSql).toMatch(
      /records\.lifecycle = 'REVIEWING'/,
    )
    expect(confirmedReviewSql).toMatch(
      /records\.submission_status = 'CONFIRMED'/,
    )

    const confirmedSubmissionIndex = statements.indexOf(
      confirmedSubmissionSql ?? '',
    )
    const confirmedReviewIndex = statements.indexOf(
      confirmedReviewSql ?? '',
    )
    const genericReconciliationIndex = statements.findIndex(
      (value) =>
        value.includes('submission_status = CASE'),
    )
    expect(confirmedSubmissionIndex).toBeGreaterThan(-1)
    expect(confirmedReviewIndex).toBeGreaterThan(
      confirmedSubmissionIndex,
    )
    expect(genericReconciliationIndex).toBeGreaterThan(
      confirmedReviewIndex,
    )
    expect(sql).toContain("updated_at + interval '1 microsecond'")
    expect(query).toHaveBeenCalledWith('BEGIN')
    expect(query).toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects corrupt required identifiers instead of casting them into the domain type', async () => {
    const query = vi.fn(async () =>
      queryResult([
        storedRow({
          contract_report_id: null as unknown as string,
        }),
      ]),
    )
    const store = new PostgresReportAttestationStore(
      poolWithQuery(query),
      publicationSource(),
      deployment,
    )

    await expect(
      store.get(OWNER_ID, REPORT_ID),
    ).rejects.toThrow('contract report ID is missing')
  })
})
