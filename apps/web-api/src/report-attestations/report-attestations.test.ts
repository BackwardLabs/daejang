import { describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import {
  loadLocalReportAttestationRuntime,
  LocalContractsRuntimeError,
} from './local-runtime-adapter.js'
import { MemoryReportAttestationStore } from './memory-store.js'
import {
  getMockPublicationCanonicalJson,
  getMockReportPublication,
  MOCK_REPORT_ID,
} from './mock-publication-source.js'
import type {
  ReportAttestationPublicationSource,
} from './publication-source.js'
import {
  ReportAttestationPreparationError,
  ReportAttestationService,
} from './service.js'
import {
  LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
  type Hex32,
  type LocalReportAttestationRuntime,
  type PreparedSyntheticEvidence,
  type RedactedExecutionResult,
  type ReportReviewOutcome,
} from './types.js'

const OWNER_A = '00000000-0000-4000-8000-000000000028'
const OWNER_B = '00000000-0000-4000-8000-000000000029'
const COMMITMENT = `0x${'1'.repeat(64)}` as Hex32
const SUBMISSION_UID = `0x${'2'.repeat(64)}` as Hex32
const REVIEW_UID = `0x${'3'.repeat(64)}` as Hex32
const TRANSACTION_HASH = `0x${'4'.repeat(64)}`

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  RATE_LIMIT_HMAC_SECRET: 'report-attestation-test-secret',
})
const IDENTITY_KEY = new Uint8Array(32).fill(28)

const confirmed = (attestationUID: Hex32): RedactedExecutionResult => ({
  status: 'CONFIRMED',
  transactionHash: TRANSACTION_HASH,
  attestationUID,
  reasonCode: null,
})

const createFakeRuntime = (options?: {
  issuerResults?: RedactedExecutionResult[]
  reviewerResult?: RedactedExecutionResult
  runtimeApproved?: boolean
  prepareOverride?: (
    input: Parameters<
      LocalReportAttestationRuntime['prepareSyntheticEvidence']
    >[0],
  ) => unknown
  verifyThrows?: boolean
}) => {
  let originalArtifact = new Uint8Array()
  const issuerResults = options?.issuerResults ?? [confirmed(SUBMISSION_UID)]
  const prepareSyntheticEvidence = vi.fn(
    async (
      input: Parameters<
        LocalReportAttestationRuntime['prepareSyntheticEvidence']
      >[0],
    ) => {
      originalArtifact = input.safeArtifactBytes.slice()
      const override = options?.prepareOverride?.(input)
      if (override) {
        return override as Awaited<
          ReturnType<
            LocalReportAttestationRuntime['prepareSyntheticEvidence']
          >
        >
      }
      return {
        preparedRecordId: input.preparedRecordId,
        reportId: input.reportId,
        revision: input.revision,
        commitment: COMMITMENT,
      }
    },
  )
  const executeIssuer = vi.fn(async () => {
    const next = issuerResults.shift()
    return next ?? confirmed(SUBMISSION_UID)
  })
  const executeReviewer = vi.fn(
    async () => options?.reviewerResult ?? confirmed(REVIEW_UID),
  )
  const isUsable = vi.fn(async () => options?.runtimeApproved ?? true)
  const verifyPreparedReport = vi.fn(
    async (
      input: Parameters<
        LocalReportAttestationRuntime['verifyPreparedReport']
      >[0],
    ) => {
      if (options?.verifyThrows) {
        throw new Error('private runtime verification detail')
      }
      const matches = Buffer.from(input.safeArtifactBytes).equals(
        Buffer.from(originalArtifact),
      )
      return matches
        ? ({ result: 'USABLE', reason: null } as const)
        : ({ result: 'UNUSABLE', reason: 'COMMITMENT_MISMATCH' } as const)
    },
  )
  const close = vi.fn(async () => undefined)
  const runtime: LocalReportAttestationRuntime = {
    kind: LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
    issuerExecutor: { executeIssuer },
    reviewerExecutor: { executeReviewer },
    prepareSyntheticEvidence,
    isUsable,
    verifyPreparedReport,
    close,
  }
  return {
    runtime,
    prepareSyntheticEvidence,
    executeIssuer,
    executeReviewer,
    isUsable,
    verifyPreparedReport,
    close,
  }
}

const createHarness = async (
  reviewOutcome: ReportReviewOutcome = 'APPROVE',
  fake = createFakeRuntime(),
  publicationSource?: ReportAttestationPublicationSource,
) => {
  const context = await buildApp({
    config,
    logger: false,
    reportAttestations: {
      runtime: fake.runtime,
      reviewOutcome,
      identityKey: IDENTITY_KEY,
      ...(publicationSource ? { publicationSource } : {}),
    },
  })
  const sessionA = await context.sessionService.create({
    user: { id: OWNER_A, displayName: 'owner-a' },
  })
  const sessionB = await context.sessionService.create({
    user: { id: OWNER_B, displayName: 'owner-b' },
  })
  const request = (
    owner: 'A' | 'B',
    input: {
      method: 'GET' | 'POST'
      url: string
      payload?: Record<string, unknown>
    },
  ) =>
    context.app.inject({
      ...input,
      headers: {
        cookie: `${config.sessionCookieName}=${
          owner === 'A' ? sessionA.token : sessionB.token
        }`,
        origin: config.publicOrigin,
      },
    })
  return { context, fake, request }
}

