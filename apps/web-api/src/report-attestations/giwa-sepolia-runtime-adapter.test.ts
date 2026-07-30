import { createHash } from 'node:crypto'

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  loadGiwaSepoliaReportAttestationRuntime,
  type GiwaSepoliaPreparedRecordProjection,
} from './giwa-sepolia-runtime-adapter.js'
import type {
  ReportAttestationOperationAction,
  ReportAttestationOperationClaim,
  ReportAttestationOperationResultStatus,
  ReportAttestationOperationStore,
} from './postgres-operation-store.js'
import type { Hex32 } from './types.js'

const hex32 = (value: string) =>
  `0x${createHash('sha256').update(value).digest('hex')}` as Hex32

const REPORT_ID = hex32('report')
const DERIVATION_DIGEST = hex32('derivation')
const NONCE = hex32('nonce')
const SUBMIT_PLAN = hex32('submit-plan')
const REVIEW_PLAN = hex32('review-plan')
const SUBMIT_TX = hex32('submit-tx')
const REVIEW_TX = hex32('review-tx')
const SUBMISSION_UID = hex32('submission-uid')
const APPROVAL_UID = hex32('approval-uid')
const ZERO = `0x${'00'.repeat(32)}` as Hex32
const EAS_ADDRESS =
  '0x4200000000000000000000000000000000000021'
const WRONG_TARGET =
  '0x3333333333333333333333333333333333333333'
const SAFE_ARTIFACT = new TextEncoder().encode(
  '{"safe":"synthetic"}',
)
const SAFE_MANIFEST =
  `0x${'12'.repeat(128)}` as `0x${string}`

class MemoryOperationStore
  implements ReportAttestationOperationStore
{
  readonly records = new Map<
    string,
    {
      action: ReportAttestationOperationAction
      fingerprint: Hex32
      state: 'IN_FLIGHT' | 'CONFIRMED' | 'RECONCILIATION'
      transactionHash: Hex32 | null
      attestationUID: Hex32 | null
      resultStatus:
        | ReportAttestationOperationResultStatus
        | null
    }
  >()

  async claimForBroadcast(input: {
    canonicalOperationKey: string
    preparedRecordId: string
    action: ReportAttestationOperationAction
    planFingerprint: Hex32
    requestFingerprint: Hex32
  }): Promise<ReportAttestationOperationClaim> {
    const existing = this.records.get(
      input.canonicalOperationKey,
    )
    if (existing?.state === 'CONFIRMED') {
      return {
        disposition: 'REPLAY_CONFIRMED',
        databaseOperationKey: 'op_replay',
        transactionHash:
          existing.transactionHash as Hex32,
        attestationUID:
          existing.attestationUID as Hex32,
        resultStatus:
          existing.resultStatus as ReportAttestationOperationResultStatus,
      }
    }
    if (existing?.state === 'IN_FLIGHT') {
      return {
        disposition: 'BLOCKED_IN_FLIGHT',
        databaseOperationKey: 'op_inflight',
        transactionHash: existing.transactionHash,
        reasonCode: null,
      }
    }
    if (existing?.state === 'RECONCILIATION') {
      return {
        disposition: 'RECONCILIATION_REQUIRED',
        databaseOperationKey: 'op_reconciliation',
        transactionHash: existing.transactionHash,
        reasonCode: 'PROCESS_INTERRUPTED',
      }
    }
    this.records.set(input.canonicalOperationKey, {
      action: input.action,
      fingerprint: input.planFingerprint,
      state: 'IN_FLIGHT',
      transactionHash: null,
      attestationUID: null,
      resultStatus: null,
    })
    return {
      disposition: 'CLAIMED',
      databaseOperationKey: 'op_claimed',
    }
  }

  async recordTransactionHash(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
  }) {
    const record = this.records.get(
      input.canonicalOperationKey,
    )
    if (!record || record.fingerprint !== input.planFingerprint) {
      throw new Error('missing claim')
    }
    record.transactionHash = input.transactionHash
  }

  async confirm(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32
    attestationUID: Hex32
    resultStatus: ReportAttestationOperationResultStatus
  }) {
    const record = this.records.get(
      input.canonicalOperationKey,
    )
    if (!record || record.fingerprint !== input.planFingerprint) {
      throw new Error('missing claim')
    }
    record.state = 'CONFIRMED'
    record.transactionHash = input.transactionHash
    record.attestationUID = input.attestationUID
    record.resultStatus = input.resultStatus
  }

  async requireReconciliation(input: {
    canonicalOperationKey: string
    planFingerprint: Hex32
    transactionHash: Hex32 | null
    reasonCode: string
  }) {
    const record = this.records.get(
      input.canonicalOperationKey,
    )
    if (!record || record.fingerprint !== input.planFingerprint) {
      throw new Error('missing claim')
    }
    record.state = 'RECONCILIATION'
    record.transactionHash = input.transactionHash
  }
}

