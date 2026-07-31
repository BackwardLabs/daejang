import { describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import {
  GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND,
  LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
  type GiwaSepoliaReportAttestationRuntime,
  type LocalReportAttestationRuntime,
  type Hex32,
  type RedactedExecutionResult,
} from './types.js'

const OWNER_A = '00000000-0000-4000-8000-000000000028'
const OWNER_B = '00000000-0000-4000-8000-000000000029'
const SUBMISSION_UID = `0x${'2'.repeat(64)}` as Hex32
const REVIEW_UID = `0x${'3'.repeat(64)}` as Hex32
const TRANSACTION_HASH = `0x${'4'.repeat(64)}`
const COMMITMENT = `0x${'5'.repeat(64)}` as Hex32
const DIGEST = `0x${'6'.repeat(64)}` as Hex32
const NONCE = `0x${'7'.repeat(64)}` as Hex32
const IDENTITY_KEY = new Uint8Array(32).fill(28)

const enabledConfig = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  RATE_LIMIT_HMAC_SECRET:
    'synthetic-report-attestation-rate-limit-secret',
  GIWA_REPORT_ATTESTATIONS_ENABLED: 'true',
  GIWA_REPORT_RPC_URL: 'https://sepolia-rpc.giwa.io',
  GIWA_REPORT_EAS_ADDRESS:
    '0x4200000000000000000000000000000000000021',
  GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS:
    '0x4200000000000000000000000000000000000020',
  GIWA_REPORT_REGISTRY_PROXY_ADDRESS:
    '0x956B9Eef2Fd152AEa4bf3E8B2B073173D9786B04',
  GIWA_REPORT_CONSUMER_ADDRESS:
    '0xcE84783A2b81570cb0D747f7E1E8ac2E8424A79f',
  GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS:
    '0x1Ed5ccdb472d232f730E18FaE78a930df812369c',
  GIWA_REPORT_SCHEMA_UID:
    '0xcacb267ec180fbab47243bd01c7133d375ecda009ddb2070db396898fa091817',
  GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST:
    '0xd08257dbf7f22a381540cc1331ca6047a53bf0863eaa42d28d8db65bde371303',
  GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED: 'true',
  GIWA_REPORT_IDENTITY_HMAC_KEY:
    Buffer.alloc(32, 28).toString('base64'),
  GIWA_REPORT_ISSUER_ADDRESS:
    '0x170f590cCEd1850d8061d71F60951d1Cd177c932',
  GIWA_REPORT_ISSUER_KEYSTORE_PATH: '/tmp/issuer.json',
  GIWA_REPORT_ISSUER_PASSWORD_FILE: '/tmp/issuer.password',
  GIWA_REPORT_REVIEWER_ADDRESS:
    '0x1f1E6a46dfdB712B9D7f106F157c34aAaD62EFa3',
  GIWA_REPORT_REVIEWER_KEYSTORE_PATH: '/tmp/reviewer.json',
  GIWA_REPORT_REVIEWER_PASSWORD_FILE: '/tmp/reviewer.password',
})

const createRuntime = (approved = true) => {
  const preparedReportIds: Hex32[] = []
  const verifyPreparedReport = vi.fn(async () => ({
    result: approved ? 'USABLE' : 'UNUSABLE',
    reason: approved ? null : 'REVIEW_REJECTED',
  } as const))
  const executeIssuer = vi.fn(async () => ({
    status: 'CONFIRMED',
    transactionHash: TRANSACTION_HASH,
    attestationUID: SUBMISSION_UID,
    reasonCode: null,
  }))
  const executeReviewer = vi.fn(
    async (): Promise<RedactedExecutionResult> => ({
      status: 'CONFIRMED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: REVIEW_UID,
      reasonCode: null,
    }),
  )
  const reconcileReviewer = vi.fn(
    async (): Promise<RedactedExecutionResult> => ({
      status: 'CONFIRMED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: REVIEW_UID,
      reasonCode: null,
    }),
  )
  const runtime: GiwaSepoliaReportAttestationRuntime = {
    kind: GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND,
    issuerExecutor: { executeIssuer },
    reviewerExecutor: { executeReviewer },
    reviewerReconciler: { reconcileReviewer },
    prepareSyntheticEvidence: vi.fn(async (input) => {
      preparedReportIds.push(input.reportId)
      return {
        preparedRecordId: input.preparedRecordId,
        reportId: input.reportId,
        revision: input.revision,
        commitment: COMMITMENT,
        safeArtifactDigest: DIGEST,
        safeManifestDigest: DIGEST,
        derivationRuleDigest: DIGEST,
        commitmentNonce: NONCE,
      }
    }),
    isUsable: vi.fn(async () => approved),
    verifyPreparedReport,
    close: vi.fn(async () => undefined),
  }
  return {
    runtime,
    executeIssuer,
    executeReviewer,
    reconcileReviewer,
    preparedReportIds,
    verifyPreparedReport,
  }
}

