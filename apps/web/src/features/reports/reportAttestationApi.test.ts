import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  localReportAttestationApi,
  pollReportAttestationStatus,
  ReportAttestationPollingTimeoutError,
  type ReportAttestationStatus,
} from './reportAttestationApi.ts'

const UID = `0x${'a'.repeat(64)}`
const TRANSACTION_HASH = `0x${'b'.repeat(64)}`

const wireStatus = (
  lifecycle: ReportAttestationStatus['lifecycle'],
  options?: { submissionConfirmed?: boolean; reviewConfirmed?: boolean },
) => ({
  reportId: 'report/mock 28',
  lifecycle,
  failureCode: null,
  submission: options?.submissionConfirmed
    ? {
        status: 'CONFIRMED',
        transactionHash: TRANSACTION_HASH,
        attestationUID: UID,
        reasonCode: null,
      }
    : null,
  review: options?.reviewConfirmed
    ? {
        status: 'CONFIRMED',
        transactionHash: TRANSACTION_HASH,
        attestationUID: UID,
        reasonCode: null,
      }
    : null,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('localReportAttestationApi', () => {
  it('uses empty POST requests and exposes only confirmed public receipts', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(wireStatus('PREPARED'), 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(wireStatus('PREPARED'), 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(wireStatus('SUBMISSION_QUEUED'), 202),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          wireStatus('REVIEW_QUEUED', {
            submissionConfirmed: true,
          }),
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          wireStatus('APPROVED', {
            submissionConfirmed: true,
            reviewConfirmed: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          reportId: 'report/mock 28',
          lifecycle: 'APPROVED',
          result: 'USABLE',
          reasonCode: null,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const preparedFromReport =
      await localReportAttestationApi.prepare('report/mock 28')
    const prepared = await localReportAttestationApi.prepareFixture()
    const submitted = await localReportAttestationApi.submit(prepared.reportId)
    const reviewed = await localReportAttestationApi.review(prepared.reportId)
    const status = await localReportAttestationApi.getStatus(prepared.reportId)
    const verification =
      await localReportAttestationApi.getVerification(prepared.reportId)

    expect(prepared).toEqual({
      reportId: 'report/mock 28',
      lifecycle: 'PREPARED',
      failureCode: null,
      submissionConfirmed: false,
      reviewConfirmed: false,
      submissionEvidence: null,
      reviewEvidence: null,
    })
    expect(submitted.submissionEvidence).toBeNull()
    expect(reviewed.submissionEvidence).toEqual({
      transactionHash: TRANSACTION_HASH,
      attestationUID: UID,
    })
    expect(reviewed.reviewEvidence).toBeNull()
    expect(status.submissionEvidence).toEqual({
      transactionHash: TRANSACTION_HASH,
      attestationUID: UID,
    })
    expect(status.reviewEvidence).toEqual({
      transactionHash: TRANSACTION_HASH,
      attestationUID: UID,
    })
    expect(verification.result).toBe('USABLE')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/reports/report%2Fmock%2028/attestation-preparation',
      '/api/v1/dev/reports/attestation-fixture',
      '/api/v1/reports/report%2Fmock%2028/attestations',
      '/api/v1/dev/reports/report%2Fmock%2028/attestation-review',
      '/api/v1/reports/report%2Fmock%2028/attestation',
      '/api/v1/reports/report%2Fmock%2028/verification',
    ])
    expect(preparedFromReport.reportId).toBe('report/mock 28')
    for (const call of fetchMock.mock.calls.slice(0, 4)) {
      const init = call[1]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).has('content-type')).toBe(false)
    }
  })

  it('does not promote an incomplete receipt to confirmed', async () => {
    const complete = wireStatus('APPROVED', {
      submissionConfirmed: true,
      reviewConfirmed: true,
    })
    const incomplete = {
      ...complete,
      submission: {
        ...complete.submission!,
        transactionHash: null,
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(incomplete, 201)),
    )

    await expect(
      localReportAttestationApi.prepareFixture(),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
  })

  it('accepts a valid manual-review receipt without exposing its reason', async () => {
    const manual = {
      ...wireStatus('MANUAL_REVIEW', { submissionConfirmed: true }),
      review: {
        status: 'MANUAL_REVIEW',
        transactionHash: null,
        attestationUID: null,
        reasonCode: 'NEEDS_HUMAN_REVIEW',
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(manual, 201)),
    )

    await expect(
      localReportAttestationApi.prepareFixture(),
    ).resolves.toEqual({
      reportId: 'report/mock 28',
      lifecycle: 'MANUAL_REVIEW',
      failureCode: null,
      submissionConfirmed: true,
      reviewConfirmed: false,
      submissionEvidence: {
        transactionHash: TRANSACTION_HASH,
        attestationUID: UID,
      },
      reviewEvidence: null,
    })
  })

  it('rejects missing, extra, invalid-time, and contradictory status fields', async () => {
    const missing = Object.fromEntries(
      Object.entries(wireStatus('PREPARED')).filter(
        ([key]) => key !== 'updatedAt',
      ),
    )
    const extra = {
      ...wireStatus('PREPARED'),
      commitment: UID,
    }
    const invalidTime = {
      ...wireStatus('PREPARED'),
      updatedAt: '2026-07-28',
    }
    const approvedWithoutReceipts = wireStatus('APPROVED')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(missing, 201))
      .mockResolvedValueOnce(jsonResponse(extra, 201))
      .mockResolvedValueOnce(jsonResponse(invalidTime, 201))
      .mockResolvedValueOnce(jsonResponse(approvedWithoutReceipts, 201))
    vi.stubGlobal('fetch', fetchMock)

    for (let index = 0; index < 4; index += 1) {
      await expect(
        localReportAttestationApi.prepareFixture(),
      ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
    }
  })

  it('rejects missing and extra receipt fields', async () => {
    const valid = wireStatus('SUBMITTED', { submissionConfirmed: true })
    const missingReceipt = {
      ...valid,
      submission: Object.fromEntries(
        Object.entries(valid.submission!).filter(
          ([key]) => key !== 'reasonCode',
        ),
      ),
    }
    const extraReceipt = {
      ...valid,
      submission: {
        ...valid.submission!,
        nonce: 1,
      },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(missingReceipt, 201))
      .mockResolvedValueOnce(jsonResponse(extraReceipt, 201))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      localReportAttestationApi.prepareFixture(),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
    await expect(
      localReportAttestationApi.prepareFixture(),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
  })

  it('rejects receipt kinds that contradict REVIEW_FAILED failure codes', async () => {
    const confirmedExecutionFailure = {
      ...wireStatus('REVIEW_FAILED', {
        submissionConfirmed: true,
        reviewConfirmed: true,
      }),
      failureCode: 'REVIEWER_EXECUTION_FAILED',
    }
    const nonTerminalOutcomeMismatch = {
      ...wireStatus('REVIEW_FAILED', {
        submissionConfirmed: true,
      }),
      failureCode: 'REVIEW_OUTCOME_MISMATCH',
      review: {
        status: 'RETRY_REQUIRED',
        transactionHash: null,
        attestationUID: null,
        reasonCode: null,
      },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(confirmedExecutionFailure))
      .mockResolvedValueOnce(jsonResponse(nonTerminalOutcomeMismatch))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      localReportAttestationApi.prepareFixture(),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
    await expect(
      localReportAttestationApi.prepareFixture(),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
  })

  it('accepts the REVIEW_FAILED receipt kinds emitted by the backend', async () => {
    const failedExecution = {
      ...wireStatus('REVIEW_FAILED', {
        submissionConfirmed: true,
      }),
      failureCode: 'REVIEWER_EXECUTION_FAILED',
      review: {
        status: 'FAILED',
        transactionHash: null,
        attestationUID: null,
        reasonCode: null,
      },
    }
    const confirmedOutcomeMismatch = {
      ...wireStatus('REVIEW_FAILED', {
        submissionConfirmed: true,
        reviewConfirmed: true,
      }),
      failureCode: 'REVIEW_OUTCOME_MISMATCH',
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(failedExecution))
      .mockResolvedValueOnce(jsonResponse(confirmedOutcomeMismatch))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      localReportAttestationApi.prepareFixture(),
    ).resolves.toMatchObject({
      lifecycle: 'REVIEW_FAILED',
      failureCode: 'REVIEWER_EXECUTION_FAILED',
      reviewConfirmed: false,
    })
    await expect(
      localReportAttestationApi.prepareFixture(),
    ).resolves.toMatchObject({
      lifecycle: 'REVIEW_FAILED',
      failureCode: 'REVIEW_OUTCOME_MISMATCH',
      reviewConfirmed: true,
    })
  })

  it('binds status and verification responses to the requested report', async () => {
    const mismatchedStatus = {
      ...wireStatus('SUBMITTED', { submissionConfirmed: true }),
      reportId: 'different-report',
    }
    const mismatchedVerification = {
      reportId: 'different-report',
      lifecycle: 'APPROVED',
      result: 'USABLE',
      reasonCode: null,
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(mismatchedStatus, 202))
      .mockResolvedValueOnce(jsonResponse(mismatchedVerification))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      localReportAttestationApi.submit('report/mock 28'),
    ).rejects.toThrow('REPORT_ATTESTATION_RESPONSE_INVALID')
    await expect(
      localReportAttestationApi.getVerification('report/mock 28'),
    ).rejects.toThrow('REPORT_VERIFICATION_RESPONSE_INVALID')
  })
})

describe('pollReportAttestationStatus', () => {
  it('retries a transient request error and returns the terminal status', async () => {
    const approved: ReportAttestationStatus = {
      reportId: 'report-28',
      lifecycle: 'APPROVED',
      failureCode: null,
      submissionConfirmed: true,
      reviewConfirmed: true,
      submissionEvidence: null,
      reviewEvidence: null,
    }
    const loadStatus = vi
      .fn<
        (
          reportId: string,
          signal?: AbortSignal,
        ) => Promise<ReportAttestationStatus>
      >()
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce(approved)

    await expect(
      pollReportAttestationStatus(loadStatus, approved.reportId, {
        done: (status) => status.lifecycle === 'APPROVED',
        failed: () => false,
        intervalMs: 1,
        timeoutMs: 50,
        requestRetries: 1,
      }),
    ).resolves.toEqual(approved)
    expect(loadStatus).toHaveBeenCalledTimes(2)
  })

  it('removes the abort listener after every completed polling tick', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(
      controller.signal,
      'removeEventListener',
    )
    let calls = 0
    const loadStatus = vi.fn(async () => {
      calls += 1
      return {
        reportId: 'report-28',
        lifecycle: calls === 4 ? 'APPROVED' : 'REVIEWING',
        failureCode: null,
        submissionConfirmed: true,
        reviewConfirmed: calls === 4,
        submissionEvidence: null,
        reviewEvidence: null,
      } satisfies ReportAttestationStatus
    })

    await expect(
      pollReportAttestationStatus(loadStatus, 'report-28', {
        done: (current) => current.lifecycle === 'APPROVED',
        failed: () => false,
        signal: controller.signal,
        intervalMs: 1,
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({ lifecycle: 'APPROVED' })

    expect(loadStatus).toHaveBeenCalledTimes(4)
    expect(addListener.mock.calls.length).toBeGreaterThan(3)
    expect(removeListener).toHaveBeenCalledTimes(
      addListener.mock.calls.length,
    )
  })

  it('stops after the bounded timeout', async () => {
    vi.useFakeTimers()
    const waiting: ReportAttestationStatus = {
      reportId: 'report-28',
      lifecycle: 'REVIEWING',
      failureCode: null,
      submissionConfirmed: true,
      reviewConfirmed: false,
      submissionEvidence: null,
      reviewEvidence: null,
    }
    const promise = pollReportAttestationStatus(
      async () => waiting,
      waiting.reportId,
      {
        done: () => false,
        failed: () => false,
        intervalMs: 10,
        timeoutMs: 30,
      },
    )
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ReportAttestationPollingTimeoutError,
    )

    await vi.advanceTimersByTimeAsync(31)
    await assertion
  })

  it('aborts a never-resolving status request at the polling deadline', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const loadStatus = vi.fn(
      (_reportId: string, signal?: AbortSignal) => {
        requestSignal = signal
        return new Promise<ReportAttestationStatus>(() => undefined)
      },
    )
    const promise = pollReportAttestationStatus(
      loadStatus,
      'report-28',
      {
        done: () => false,
        failed: () => false,
        intervalMs: 10,
        timeoutMs: 30,
      },
    )
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ReportAttestationPollingTimeoutError,
    )

    await vi.advanceTimersByTimeAsync(31)

    await assertion
    expect(loadStatus).toHaveBeenCalledTimes(1)
    expect(requestSignal?.aborted).toBe(true)
  })

  it('aborts polling without issuing another request', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(
      controller.signal,
      'removeEventListener',
    )
    const waiting: ReportAttestationStatus = {
      reportId: 'report-28',
      lifecycle: 'SUBMITTING',
      failureCode: null,
      submissionConfirmed: false,
      reviewConfirmed: false,
      submissionEvidence: null,
      reviewEvidence: null,
    }
    const loadStatus = vi.fn(async () => waiting)
    const promise = pollReportAttestationStatus(
      loadStatus,
      waiting.reportId,
      {
        done: () => false,
        failed: () => false,
        signal: controller.signal,
        intervalMs: 20,
        timeoutMs: 100,
      },
    )

    await Promise.resolve()
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(loadStatus).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(
      addListener.mock.calls.length,
    )
  })
})