const rawPrepared = (input: Record<string, unknown>) => ({
  version: 1,
  preparedRecordId: input.preparedRecordId,
  deploymentBindingId: hex32('deployment'),
  reportId: input.reportId,
  revision: input.revision,
  previousSubmissionUID: input.previousSubmissionUID,
  commitment: hex32(
    JSON.stringify({
      preparedRecordId: input.preparedRecordId,
      reportId: input.reportId,
      revision: input.revision,
      nonce: input.nonce,
    }),
  ),
  commitmentVersion: 1,
  evidenceSchemaDigest: hex32('evidence'),
  derivationRuleDigest: input.derivationRuleDigest,
  safeManifestBytes: SAFE_MANIFEST,
  nonce: input.nonce,
})

const contractsModuleForTargets = (
  issuerTarget = EAS_ADDRESS,
  reviewerTarget = EAS_ADDRESS,
) => ({
  createGiwaSepoliaReportRuntimeV1: (options: {
    issuerSigner: {
      sendTransaction(value: unknown): Promise<unknown>
    }
    reviewerSigner: {
      sendTransaction(value: unknown): Promise<unknown>
    }
    reviewDecisionSource: {
      readAuthenticatedDecision(value: unknown): Promise<{
        outcome: 'APPROVE' | 'REJECT'
        reasonCode: string
      }>
    }
  }) => ({
    prepare: rawPrepared,
    preflight: async () => ({
      status: 'PASS',
      chainId: 91_342,
      issuer: '0x1111111111111111111111111111111111111111',
      reviewer: '0x2222222222222222222222222222222222222222',
    }),
    submit: async (prepared: Record<string, unknown>) => {
      const operationKey = `issuer-submit:v1:${prepared.preparedRecordId}`
      try {
        const transactionHash =
          await options.issuerSigner.sendTransaction({
            operationKey,
            fingerprint: SUBMIT_PLAN,
            chainId: 91_342,
            to: issuerTarget,
            data: '0x1234',
            value: 0n,
          })
        return {
          status: 'CONFIRMED',
          operationKey,
          fingerprint: SUBMIT_PLAN,
          transactionHash,
          attestationUID: SUBMISSION_UID,
          reasonCode: null,
        }
      } catch {
        return {
          status: 'RECONCILIATION_REQUIRED',
          operationKey,
          fingerprint: SUBMIT_PLAN,
          transactionHash: null,
          attestationUID: null,
          reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
        }
      }
    },
    decide: async (
      prepared: Record<string, unknown>,
      submissionUID: Hex32,
    ) => {
      await options.reviewDecisionSource.readAuthenticatedDecision({
          preparedRecordId: prepared.preparedRecordId,
          submissionUID,
          reportId: prepared.reportId,
          revision: prepared.revision,
          commitment: prepared.commitment,
          evidenceSchemaDigest:
            prepared.evidenceSchemaDigest,
          derivationRuleDigest:
            prepared.derivationRuleDigest,
        })
      const operationKey = `reviewer-decision:v1:${submissionUID}`
      const transactionHash =
        await options.reviewerSigner.sendTransaction({
          operationKey,
          fingerprint: REVIEW_PLAN,
          chainId: 91_342,
          to: reviewerTarget,
          data: '0xabcd',
          value: 0n,
        })
      return {
        status: 'CONFIRMED',
        operationKey,
        fingerprint: REVIEW_PLAN,
        transactionHash,
        attestationUID: APPROVAL_UID,
        reasonCode: null,
      }
    },
    readReport: async (
      _reportId: Hex32,
      candidateUID: Hex32,
    ) => ({
      usable: candidateUID === APPROVAL_UID,
    }),
    verify: async () => ({
      result: 'USABLE',
      reason: 'USABLE',
    }),
  }),
})