const createHarness = async (
  approved = true,
  reconciliationEnabled = true,
) => {
  const fake = createRuntime(approved)
  const context = await buildApp({
    config: enabledConfig,
    logger: false,
    reportAttestationDeploymentReader: {
      read: vi.fn(async () => ({
        chainId: 91_342n,
        code: {
          eas: '0x6000',
          schemaRegistry: '0x6001',
          reportRegistryProxy: '0x6002',
          reportConsumer: '0x6003',
        },
        easSchemaRegistryAddress:
          enabledConfig.reportAttestationDeployment
            ?.schemaRegistryAddress as string,
        registry: {
          easAddress:
            enabledConfig.reportAttestationDeployment
              ?.easAddress as string,
          schemaUID:
            enabledConfig.reportAttestationDeployment
              ?.schemaUID as string,
          evidenceSchemaDigest:
            enabledConfig.reportAttestationDeployment
              ?.evidenceSchemaDigest as string,
        },
        consumerReportRegistryAddress:
          enabledConfig.reportAttestationDeployment
            ?.reportRegistryProxyAddress as string,
      })),
    },
    reportAttestations: {
      runtime: fake.runtime,
      reviewOutcome: approved ? 'APPROVE' : 'REJECT',
      identityKey: IDENTITY_KEY,
      reconciliationEnabled,
    },
  })
  const sessions = {
    A: await context.sessionService.create({
      user: { id: OWNER_A, displayName: 'owner-a' },
    }),
    B: await context.sessionService.create({
      user: { id: OWNER_B, displayName: 'owner-b' },
    }),
  }
    const request = (
      owner: 'A' | 'B',
      method: 'GET' | 'POST',
      url: string,
    ) =>
      context.app.inject({
        method,
        url,
        headers: {
        cookie: `${enabledConfig.sessionCookieName}=${sessions[owner].token}`,
        origin: enabledConfig.publicOrigin,
      },
    })
  return { context, fake, request }
}

