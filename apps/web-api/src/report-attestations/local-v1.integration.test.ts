import { describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { loadLocalReportAttestationRuntime } from './local-runtime-adapter.js'
import { MOCK_REPORT_ID } from './mock-publication-source.js'
import type {
  RedactedExecutionResult,
  ReportReviewOutcome,
} from './types.js'

const INTEGRATION_ENABLED =
  process.env.GIWA28_RUN_LOCAL_CONTRACTS_INTEGRATION === '1'
const OWNER_A = '00000000-0000-4000-8000-000000000028'
const OWNER_B = '00000000-0000-4000-8000-000000000029'
const OWNER_C = '00000000-0000-4000-8000-000000000030'
const IDENTITY_KEY = new Uint8Array(32).fill(28)

type Owner = 'A' | 'B' | 'C'
type IntegrationStatusBody = {
  reportId: string
  lifecycle: string
  submission: RedactedExecutionResult | null
  review: RedactedExecutionResult | null
  failureCode: string | null
  createdAt: string
  updatedAt: string
}

const readReviewOutcome = (): ReportReviewOutcome => {
  const value = process.env.GIWA28_REVIEW_OUTCOME
  if (
    value !== 'APPROVE' &&
    value !== 'REJECT' &&
    value !== 'MANUAL_REVIEW'
  ) {
    throw new Error(
      'GIWA28_REVIEW_OUTCOME must be APPROVE, REJECT, or MANUAL_REVIEW',
    )
  }
  return value
}

const config = loadConfig({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '3100',
  PUBLIC_ORIGIN: 'http://127.0.0.1:5174',
  RATE_LIMIT_HMAC_SECRET: 'local-v1-integration-test-secret',
})

describe.runIf(INTEGRATION_ENABLED)(
  '@backward-labs/daejang-contracts/local-v1',
  () => {
    it(
      'runs two user-scoped mock reports through real Anvil',
      { timeout: 180_000 },
      async () => {
        const reviewOutcome = readReviewOutcome()
        const runtime = await loadLocalReportAttestationRuntime({
          runtimeMode: 'development',
          reviewOutcome,
        })
        const sameRuntime = await loadLocalReportAttestationRuntime({
          runtimeMode: 'development',
          reviewOutcome,
        })
        expect(sameRuntime).toBe(runtime)

        const context = await buildApp({
          config,
          logger: false,
          reportAttestations: {
            runtime,
            reviewOutcome,
            identityKey: IDENTITY_KEY,
            localSyntheticFixture: true,
          },
        })
        const sessions = {
          A: await context.sessionService.create({
            user: { id: OWNER_A, displayName: 'integration-owner-a' },
          }),
          B: await context.sessionService.create({
            user: { id: OWNER_B, displayName: 'integration-owner-b' },
          }),
          C: await context.sessionService.create({
            user: { id: OWNER_C, displayName: 'integration-owner-c' },
          }),
        }
        const request = (
          owner: Owner,
          method: 'GET' | 'POST',
          url: string,
          token = sessions[owner].token,
        ) =>
          context.app.inject({
            method,
            url,
            headers: {
              cookie: `${config.sessionCookieName}=${token}`,
              origin: config.publicOrigin,
            },
          })
        const waitForLifecycle = async (
          owner: Owner,
          expected: readonly string[],
        ): Promise<IntegrationStatusBody> => {
          let lastLifecycle = 'UNKNOWN'
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const response = await request(
              owner,
              'GET',
              `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
            )
            expect(response.statusCode).toBe(200)
            const body = response.json() as IntegrationStatusBody
            lastLifecycle = body.lifecycle
            if (expected.includes(lastLifecycle)) return body
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          throw new Error(
            `attestation lifecycle polling timed out at ${lastLifecycle}`,
          )
        }

        try {
          for (const owner of ['A', 'B'] as const) {
            const prepared = await request(
              owner,
              'POST',
              '/api/v1/dev/reports/attestation-fixture',
            )
            expect(prepared.statusCode).toBe(201)
            expect(prepared.json()).toMatchObject({
              reportId: MOCK_REPORT_ID,
              lifecycle: 'PREPARED',
            })
          }

          const secondSessionForA = await context.sessionService.create({
            user: { id: OWNER_A, displayName: 'integration-owner-a-again' },
          })
          const repeatedA = await request(
            'A',
            'POST',
            '/api/v1/dev/reports/attestation-fixture',
            secondSessionForA.token,
          )
          expect(repeatedA.statusCode).toBe(201)
          expect(repeatedA.json()).toMatchObject({
            reportId: MOCK_REPORT_ID,
            lifecycle: 'PREPARED',
          })

          const expectedLifecycle =
            reviewOutcome === 'APPROVE'
              ? 'APPROVED'
              : reviewOutcome === 'REJECT'
                ? 'REJECTED'
                : 'MANUAL_REVIEW'

          for (const owner of ['A', 'B'] as const) {
            const submission = await request(
              owner,
              'POST',
              `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
            )
            expect(submission.statusCode).toBe(202)
            const submitted = await waitForLifecycle(owner, ['SUBMITTED'])
            expect(submitted.submission).toMatchObject({
              status: 'CONFIRMED',
              transactionHash: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
              attestationUID: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
              reasonCode: null,
            })

            const review = await request(
              owner,
              'POST',
              `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
            )
            expect(review.statusCode).toBe(202)
            const reviewed = await waitForLifecycle(owner, [
              expectedLifecycle,
            ])
            expect(reviewed.lifecycle).toBe(expectedLifecycle)
            expect(JSON.stringify(reviewed)).not.toMatch(
              /"(?:preparedRecordId|contractReportId|commitment|safeArtifactBytes|revision|nonce|gas|fee|rawTransaction)":/i,
            )

            const verification = await request(
              owner,
              'GET',
              `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
            )
            expect(verification.statusCode).toBe(200)
            expect(verification.json()).toMatchObject(
              reviewOutcome === 'APPROVE'
                ? {
                    lifecycle: 'APPROVED',
                    result: 'USABLE',
                    reasonCode: null,
                  }
                : {
                    lifecycle: expectedLifecycle,
                    result: 'UNUSABLE',
                  },
            )
          }

          const syntheticInitial = await request(
            'C',
            'GET',
            '/api/v1/report-attestations/synthetic-publication',
          )
          expect(syntheticInitial.statusCode).toBe(200)
          expect(syntheticInitial.json()).toMatchObject({
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

          const syntheticSubmission = await request(
            'C',
            'POST',
            '/api/v1/report-attestations/synthetic-publication/submission',
          )
          expect(syntheticSubmission.statusCode).toBe(200)
          const syntheticSubmitted = await waitForLifecycle('C', [
            'SUBMITTED',
          ])
          expect(syntheticSubmitted.submission).toMatchObject({
            status: 'CONFIRMED',
            transactionHash: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
            attestationUID: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
          })

          const syntheticReview = await request(
            'C',
            'POST',
            '/api/v1/report-attestations/synthetic-publication/review',
          )
          expect(syntheticReview.statusCode).toBe(200)
          await waitForLifecycle('C', [expectedLifecycle])
          const syntheticVerified = await request(
            'C',
            'GET',
            '/api/v1/report-attestations/synthetic-publication',
          )
          expect(syntheticVerified.json()).toMatchObject(
            reviewOutcome === 'APPROVE'
              ? {
                  status: { lifecycle: 'APPROVED' },
                  verification: {
                    lifecycle: 'APPROVED',
                    result: 'USABLE',
                    reasonCode: null,
                  },
                }
              : {
                  status: { lifecycle: expectedLifecycle },
                  verification: {
                    lifecycle: expectedLifecycle,
                    result: 'UNUSABLE',
                  },
                },
          )

          if (reviewOutcome === 'APPROVE') {
            await context.reportAttestationService?.mutateSafeArtifactForTest(
              OWNER_A,
              MOCK_REPORT_ID,
              (bytes) => Uint8Array.from([...bytes, 0]),
            )
            const mutated = await request(
              'A',
              'GET',
              `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
            )
            expect(mutated.json()).toMatchObject({
              lifecycle: 'APPROVED',
              result: 'UNUSABLE',
              reasonCode: 'COMMITMENT_MISMATCH',
            })
            const ownerBStillUsable = await request(
              'B',
              'GET',
              `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
            )
            expect(ownerBStillUsable.json()).toMatchObject({
              lifecycle: 'APPROVED',
              result: 'USABLE',
              reasonCode: null,
            })
          }
        } finally {
          await context.app.close()
          await context.app.close()
        }

        await expect(
          runtime.isUsable(
            `0x${'0'.repeat(64)}`,
            `0x${'0'.repeat(64)}`,
          ),
        ).rejects.toBeDefined()
      },
    )
  },
)