const contractsModule = contractsModuleForTargets()

const createHarness = async (options?: {
  minimumConfirmations?: number
  confirmationFails?: boolean
  contractsModule?: unknown
}) => {
  const operationStore = new MemoryOperationStore()
  const issuerSend = vi
    .fn()
    .mockResolvedValue({ hash: SUBMIT_TX })
  const reviewerSend = vi
    .fn()
    .mockResolvedValue({ hash: REVIEW_TX })
  const waitForTransactionReceipt = options?.confirmationFails
    ? vi.fn().mockRejectedValue(new Error('not confirmed'))
    : vi.fn().mockResolvedValue({ status: 'success' })
  let projection:
    | GiwaSepoliaPreparedRecordProjection
    | undefined
  const runtime =
    await loadGiwaSepoliaReportAttestationRuntime({
      deployment: { eas: EAS_ADDRESS },
      publicClient: { waitForTransactionReceipt },
      issuerSigner: {
        getAddress: async () =>
          '0x1111111111111111111111111111111111111111',
        sendTransaction: issuerSend,
      },
      reviewerSigner: {
        getAddress: async () =>
          '0x2222222222222222222222222222222222222222',
        sendTransaction: reviewerSend,
      },
      operationStore,
      preparedRecordSource: {
        readPreparedRecord: async () => projection,
      },
      reviewDecisionSource: {
        readAuthenticatedDecision: async () => ({
          outcome: 'APPROVE',
          reasonCode: 'AUTOMATED_POLICY_PASS',
        }),
      },
      derivationRuleDigest: DERIVATION_DIGEST,
      ...(options?.minimumConfirmations === undefined
        ? {}
        : {
            minimumConfirmations:
              options.minimumConfirmations,
          }),
      nonceSource: () => NONCE,
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      contractsModule:
        options?.contractsModule ?? contractsModule,
    })
  const prepared = await runtime.prepareSyntheticEvidence({
    preparedRecordId: 'ep_test',
    reportId: REPORT_ID,
    revision: 1,
    safeArtifactBytes: SAFE_ARTIFACT,
  })
  projection = {
    preparedRecordId: prepared.preparedRecordId,
    reportId: prepared.reportId,
    revision: prepared.revision,
    previousSubmissionUID: ZERO,
    safeArtifactBytes: SAFE_ARTIFACT,
    commitment: prepared.commitment,
    safeArtifactDigest:
      prepared.safeArtifactDigest as Hex32,
    safeManifestDigest:
      prepared.safeManifestDigest as Hex32,
    derivationRuleDigest:
      prepared.derivationRuleDigest as Hex32,
    commitmentNonce:
      prepared.commitmentNonce as Hex32,
    submissionAttestationUID: SUBMISSION_UID,
  }
  return {
    runtime,
    operationStore,
    issuerSend,
    reviewerSend,
    waitForTransactionReceipt,
    setProjection: (
      value: GiwaSepoliaPreparedRecordProjection,
    ) => {
      projection = value
    },
    getProjection: () => projection as GiwaSepoliaPreparedRecordProjection,
  }
}