describe('GIWA Sepolia synthetic report attestation routes', () => {
  it('exposes a GET-only initial snapshot and runs split idempotent writes', async () => {
    const harness = await createHarness()
    try {
      const initial = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(initial.statusCode).toBe(200)
      expect(initial.json()).toEqual({
        capability: {
          enabled: true,
          network: 'eip155:91342',
          mode: 'SYNTHETIC_TESTNET',
          explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
          reasonCode: null,
        },
        fixture: {
          taxYear: 2025,
          transactionCount: 12,
          completeCount: 10,
          exceptionCount: 2,
          denomination: 'KRW',
        },
        status: null,
        verification: null,
      })
      expect(harness.fake.executeIssuer).not.toHaveBeenCalled()
      expect(harness.fake.executeReviewer).not.toHaveBeenCalled()
      expect(harness.fake.reconcileReviewer).not.toHaveBeenCalled()

      const [firstSubmit, duplicateSubmit] = await Promise.all([
        harness.request(
          'A',
          'POST',
          '/api/v1/report-attestations/synthetic-publication/submission',
        ),
        harness.request(
          'A',
          'POST',
          '/api/v1/report-attestations/synthetic-publication/submission',
        ),
      ])
      expect(firstSubmit.statusCode).toBe(200)
      expect(duplicateSubmit.statusCode).toBe(200)
      await harness.context.reportAttestationService?.waitForIdle()
      expect(harness.fake.executeIssuer).toHaveBeenCalledTimes(1)
      expect(harness.fake.executeReviewer).not.toHaveBeenCalled()

      const submitted = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(submitted.json()).toMatchObject({
        status: {
          lifecycle: 'SUBMITTED',
          submission: {
            status: 'CONFIRMED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: SUBMISSION_UID,
          },
          review: null,
        },
        verification: null,
      })

      const review = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      expect(review.statusCode).toBe(200)
      await harness.context.reportAttestationService?.waitForIdle()
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)

      const approved = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(approved.json()).toMatchObject({
        status: {
          lifecycle: 'APPROVED',
          review: {
            status: 'CONFIRMED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: REVIEW_UID,
          },
        },
        verification: {
          lifecycle: 'APPROVED',
          result: 'USABLE',
          reasonCode: null,
        },
      })
      expect(JSON.stringify(approved.json())).not.toMatch(
        /reportId|preparedRecordId|contractReportId|ownerId|commitment/i,
      )

      const cachedApproved = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(cachedApproved.json()).toMatchObject({
        verification: {
          result: 'USABLE',
        },
      })
      expect(
        harness.fake.verifyPreparedReport,
      ).toHaveBeenCalledTimes(1)

      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('recovers a false-negative review receipt through the explicit read-only reconciliation endpoint', async () => {
    const harness = await createHarness()
    harness.fake.executeReviewer.mockResolvedValueOnce({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: null,
      reasonCode: 'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    })
    try {
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      await harness.context.reportAttestationService?.waitForIdle()

      const readOnlyGet = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(readOnlyGet.json()).toMatchObject({
        status: {
          lifecycle: 'RECONCILIATION_REQUIRED',
          review: {
            status: 'RECONCILIATION_REQUIRED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: null,
          },
        },
      })
      expect(harness.fake.reconcileReviewer).not.toHaveBeenCalled()

      const reconciled = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(reconciled.statusCode).toBe(200)
      expect(reconciled.json()).toMatchObject({
        status: {
          lifecycle: 'APPROVED',
          review: {
            status: 'CONFIRMED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: REVIEW_UID,
          },
        },
        verification: {
          lifecycle: 'APPROVED',
          result: 'USABLE',
        },
      })
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)

      const repeated = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(repeated.json()).toMatchObject({
        status: { lifecycle: 'APPROVED' },
      })
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)

      const otherOwner = await harness.request(
        'B',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(otherOwner.statusCode).toBe(200)
      expect(otherOwner.json().status).toBeNull()
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('keeps reconciliation unavailable until the DB54 transition contract is active', async () => {
    const harness = await createHarness(true, false)
    try {
      const response = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )

      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        error: {
          code: 'REPORT_ATTESTATION_RECONCILIATION_NOT_READY',
        },
      })
      expect(harness.fake.reconcileReviewer).not.toHaveBeenCalled()
    } finally {
      await harness.context.app.close()
    }
  })

  it('keeps an unresolved review receipt pending and never re-executes the reviewer write', async () => {
    const harness = await createHarness()
    harness.fake.executeReviewer.mockResolvedValueOnce({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: null,
      reasonCode: 'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    })
    harness.fake.reconcileReviewer.mockResolvedValue({
      status: 'PENDING',
      transactionHash: TRANSACTION_HASH,
      attestationUID: null,
      reasonCode: 'RECEIPT_PENDING',
    })
    try {
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      await harness.context.reportAttestationService?.waitForIdle()

      const pending = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(pending.json()).toMatchObject({
        status: {
          lifecycle: 'PENDING',
          review: {
            status: 'PENDING',
            transactionHash: TRANSACTION_HASH,
            attestationUID: null,
          },
        },
        verification: null,
      })
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('recovers a confirmed REJECT review as REJECTED and UNUSABLE', async () => {
    const harness = await createHarness(false)
    harness.fake.executeReviewer.mockResolvedValueOnce({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: null,
      reasonCode: 'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    })
    try {
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      await harness.context.reportAttestationService?.waitForIdle()

      const reconciled = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(reconciled.json()).toMatchObject({
        status: {
          lifecycle: 'REJECTED',
          review: {
            status: 'CONFIRMED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: REVIEW_UID,
          },
        },
        verification: {
          lifecycle: 'REJECTED',
          result: 'UNUSABLE',
          reasonCode: 'REVIEW_REJECTED',
        },
      })
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('keeps the report fail-closed when reconciliation returns a different tx hash', async () => {
    const harness = await createHarness()
    const differentTransactionHash =
      `0x${'8'.repeat(64)}`
    harness.fake.executeReviewer.mockResolvedValueOnce({
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: TRANSACTION_HASH,
      attestationUID: null,
      reasonCode: 'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    })
    harness.fake.reconcileReviewer.mockResolvedValueOnce({
      status: 'CONFIRMED',
      transactionHash: differentTransactionHash,
      attestationUID: REVIEW_UID,
      reasonCode: null,
    })
    try {
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      await harness.context.reportAttestationService?.waitForIdle()

      const reconciled = await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/reconcile',
      )
      expect(reconciled.json()).toMatchObject({
        status: {
          lifecycle: 'RECONCILIATION_REQUIRED',
          review: {
            status: 'RECONCILIATION_REQUIRED',
            transactionHash: TRANSACTION_HASH,
            attestationUID: null,
            reasonCode: 'RUNTIME_RESULT_BINDING_MISMATCH',
          },
        },
        verification: null,
      })
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(harness.fake.reconcileReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('derives a different hidden contract report ID per authenticated user', async () => {
    const harness = await createHarness()
    try {
      for (const owner of ['A', 'B'] as const) {
        const response = await harness.request(
          owner,
          'POST',
          '/api/v1/report-attestations/synthetic-publication/submission',
        )
        expect(response.statusCode).toBe(200)
      }
      await harness.context.reportAttestationService?.waitForIdle()
      expect(harness.fake.preparedReportIds).toHaveLength(2)
      expect(harness.fake.preparedReportIds[0]).not.toBe(
        harness.fake.preparedReportIds[1],
      )
      expect(JSON.stringify(harness.fake.preparedReportIds)).not.toContain(
        OWNER_A,
      )
      expect(JSON.stringify(harness.fake.preparedReportIds)).not.toContain(
        OWNER_B,
      )
    } finally {
      await harness.context.app.close()
    }
  })

  it('reports a server-decided rejection as UNUSABLE', async () => {
    const harness = await createHarness(false)
    try {
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request(
        'A',
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      await harness.context.reportAttestationService?.waitForIdle()
      const rejected = await harness.request(
        'A',
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(rejected.json()).toMatchObject({
        status: { lifecycle: 'REJECTED' },
        verification: {
          lifecycle: 'REJECTED',
          result: 'UNUSABLE',
          reasonCode: 'REVIEW_REJECTED',
        },
      })
    } finally {
      await harness.context.app.close()
    }
  })

  it('runs the same synthetic API against local Anvil only on a loopback development server', async () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3100',
      PUBLIC_ORIGIN: 'http://127.0.0.1:5174',
      RATE_LIMIT_HMAC_SECRET: 'local-anvil-synthetic-route-secret',
    })
    const fake = createRuntime()
    const runtime: LocalReportAttestationRuntime = {
      ...fake.runtime,
      kind: LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
    }
    const context = await buildApp({
      config,
      logger: false,
      reportAttestations: {
        runtime,
        reviewOutcome: 'APPROVE',
        identityKey: IDENTITY_KEY,
        localSyntheticFixture: true,
      },
    })
    const session = await context.sessionService.create({
      user: { id: OWNER_A, displayName: 'owner-a' },
    })
    const headers = {
      cookie: `${config.sessionCookieName}=${session.token}`,
      origin: config.publicOrigin,
    }
    const request = (method: 'GET' | 'POST', path: string) =>
      context.app.inject({
        method,
        url: path,
        headers,
      })

    try {
      const initial = await request(
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(initial.statusCode).toBe(200)
      expect(initial.json()).toMatchObject({
        capability: {
          enabled: true,
          network: 'eip155:31337',
          mode: 'LOCAL_ANVIL',
          explorerBaseUrl: null,
          reasonCode: null,
        },
        status: null,
        verification: null,
      })

      const submission = await request(
        'POST',
        '/api/v1/report-attestations/synthetic-publication/submission',
      )
      expect(submission.statusCode).toBe(200)
      await context.reportAttestationService?.waitForIdle()

      const submitted = await request(
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(submitted.json()).toMatchObject({
        status: {
          lifecycle: 'SUBMITTED',
          submission: {
            status: 'CONFIRMED',
          },
        },
      })

      const review = await request(
        'POST',
        '/api/v1/report-attestations/synthetic-publication/review',
      )
      expect(review.statusCode).toBe(200)
      await context.reportAttestationService?.waitForIdle()

      const verified = await request(
        'GET',
        '/api/v1/report-attestations/synthetic-publication',
      )
      expect(verified.json()).toMatchObject({
        status: { lifecycle: 'APPROVED' },
        verification: {
          lifecycle: 'APPROVED',
          result: 'USABLE',
          reasonCode: null,
        },
      })
    } finally {
      await context.app.close()
    }
  })

  it('rejects the local synthetic fixture outside loopback development', async () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: '3100',
      PUBLIC_ORIGIN: 'http://127.0.0.1:5174',
      RATE_LIMIT_HMAC_SECRET: 'non-loopback-local-fixture-secret',
    })
    const fake = createRuntime()
    const runtime: LocalReportAttestationRuntime = {
      ...fake.runtime,
      kind: LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
    }

    await expect(
      buildApp({
        config,
        logger: false,
        reportAttestations: {
          runtime,
          reviewOutcome: 'APPROVE',
          identityKey: IDENTITY_KEY,
          localSyntheticFixture: true,
        },
      }),
    ).rejects.toThrow(
      'The local synthetic report fixture requires a loopback development server and the local Anvil runtime',
    )
  })

  it('fails closed when the writer capability is not configured', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:5173',
      RATE_LIMIT_HMAC_SECRET: 'disabled-writer-test-secret',
    })
    const context = await buildApp({ config, logger: false })
    const session = await context.sessionService.create({
      user: { id: OWNER_A, displayName: 'owner-a' },
    })
    const headers = {
      cookie: `${config.sessionCookieName}=${session.token}`,
      origin: config.publicOrigin,
    }
    try {
      const snapshot = await context.app.inject({
        method: 'GET',
        url: '/api/v1/report-attestations/synthetic-publication',
        headers,
      })
      expect(snapshot.statusCode).toBe(200)
      expect(snapshot.json()).toMatchObject({
        capability: {
          enabled: false,
          reasonCode: 'DEPLOYMENT_NOT_CONFIGURED',
        },
      })
      const reconciliation = await context.app.inject({
        method: 'POST',
        url:
          '/api/v1/report-attestations/' +
          'synthetic-publication/reconcile',
        headers,
      })
      expect(reconciliation.statusCode).toBe(200)
      expect(reconciliation.json()).toMatchObject({
        capability: {
          enabled: false,
          reasonCode: 'DEPLOYMENT_NOT_CONFIGURED',
        },
        status: null,
        verification: null,
      })
      const write = await context.app.inject({
        method: 'POST',
        url:
          '/api/v1/report-attestations/' +
          'synthetic-publication/submission',
        payload: {},
        headers,
      })
      expect(write.statusCode).toBe(503)
      expect(write.json()).toMatchObject({
        error: {
          code: 'REPORT_ATTESTATION_WRITER_UNAVAILABLE',
        },
      })
    } finally {
      await context.app.close()
    }
  })
})