describe('local report attestation fixture', () => {
  it('prepares an injected report publication without changing the attestation lifecycle', async () => {
    const reportId = 'report-engine-result-2027-v2'
    const nextReportId = 'report-engine-result-2027-v3'
    const safeArtifactBytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 'giwa.report.publication.v1',
        reportId,
        pointerVersion: 2,
      }),
    )
    const publicationSource: ReportAttestationPublicationSource = {
      getPublication: vi.fn(async (ownerId, requestedReportId) => {
        if (
          ownerId !== OWNER_A ||
          (requestedReportId !== reportId &&
            requestedReportId !== nextReportId)
        ) {
          return undefined
        }
        return {
          reportId: requestedReportId,
          revision: 1,
          previousSubmissionUID:
            `0x${'0'.repeat(64)}` as Hex32,
          safeArtifactBytes,
        }
      }),
    }
    const fake = createFakeRuntime()
    const harness = await createHarness(
      'APPROVE',
      fake,
      publicationSource,
    )
    try {
      const prepared = await harness.request('A', {
        method: 'POST',
        url:
          `/api/v1/reports/${encodeURIComponent(reportId)}` +
          '/attestation-preparation',
      })
      expect(prepared.statusCode).toBe(201)
      expect(prepared.json()).toMatchObject({
        reportId,
        lifecycle: 'PREPARED',
      })
      expect(fake.prepareSyntheticEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 1,
          previousSubmissionUID:
            `0x${'0'.repeat(64)}`,
          safeArtifactBytes,
        }),
      )

      const nextPrepared = await harness.request('A', {
        method: 'POST',
        url:
          `/api/v1/reports/${encodeURIComponent(nextReportId)}` +
          '/attestation-preparation',
      })
      expect(nextPrepared.statusCode).toBe(201)
      const firstContractReportId =
        fake.prepareSyntheticEvidence.mock.calls[0]?.[0].reportId
      const secondContractReportId =
        fake.prepareSyntheticEvidence.mock.calls[1]?.[0].reportId
      expect(firstContractReportId).not.toBe(secondContractReportId)

      const otherOwner = await harness.request('B', {
        method: 'POST',
        url:
          `/api/v1/reports/${encodeURIComponent(reportId)}` +
          '/attestation-preparation',
      })
      expect(otherOwner.statusCode).toBe(404)
    } finally {
      await harness.context.app.close()
    }
  })

  it('does not submit a prepared report after it stops being the current publication', async () => {
    const reportId = 'report-engine-stale-after-prepare'
    let isCurrent = true
    const publication = {
      reportId,
      sourceVersion: 'report-engine-publication-v2',
      revision: 1,
      previousSubmissionUID: `0x${'0'.repeat(64)}` as Hex32,
      safeArtifactBytes: new TextEncoder().encode(
        JSON.stringify({ reportId, pointerVersion: 1 }),
      ),
    }
    const publicationSource: ReportAttestationPublicationSource = {
      getPublication: vi.fn(async (ownerId, requestedReportId) =>
        ownerId === OWNER_A && requestedReportId === reportId && isCurrent
          ? publication
          : undefined),
    }
    const fake = createFakeRuntime()
    const harness = await createHarness('APPROVE', fake, publicationSource)
    try {
      const prepared = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${encodeURIComponent(reportId)}/attestation-preparation`,
      })
      expect(prepared.statusCode).toBe(201)

      isCurrent = false
      const staleSubmission = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${encodeURIComponent(reportId)}/attestations`,
      })
      expect(staleSubmission.statusCode).toBe(404)
      expect(fake.executeIssuer).not.toHaveBeenCalled()
      expect(await harness.context.reportAttestationService?.getStatus(
        OWNER_A,
        reportId,
      )).toMatchObject({ lifecycle: 'PREPARED' })

      isCurrent = true
      publication.safeArtifactBytes = new TextEncoder().encode(
        JSON.stringify({ reportId, pointerVersion: 2 }),
      )
      const changedSubmission = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${encodeURIComponent(reportId)}/attestations`,
      })
      expect(changedSubmission.statusCode).toBe(409)
      expect(changedSubmission.json()).toMatchObject({
        error: { code: 'REPORT_ATTESTATION_PUBLICATION_CHANGED' },
      })
      expect(fake.executeIssuer).not.toHaveBeenCalled()
    } finally {
      await harness.context.app.close()
    }
  })

  it('keeps one contract report ID while creating a distinct prepared record for the next revision', async () => {
    const reportId = 'report-engine-result-2027'
    let revision = 1
    const publicationSource: ReportAttestationPublicationSource = {
      getPublication: vi.fn(
        async (ownerId, requestedReportId, requestedRevision) => {
          if (
            ownerId !== OWNER_A ||
            requestedReportId !== reportId ||
            (requestedRevision !== undefined &&
              requestedRevision !== revision)
          ) {
            return undefined
          }
          return {
            reportId,
            sourceVersion: 'report-engine-publication-v1',
            revision,
            previousSubmissionUID:
              revision === 1
                ? (`0x${'0'.repeat(64)}` as Hex32)
                : SUBMISSION_UID,
            safeArtifactBytes: new TextEncoder().encode(
              JSON.stringify({ reportId, revision }),
            ),
          }
        },
      ),
    }
    const fake = createFakeRuntime()
    const harness = await createHarness(
      'APPROVE',
      fake,
      publicationSource,
    )
    try {
      const first = await harness.request('A', {
        method: 'POST',
        url:
          `/api/v1/reports/${encodeURIComponent(reportId)}` +
          '/attestation-preparation',
      })
      expect(first.statusCode).toBe(201)
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${encodeURIComponent(reportId)}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      revision = 2
      const second = await harness.request('A', {
        method: 'POST',
        url:
          `/api/v1/reports/${encodeURIComponent(reportId)}` +
          '/attestation-preparation',
      })
      expect(second.statusCode).toBe(201)

      const firstInput =
        fake.prepareSyntheticEvidence.mock.calls[0]?.[0]
      const secondInput =
        fake.prepareSyntheticEvidence.mock.calls[1]?.[0]
      expect(firstInput?.reportId).toBe(secondInput?.reportId)
      expect(firstInput?.preparedRecordId).not.toBe(
        secondInput?.preparedRecordId,
      )
      expect(secondInput).toMatchObject({
        revision: 2,
        previousSubmissionUID: SUBMISSION_UID,
      })
    } finally {
      await harness.context.app.close()
    }
  })

  it('rejects a different contract report ID for a later revision of the same logical report', async () => {
    const reportId = 'report-engine-contract-binding'
    const store = new MemoryReportAttestationStore()
    const fake = createFakeRuntime()
    const service = new ReportAttestationService({
      runtime: fake.runtime,
      reviewOutcome: 'APPROVE',
      store,
      identityKey: IDENTITY_KEY,
    })
    try {
      await service.preparePublication(OWNER_A, {
        reportId,
        revision: 1,
        previousSubmissionUID: `0x${'0'.repeat(64)}`,
        safeArtifactBytes: new TextEncoder().encode('revision-1'),
      })
      const first = await store.get(OWNER_A, reportId, 1)
      if (!first) throw new Error('expected revision 1')

      const claim = await store.create({
        ...first,
        preparedRecordId: `ep_${'9'.repeat(64)}`,
        contractReportId: `0x${'a'.repeat(64)}`,
        revision: 2,
        previousSubmissionUID: SUBMISSION_UID,
        createdAt: new Date(first.createdAt.getTime() + 1),
        updatedAt: new Date(first.updatedAt.getTime() + 1),
      })

      expect(claim).toEqual({ result: 'IDENTITY_CLAIMED' })
      expect(await store.get(OWNER_A, reportId)).toMatchObject({
        revision: 1,
        contractReportId: first.contractReportId,
      })
    } finally {
      await service.close()
    }
  })

  it('fails closed when an identity-key rotation changes the contract report ID for a later revision', async () => {
    const reportId = 'report-engine-key-rotation'
    const store = new MemoryReportAttestationStore()
    const firstFake = createFakeRuntime()
    const firstService = new ReportAttestationService({
      runtime: firstFake.runtime,
      reviewOutcome: 'APPROVE',
      store,
      identityKey: IDENTITY_KEY,
    })
    await firstService.preparePublication(OWNER_A, {
      reportId,
      revision: 1,
      previousSubmissionUID: `0x${'0'.repeat(64)}`,
      safeArtifactBytes: new TextEncoder().encode('revision-1'),
    })
    await firstService.queueSubmission(OWNER_A, reportId)
    await firstService.waitForIdle()
    await firstService.close()

    const rotatedFake = createFakeRuntime()
    const rotatedService = new ReportAttestationService({
      runtime: rotatedFake.runtime,
      reviewOutcome: 'APPROVE',
      store,
      identityKey: new Uint8Array(32).fill(29),
    })
    try {
      await expect(
        rotatedService.preparePublication(OWNER_A, {
          reportId,
          revision: 2,
          previousSubmissionUID: SUBMISSION_UID,
          safeArtifactBytes: new TextEncoder().encode('revision-2'),
        }),
      ).rejects.toBeInstanceOf(ReportAttestationPreparationError)
      expect(rotatedFake.prepareSyntheticEvidence).not.toHaveBeenCalled()
      expect(await store.get(OWNER_A, reportId)).toMatchObject({
        revision: 1,
        lifecycle: 'SUBMITTED',
      })
    } finally {
      await rotatedService.close()
    }
  })

  it('applies a delayed issuer result only to the queued revision', async () => {
    const reportId = 'report-engine-delayed-issuer'
    const store = new MemoryReportAttestationStore()
    const fake = createFakeRuntime()
    let resolveIssuer:
      | ((value: RedactedExecutionResult) => void)
      | undefined
    const pendingIssuer = new Promise<RedactedExecutionResult>((resolve) => {
      resolveIssuer = resolve
    })
    fake.executeIssuer.mockImplementation(async () => pendingIssuer)
    const service = new ReportAttestationService({
      runtime: fake.runtime,
      reviewOutcome: 'APPROVE',
      store,
      identityKey: IDENTITY_KEY,
    })
    try {
      await service.preparePublication(OWNER_A, {
        reportId,
        revision: 1,
        previousSubmissionUID: `0x${'0'.repeat(64)}`,
        safeArtifactBytes: new TextEncoder().encode('revision-1'),
      })
      await service.queueSubmission(OWNER_A, reportId)
      await vi.waitFor(() =>
        expect(fake.executeIssuer).toHaveBeenCalledTimes(1),
      )
      const first = await store.get(OWNER_A, reportId, 1)
      if (!first) throw new Error('expected revision 1')

      expect(
        await store.create({
          ...first,
          preparedRecordId: `ep_${'9'.repeat(64)}`,
          revision: 2,
          previousSubmissionUID: SUBMISSION_UID,
          lifecycle: 'PREPARED',
          submission: undefined,
          review: undefined,
          failureCode: undefined,
          createdAt: new Date(first.createdAt.getTime() + 1),
          updatedAt: new Date(first.updatedAt.getTime() + 1),
        }),
      ).toMatchObject({ result: 'CREATED' })

      resolveIssuer?.(confirmed(SUBMISSION_UID))
      await service.waitForIdle()

      expect(await store.get(OWNER_A, reportId, 1)).toMatchObject({
        revision: 1,
        lifecycle: 'SUBMITTED',
        submission: { attestationUID: SUBMISSION_UID },
      })
      expect(await store.get(OWNER_A, reportId, 2)).toMatchObject({
        revision: 2,
        lifecycle: 'PREPARED',
        submission: undefined,
      })
    } finally {
      resolveIssuer?.(confirmed(SUBMISSION_UID))
      await service.close()
    }
  })

  it('applies a delayed reviewer result only to the queued revision', async () => {
    const reportId = 'report-engine-delayed-reviewer'
    const store = new MemoryReportAttestationStore()
    const fake = createFakeRuntime()
    let resolveReviewer:
      | ((value: RedactedExecutionResult) => void)
      | undefined
    const pendingReviewer = new Promise<RedactedExecutionResult>((resolve) => {
      resolveReviewer = resolve
    })
    fake.executeReviewer.mockImplementation(async () => pendingReviewer)
    const service = new ReportAttestationService({
      runtime: fake.runtime,
      reviewOutcome: 'APPROVE',
      store,
      identityKey: IDENTITY_KEY,
    })
    try {
      await service.preparePublication(OWNER_A, {
        reportId,
        revision: 1,
        previousSubmissionUID: `0x${'0'.repeat(64)}`,
        safeArtifactBytes: new TextEncoder().encode('revision-1'),
      })
      await service.queueSubmission(OWNER_A, reportId)
      await service.waitForIdle()
      await service.queueReview(OWNER_A, reportId)
      await vi.waitFor(() =>
        expect(fake.executeReviewer).toHaveBeenCalledTimes(1),
      )

      await service.preparePublication(OWNER_A, {
        reportId,
        revision: 2,
        previousSubmissionUID: SUBMISSION_UID,
        safeArtifactBytes: new TextEncoder().encode('revision-2'),
      })
      resolveReviewer?.(confirmed(REVIEW_UID))
      await service.waitForIdle()

      expect(await store.get(OWNER_A, reportId, 1)).toMatchObject({
        revision: 1,
        lifecycle: 'APPROVED',
        review: { attestationUID: REVIEW_UID },
      })
      expect(await store.get(OWNER_A, reportId, 2)).toMatchObject({
        revision: 2,
        lifecycle: 'PREPARED',
        review: undefined,
      })
    } finally {
      resolveReviewer?.(confirmed(REVIEW_UID))
      await service.close()
    }
  })

  it('uses deterministic canonical JSON containing only the safe allowlist', () => {
    const first = getMockReportPublication()
    const second = getMockReportPublication()
    const parsed = JSON.parse(
      new TextDecoder().decode(first.safeArtifactBytes),
    ) as Record<string, unknown>

    expect(new TextDecoder().decode(first.safeArtifactBytes)).toBe(
      getMockPublicationCanonicalJson(),
    )
    expect(first.safeArtifactBytes).toEqual(second.safeArtifactBytes)
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'taxYear',
      'transactionCount',
      'completeCount',
      'exceptionCount',
      'denomination',
      'resultClass',
      'derivationRuleVersion',
      'evidenceSchemaVersion',
    ])
    expect(JSON.stringify(parsed)).not.toMatch(
      /user|owner|document|address|amount|hash|nonce|gas|fee|transactionHash/i,
    )

    first.safeArtifactBytes[0] = 0
    expect(second.safeArtifactBytes[0]).not.toBe(0)
  })

  it('runs the approve lifecycle, redacts private inputs, and is idempotent', async () => {
    const harness = await createHarness()
    try {
      const prepared = await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(prepared.statusCode).toBe(201)
      expect(prepared.json()).toMatchObject({
        reportId: MOCK_REPORT_ID,
        lifecycle: 'PREPARED',
        submission: null,
        review: null,
      })
      expect(JSON.stringify(prepared.json())).not.toMatch(
        /preparedRecordId|contractReportId|commitment|safeArtifact|revision/i,
      )

      const rejectedInput = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        payload: {
          outcome: 'APPROVE',
          artifact: 'unsafe',
          preparedRecordId: 'caller-owned',
          attestationUID: SUBMISSION_UID,
          revision: 99,
          nonce: 1,
          gas: 1,
          fee: 1,
          rawTransaction: '0x01',
        },
      })
      expect(rejectedInput.statusCode).toBe(400)
      expect(harness.fake.executeIssuer).not.toHaveBeenCalled()

      const queued = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      expect(queued.statusCode).toBe(202)
      expect(queued.json()).toMatchObject({
        lifecycle: 'SUBMISSION_QUEUED',
      })
      await harness.context.reportAttestationService?.waitForIdle()

      const submitted = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(submitted.json()).toMatchObject({
        lifecycle: 'SUBMITTED',
        submission: {
          status: 'CONFIRMED',
          transactionHash: TRANSACTION_HASH,
          attestationUID: SUBMISSION_UID,
          reasonCode: null,
        },
      })
      const repeatedSubmit = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      expect(repeatedSubmit.statusCode).toBe(202)
      expect(repeatedSubmit.json()).toMatchObject({ lifecycle: 'SUBMITTED' })
      expect(harness.fake.executeIssuer).toHaveBeenCalledTimes(1)

      const rejectedReviewInput = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
        payload: { outcome: 'REJECT' },
      })
      expect(rejectedReviewInput.statusCode).toBe(400)
      expect(harness.fake.executeReviewer).not.toHaveBeenCalled()

      const review = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      expect(review.statusCode).toBe(202)
      await harness.context.reportAttestationService?.waitForIdle()

      const approved = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(approved.json()).toMatchObject({
        lifecycle: 'APPROVED',
        review: {
          status: 'CONFIRMED',
          attestationUID: REVIEW_UID,
        },
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)

      const verified = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
      })
      expect(verified.json()).toEqual({
        reportId: MOCK_REPORT_ID,
        lifecycle: 'APPROVED',
        result: 'USABLE',
        reasonCode: null,
      })

      await harness.context.reportAttestationService?.mutateSafeArtifactForTest(
        OWNER_A,
        MOCK_REPORT_ID,
        (bytes) => Uint8Array.from([...bytes, 0]),
      )
      const mutated = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
      })
      expect(mutated.json()).toMatchObject({
        result: 'UNUSABLE',
        reasonCode: 'COMMITMENT_MISMATCH',
      })
    } finally {
      await harness.context.app.close()
    }
    expect(harness.fake.close).toHaveBeenCalledTimes(1)
    await harness.context.app.close()
    expect(harness.fake.close).toHaveBeenCalledTimes(1)
  })

  it('automatically runs the trusted review after a product submission', async () => {
    const harness = await createHarness()
    try {
      const prepared = await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(prepared.statusCode).toBe(201)

      await expect(
        harness.context.reportAttestationService?.queueSubmissionAndReview(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).resolves.toMatchObject({ lifecycle: 'SUBMISSION_QUEUED' })
      await harness.context.reportAttestationService?.waitForIdle()

      await expect(
        harness.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).resolves.toMatchObject({ lifecycle: 'APPROVED' })
      expect(harness.fake.executeIssuer).toHaveBeenCalledTimes(1)
      expect(harness.fake.executeReviewer).toHaveBeenCalledTimes(1)
    } finally {
      await harness.context.app.close()
    }
  })

  it('derives isolated identities per user while keeping the mock artifact identical', async () => {
    const harness = await createHarness()
    try {
      const beforeOwnerB = await harness.request('B', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(beforeOwnerB.statusCode).toBe(404)

      const ownerA = await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(ownerA.statusCode).toBe(201)

      const ownerB = await harness.request('B', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(ownerB.statusCode).toBe(201)
      expect(ownerA.json()).toMatchObject({
        reportId: MOCK_REPORT_ID,
        lifecycle: 'PREPARED',
      })
      expect(ownerB.json()).toMatchObject({
        reportId: MOCK_REPORT_ID,
        lifecycle: 'PREPARED',
      })

      expect(harness.fake.prepareSyntheticEvidence).toHaveBeenCalledTimes(2)
      const ownerAInput =
        harness.fake.prepareSyntheticEvidence.mock.calls[0]?.[0]
      const ownerBInput =
        harness.fake.prepareSyntheticEvidence.mock.calls[1]?.[0]
      expect(ownerAInput).toBeDefined()
      expect(ownerBInput).toBeDefined()
      expect(ownerAInput?.preparedRecordId).toMatch(/^ep_[0-9a-f]{64}$/)
      expect(ownerBInput?.preparedRecordId).toMatch(/^ep_[0-9a-f]{64}$/)
      expect(ownerAInput?.reportId).toMatch(/^0x[0-9a-f]{64}$/)
      expect(ownerBInput?.reportId).toMatch(/^0x[0-9a-f]{64}$/)
      expect(ownerAInput?.preparedRecordId).not.toBe(
        ownerBInput?.preparedRecordId,
      )
      expect(ownerAInput?.reportId).not.toBe(ownerBInput?.reportId)
      expect(ownerAInput?.safeArtifactBytes).toEqual(
        ownerBInput?.safeArtifactBytes,
      )
      expect(JSON.stringify([ownerAInput, ownerBInput])).not.toContain(OWNER_A)
      expect(JSON.stringify([ownerAInput, ownerBInput])).not.toContain(OWNER_B)
      expect(JSON.stringify([ownerA.json(), ownerB.json()])).not.toMatch(
        /preparedRecordId|contractReportId|commitment|safeArtifact|revision/i,
      )

      const secondSessionForA = await harness.context.sessionService.create({
        user: { id: OWNER_A, displayName: 'owner-a-new-session' },
      })
      const sameUserAgain = await harness.context.app.inject({
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
        headers: {
          cookie: `${config.sessionCookieName}=${secondSessionForA.token}`,
          origin: config.publicOrigin,
        },
      })
      expect(sameUserAgain.statusCode).toBe(201)
      expect(sameUserAgain.json()).toEqual(ownerA.json())
      expect(harness.fake.prepareSyntheticEvidence).toHaveBeenCalledTimes(2)

      for (const owner of ['A', 'B'] as const) {
        await harness.request(owner, {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        await harness.request(owner, {
          method: 'POST',
          url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        const verification = await harness.request(owner, {
          method: 'GET',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
        })
        expect(verification.json()).toMatchObject({
          lifecycle: 'APPROVED',
          result: 'USABLE',
        })
      }
    } finally {
      await harness.context.app.close()
    }
  })

  it('exposes PREPARING while preparation is pending and never submits early', async () => {
    const fake = createFakeRuntime()
    let resolvePreparation:
      | ((value: PreparedSyntheticEvidence) => void)
      | undefined
    const pendingPreparation = new Promise<PreparedSyntheticEvidence>(
      (resolve) => {
        resolvePreparation = resolve
      },
    )
    fake.prepareSyntheticEvidence.mockImplementation(
      async () => pendingPreparation,
    )
    const harness = await createHarness('APPROVE', fake)
    try {
      const firstPrepare = harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await vi.waitFor(() =>
        expect(fake.prepareSyntheticEvidence).toHaveBeenCalledTimes(1),
      )

      const sameOwner = await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(sameOwner.statusCode).toBe(201)
      expect(sameOwner.json()).toMatchObject({ lifecycle: 'PREPARING' })

      const preparingStatus = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(preparingStatus.json()).toMatchObject({
        lifecycle: 'PREPARING',
      })
      const earlySubmit = await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      expect(earlySubmit.statusCode).toBe(202)
      expect(earlySubmit.json()).toMatchObject({ lifecycle: 'PREPARING' })
      expect(fake.executeIssuer).not.toHaveBeenCalled()

      const otherOwnerStatus = await harness.request('B', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(otherOwnerStatus.statusCode).toBe(404)
      const otherOwnerSubmit = await harness.request('B', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      expect(otherOwnerSubmit.statusCode).toBe(404)

      const preparedInput =
        fake.prepareSyntheticEvidence.mock.calls[0]?.[0]
      if (!preparedInput) {
        throw new Error('expected prepared runtime input')
      }
      resolvePreparation?.({
        preparedRecordId: preparedInput.preparedRecordId,
        reportId: preparedInput.reportId,
        revision: 1,
        commitment: COMMITMENT,
      })
      const completedPrepare = await firstPrepare
      expect(completedPrepare.statusCode).toBe(201)
      expect(completedPrepare.json()).toMatchObject({ lifecycle: 'PREPARED' })

      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()
      expect(fake.executeIssuer).toHaveBeenCalledTimes(1)
    } finally {
      const preparedInput =
        fake.prepareSyntheticEvidence.mock.calls[0]?.[0]
      if (preparedInput) {
        resolvePreparation?.({
          preparedRecordId: preparedInput.preparedRecordId,
          reportId: preparedInput.reportId,
          revision: 1,
          commitment: COMMITMENT,
        })
      }
      await harness.context.app.close()
    }
  })

  it('keeps a failed preparation tombstone and rejects malformed runtime output', async () => {
    const fake = createFakeRuntime({
      prepareOverride: (input) => ({
        preparedRecordId: input.preparedRecordId,
        reportId: input.reportId,
        revision: input.revision,
        commitment: 'not-bytes32',
      }),
    })
    const harness = await createHarness('APPROVE', fake)
    try {
      const failed = await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(failed.statusCode).toBe(503)
      expect(failed.json()).toMatchObject({
        error: { code: 'REPORT_ATTESTATION_PREPARATION_FAILED' },
      })

      const tombstone = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestation`,
      })
      expect(tombstone.json()).toMatchObject({
        lifecycle: 'PREPARATION_FAILED',
        failureCode: 'PREPARATION_RESULT_REJECTED',
      })

      const otherOwner = await harness.request('B', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      expect(otherOwner.statusCode).toBe(503)
      expect(fake.prepareSyntheticEvidence).toHaveBeenCalledTimes(2)
    } finally {
      await harness.context.app.close()
    }
  })

  it.each([
    ['PENDING', 'PENDING'],
    ['RETRY_REQUIRED', 'RETRY_REQUIRED'],
  ] as const)(
    'keeps issuer %s non-terminal and resumes the same prepared operation',
    async (runtimeStatus, lifecycle) => {
      const fake = createFakeRuntime({
        issuerResults: [
          {
            status: runtimeStatus,
            transactionHash: null,
            attestationUID: null,
            reasonCode: null,
          },
          confirmed(SUBMISSION_UID),
        ],
      })
      const harness = await createHarness('APPROVE', fake)
      try {
        await harness.request('A', {
          method: 'POST',
          url: '/api/v1/dev/reports/attestation-fixture',
        })
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        expect(
          await harness.context.reportAttestationService?.getStatus(
            OWNER_A,
            MOCK_REPORT_ID,
          ),
        ).toMatchObject({ lifecycle, failureCode: null })

        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        expect(fake.executeIssuer).toHaveBeenCalledTimes(2)
        const preparedRecordId =
          fake.prepareSyntheticEvidence.mock.calls[0]?.[0].preparedRecordId
        expect(fake.executeIssuer).toHaveBeenNthCalledWith(1, {
          preparedRecordId,
        })
        expect(fake.executeIssuer).toHaveBeenNthCalledWith(2, {
          preparedRecordId,
        })
        expect(
          await harness.context.reportAttestationService?.getStatus(
            OWNER_A,
            MOCK_REPORT_ID,
          ),
        ).toMatchObject({ lifecycle: 'SUBMITTED' })
      } finally {
        await harness.context.app.close()
      }
    },
  )

  it('does not resend an issuer operation that requires reconciliation', async () => {
    const fake = createFakeRuntime({
      issuerResults: [
        {
          status: 'RECONCILIATION_REQUIRED',
          transactionHash: TRANSACTION_HASH,
          attestationUID: null,
          reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
        },
        confirmed(SUBMISSION_UID),
      ],
    })
    const harness = await createHarness('APPROVE', fake)
    try {
      await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      expect(fake.executeIssuer).toHaveBeenCalledTimes(1)
      expect(
        await harness.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).toMatchObject({
        lifecycle: 'RECONCILIATION_REQUIRED',
        submission: {
          status: 'RECONCILIATION_REQUIRED',
          transactionHash: TRANSACTION_HASH,
          attestationUID: null,
          reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
        },
        failureCode: null,
      })
    } finally {
      await harness.context.app.close()
    }
  })

  it.each([
    [
      'missing transaction hash',
      {
        status: 'CONFIRMED',
        transactionHash: null,
        attestationUID: SUBMISSION_UID,
        reasonCode: null,
      },
    ],
    [
      'invalid transaction hash',
      {
        status: 'CONFIRMED',
        transactionHash: '0x01',
        attestationUID: SUBMISSION_UID,
        reasonCode: null,
      },
    ],
    [
      'non-null reason code',
      {
        status: 'CONFIRMED',
        transactionHash: TRANSACTION_HASH,
        attestationUID: SUBMISSION_UID,
        reasonCode: 'UNEXPECTED_REASON',
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, RedactedExecutionResult]>)(
    'rejects an issuer CONFIRMED result with %s',
    async (_label, invalidResult) => {
      const fake = createFakeRuntime({ issuerResults: [invalidResult] })
      const harness = await createHarness('APPROVE', fake)
      try {
        await harness.request('A', {
          method: 'POST',
          url: '/api/v1/dev/reports/attestation-fixture',
        })
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        expect(
          await harness.context.reportAttestationService?.getStatus(
            OWNER_A,
            MOCK_REPORT_ID,
          ),
        ).toMatchObject({
          lifecycle: 'SUBMISSION_FAILED',
          failureCode: 'ISSUER_RESULT_REJECTED',
        })
      } finally {
        await harness.context.app.close()
      }
    },
  )

  it.each([
    [
      'missing transaction hash',
      {
        status: 'CONFIRMED',
        transactionHash: null,
        attestationUID: REVIEW_UID,
        reasonCode: null,
      },
    ],
    [
      'non-null reason code',
      {
        status: 'CONFIRMED',
        transactionHash: TRANSACTION_HASH,
        attestationUID: REVIEW_UID,
        reasonCode: 'UNEXPECTED_REASON',
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, RedactedExecutionResult]>)(
    'rejects a reviewer CONFIRMED result with %s',
    async (_label, invalidResult) => {
      const fake = createFakeRuntime({ reviewerResult: invalidResult })
      const harness = await createHarness('APPROVE', fake)
      try {
        await harness.request('A', {
          method: 'POST',
          url: '/api/v1/dev/reports/attestation-fixture',
        })
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        expect(
          await harness.context.reportAttestationService?.getStatus(
            OWNER_A,
            MOCK_REPORT_ID,
          ),
        ).toMatchObject({
          lifecycle: 'REVIEW_FAILED',
          failureCode: 'REVIEWER_RESULT_REJECTED',
        })
        expect(fake.isUsable).not.toHaveBeenCalled()
      } finally {
        await harness.context.app.close()
      }
    },
  )

  it('preserves a confirmed review receipt and reconciles without resending it', async () => {
    const fake = createFakeRuntime()
    fake.isUsable
      .mockRejectedValueOnce(new Error('private reconciliation failure'))
      .mockResolvedValue(true)
    const harness = await createHarness('APPROVE', fake)
    try {
      await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      const reconciliationRequired =
        await harness.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        )
      expect(reconciliationRequired).toMatchObject({
        lifecycle: 'RECONCILIATION_REQUIRED',
        review: {
          status: 'CONFIRMED',
          transactionHash: TRANSACTION_HASH,
          attestationUID: REVIEW_UID,
          reasonCode: null,
        },
        failureCode: 'REVIEW_RECONCILIATION_FAILED',
      })
      expect(fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(fake.isUsable).toHaveBeenCalledTimes(1)

      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      expect(
        await harness.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).toMatchObject({
        lifecycle: 'APPROVED',
        review: {
          status: 'CONFIRMED',
          transactionHash: TRANSACTION_HASH,
          attestationUID: REVIEW_UID,
          reasonCode: null,
        },
        failureCode: null,
      })
      expect(fake.executeReviewer).toHaveBeenCalledTimes(1)
      expect(fake.isUsable).toHaveBeenCalledTimes(2)
    } finally {
      await harness.context.app.close()
    }
  })

  it('supports only the trusted MANUAL_REVIEW configuration', async () => {
    const manualResult: RedactedExecutionResult = {
      status: 'MANUAL_REVIEW',
      transactionHash: null,
      attestationUID: null,
      reasonCode: 'HUMAN_DECISION_REQUIRED',
    }
    const manual = await createHarness(
      'MANUAL_REVIEW',
      createFakeRuntime({ reviewerResult: manualResult }),
    )
    try {
      await manual.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await manual.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await manual.context.reportAttestationService?.waitForIdle()
      await manual.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await manual.context.reportAttestationService?.waitForIdle()
      expect(
        await manual.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).toMatchObject({
        lifecycle: 'MANUAL_REVIEW',
        failureCode: null,
      })
    } finally {
      await manual.context.app.close()
    }

    const mismatch = await createHarness(
      'APPROVE',
      createFakeRuntime({ reviewerResult: manualResult }),
    )
    try {
      await mismatch.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await mismatch.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await mismatch.context.reportAttestationService?.waitForIdle()
      await mismatch.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await mismatch.context.reportAttestationService?.waitForIdle()
      expect(
        await mismatch.context.reportAttestationService?.getStatus(
          OWNER_A,
          MOCK_REPORT_ID,
        ),
      ).toMatchObject({
        lifecycle: 'REVIEW_FAILED',
        failureCode: 'REVIEW_OUTCOME_MISMATCH',
      })
    } finally {
      await mismatch.context.app.close()
    }
  })

  it.each([
    ['APPROVE', false],
    ['REJECT', true],
    ['MANUAL_REVIEW', true],
  ] as const)(
    'fails closed when configured %s disagrees with the runtime result',
    async (reviewOutcome, runtimeApproved) => {
      const harness = await createHarness(
        reviewOutcome,
        createFakeRuntime({ runtimeApproved }),
      )
      try {
        await harness.request('A', {
          method: 'POST',
          url: '/api/v1/dev/reports/attestation-fixture',
        })
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        await harness.request('A', {
          method: 'POST',
          url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
        })
        await harness.context.reportAttestationService?.waitForIdle()
        expect(
          await harness.context.reportAttestationService?.getStatus(
            OWNER_A,
            MOCK_REPORT_ID,
          ),
        ).toMatchObject({
          lifecycle: 'REVIEW_FAILED',
          failureCode: 'REVIEW_OUTCOME_MISMATCH',
        })
      } finally {
        await harness.context.app.close()
      }
    },
  )

  it('returns a stable rejected verification without running artifact verification', async () => {
    const fake = createFakeRuntime({ runtimeApproved: false })
    const harness = await createHarness('REJECT', fake)
    try {
      await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      const response = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
      })
      expect(response.json()).toEqual({
        reportId: MOCK_REPORT_ID,
        lifecycle: 'REJECTED',
        result: 'UNUSABLE',
        reasonCode: 'REVIEW_REJECTED',
      })
      expect(fake.verifyPreparedReport).not.toHaveBeenCalled()
    } finally {
      await harness.context.app.close()
    }
  })

  it('maps verification exceptions without exposing private runtime details', async () => {
    const harness = await createHarness(
      'APPROVE',
      createFakeRuntime({ verifyThrows: true }),
    )
    try {
      await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await harness.context.reportAttestationService?.waitForIdle()
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/dev/reports/${MOCK_REPORT_ID}/attestation-review`,
      })
      await harness.context.reportAttestationService?.waitForIdle()

      const response = await harness.request('A', {
        method: 'GET',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/verification`,
      })
      expect(response.json()).toMatchObject({
        result: 'VERIFY_FAILED',
        reasonCode: 'VERIFICATION_EXECUTION_FAILED',
      })
      expect(response.body).not.toContain('private runtime verification detail')
      expect(response.body).not.toContain('stack')
    } finally {
      await harness.context.app.close()
    }
  })

  it('waits for a queued job and closes the runtime exactly once', async () => {
    const fake = createFakeRuntime()
    let resolveIssuer:
      | ((value: RedactedExecutionResult) => void)
      | undefined
    const pendingIssuer = new Promise<RedactedExecutionResult>((resolve) => {
      resolveIssuer = resolve
    })
    fake.executeIssuer.mockImplementation(async () => pendingIssuer)
    const harness = await createHarness('APPROVE', fake)
    try {
      await harness.request('A', {
        method: 'POST',
        url: '/api/v1/dev/reports/attestation-fixture',
      })
      await harness.request('A', {
        method: 'POST',
        url: `/api/v1/reports/${MOCK_REPORT_ID}/attestations`,
      })
      await vi.waitFor(() =>
        expect(fake.executeIssuer).toHaveBeenCalledTimes(1),
      )

      const closing = harness.context.app.close()
      await Promise.resolve()
      expect(fake.close).not.toHaveBeenCalled()
      resolveIssuer?.(confirmed(SUBMISSION_UID))
      await closing
      expect(fake.close).toHaveBeenCalledTimes(1)

      await harness.context.app.close()
      expect(fake.close).toHaveBeenCalledTimes(1)
    } finally {
      resolveIssuer?.(confirmed(SUBMISSION_UID))
      await harness.context.app.close()
    }
  })

  it('rejects the local runtime in production before server startup', async () => {
    const fake = createFakeRuntime()
    await expect(
      buildApp({
        config: { ...config, runtimeMode: 'production' },
        logger: false,
        reportAttestations: {
          runtime: fake.runtime,
          reviewOutcome: 'APPROVE',
        },
      }),
    ).rejects.toThrow('Local report attestations are not allowed in production')
    expect(fake.prepareSyntheticEvidence).not.toHaveBeenCalled()
    expect(fake.close).not.toHaveBeenCalled()
  })

  it('rejects production before the optional contracts module import', () => {
    expect(() =>
      loadLocalReportAttestationRuntime({
        runtimeMode: 'production',
        reviewOutcome: 'APPROVE',
      }),
    ).toThrow(
      expect.objectContaining<Partial<LocalContractsRuntimeError>>({
        code: 'LOCAL_CONTRACTS_NOT_ALLOWED',
      }),
    )
  })
})