describe('GIWA Sepolia runtime adapter', () => {
  it('rebuilds persisted preparation and sends a canonical SUBMIT exactly once', async () => {
    const harness = await createHarness()

    const first =
      await harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      })
    const second =
      await harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      })

    expect(first).toEqual({
      status: 'CONFIRMED',
      transactionHash: SUBMIT_TX,
      attestationUID: SUBMISSION_UID,
      reasonCode: null,
    })
    expect(second).toEqual(first)
    expect(harness.issuerSend).toHaveBeenCalledTimes(1)
    expect(
      harness.operationStore.records.get(
        'issuer-submit:v1:ep_test',
      ),
    ).toMatchObject({
      action: 'SUBMIT',
      state: 'CONFIRMED',
      resultStatus: 'SUBMITTED',
    })
  })

  it('never rebroadcasts an unknown IN_FLIGHT operation', async () => {
    const harness = await createHarness()
    harness.operationStore.records.set(
      'issuer-submit:v1:ep_test',
      {
        action: 'SUBMIT',
        fingerprint: SUBMIT_PLAN,
        state: 'IN_FLIGHT',
        transactionHash: null,
        attestationUID: null,
        resultStatus: null,
      },
    )

    const result =
      await harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      })

    expect(result).toEqual({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: null,
      attestationUID: null,
      reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
    })
    expect(harness.issuerSend).not.toHaveBeenCalled()
    expect(
      harness.operationStore.records.get(
        'issuer-submit:v1:ep_test',
      )?.state,
    ).toBe('IN_FLIGHT')
  })

  it('rejects an issuer request targeting an address other than configured EAS before claiming or signing', async () => {
    const harness = await createHarness({
      contractsModule: contractsModuleForTargets(
        WRONG_TARGET,
        EAS_ADDRESS,
      ),
    })

    const result =
      await harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      })

    expect(result).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: null,
      attestationUID: null,
      reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
    })
    expect(harness.issuerSend).not.toHaveBeenCalled()
    expect(harness.operationStore.records.size).toBe(0)
  })

  it('rejects a reviewer request targeting an address other than configured EAS before claiming or signing', async () => {
    const harness = await createHarness({
      contractsModule: contractsModuleForTargets(
        EAS_ADDRESS,
        WRONG_TARGET,
      ),
    })

    await expect(
      harness.runtime.reviewerExecutor.executeReviewer({
        preparedRecordId: 'ep_test',
        submissionUID: SUBMISSION_UID,
      }),
    ).rejects.toThrow(
      'Contracts runtime send target does not match configured EAS',
    )
    expect(harness.reviewerSend).not.toHaveBeenCalled()
    expect(harness.operationStore.records.size).toBe(0)
  })

  it('binds the trusted review outcome to the Reviewer signer operation', async () => {
    const harness = await createHarness()

    const result =
      await harness.runtime.reviewerExecutor.executeReviewer({
        preparedRecordId: 'ep_test',
        submissionUID: SUBMISSION_UID,
      })

    expect(result).toEqual({
      status: 'CONFIRMED',
      transactionHash: REVIEW_TX,
      attestationUID: APPROVAL_UID,
      reasonCode: null,
    })
    expect(harness.reviewerSend).toHaveBeenCalledTimes(1)
    expect(
      harness.operationStore.records.get(
        `reviewer-decision:v1:${SUBMISSION_UID}`,
      ),
    ).toMatchObject({
      action: 'APPROVE',
      state: 'CONFIRMED',
      resultStatus: 'USABLE',
    })
  })

  it('fails before signing when persisted evidence bytes drift', async () => {
    const harness = await createHarness()
    harness.setProjection({
      ...harness.getProjection(),
      safeArtifactBytes: new TextEncoder().encode(
        '{"safe":"changed"}',
      ),
    })

    await expect(
      harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      }),
    ).rejects.toMatchObject({
      code: 'GIWA_PREPARED_RECORD_MISMATCH',
    })
    expect(harness.issuerSend).not.toHaveBeenCalled()
  })

  it('keeps a verified tx in reconciliation when configured confirmation depth is not reached', async () => {
    const harness = await createHarness({
      minimumConfirmations: 2,
      confirmationFails: true,
    })

    const result =
      await harness.runtime.issuerExecutor.executeIssuer({
        preparedRecordId: 'ep_test',
      })

    expect(result).toEqual({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: SUBMIT_TX,
      attestationUID: null,
      reasonCode: 'MINIMUM_CONFIRMATIONS_NOT_REACHED',
    })
    expect(
      harness.waitForTransactionReceipt,
    ).toHaveBeenCalledWith({
      hash: SUBMIT_TX,
      confirmations: 2,
    })
    expect(
      harness.operationStore.records.get(
        'issuer-submit:v1:ep_test',
      ),
    ).toMatchObject({
      state: 'RECONCILIATION',
      transactionHash: SUBMIT_TX,
    })
  })
})
