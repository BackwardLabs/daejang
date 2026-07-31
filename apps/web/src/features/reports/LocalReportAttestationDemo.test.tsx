import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LocalReportAttestationDemo } from './LocalReportAttestationDemo.tsx'
import type {
  LocalReportAttestationApi,
  ReportAttestationLifecycle,
  ReportAttestationStatus,
} from './reportAttestationApi.ts'

const RAW_UID = `0x${'a'.repeat(64)}`
const SUBMISSION_TRANSACTION_HASH = `0x${'b'.repeat(64)}`
const SUBMISSION_ATTESTATION_UID = `0x${'c'.repeat(64)}`
const REVIEW_TRANSACTION_HASH = `0x${'d'.repeat(64)}`
const REVIEW_ATTESTATION_UID = `0x${'e'.repeat(64)}`

const status = (
  lifecycle: ReportAttestationLifecycle,
  options?: {
    submissionConfirmed?: boolean
    reviewConfirmed?: boolean
  },
): ReportAttestationStatus => ({
  reportId: RAW_UID,
  lifecycle,
  failureCode: null,
  submissionConfirmed: options?.submissionConfirmed ?? false,
  reviewConfirmed: options?.reviewConfirmed ?? false,
  submissionEvidence: options?.submissionConfirmed
    ? {
        transactionHash: SUBMISSION_TRANSACTION_HASH,
        attestationUID: SUBMISSION_ATTESTATION_UID,
      }
    : null,
  reviewEvidence: options?.reviewConfirmed
    ? {
        transactionHash: REVIEW_TRANSACTION_HASH,
        attestationUID: REVIEW_ATTESTATION_UID,
      }
    : null,
})

const usableVerification = {
  lifecycle: 'APPROVED',
  result: 'USABLE',
  reasonCode: null,
} as const

const createApi = (
  overrides: Partial<LocalReportAttestationApi> = {},
): LocalReportAttestationApi => ({
  prepare: vi.fn(async () => status('PREPARED')),
  prepareFixture: vi.fn(async () => status('PREPARED')),
  submit: vi.fn(async () =>
    status('SUBMITTED', { submissionConfirmed: true }),
  ),
  review: vi.fn(async () =>
    status('APPROVED', {
      submissionConfirmed: true,
      reviewConfirmed: true,
    }),
  ),
  getStatus: vi.fn(async () =>
    status('APPROVED', {
      submissionConfirmed: true,
      reviewConfirmed: true,
    }),
  ),
  getVerification: vi.fn(async () => usableVerification),
  ...overrides,
})

describe('LocalReportAttestationDemo', () => {
  it('automates Issuer and Reviewer, shows USABLE, and suppresses duplicate clicks', async () => {
    const getStatus = vi
      .fn<LocalReportAttestationApi['getStatus']>()
      .mockResolvedValueOnce(
        status('SUBMITTED', { submissionConfirmed: true }),
      )
      .mockResolvedValueOnce(
        status('APPROVED', {
          submissionConfirmed: true,
          reviewConfirmed: true,
        }),
      )
    const api = createApi({
      submit: vi.fn(async () => status('SUBMISSION_QUEUED')),
      review: vi.fn(async () =>
        status('REVIEW_QUEUED', { submissionConfirmed: true }),
      ),
      getStatus,
    })

    render(
      <StrictMode>
        <LocalReportAttestationDemo
          api={api}
          pollIntervalMs={1}
          pollTimeoutMs={100}
        />
      </StrictMode>,
    )

    const runButton = screen.getByRole('button', {
      name: '로컬 증명 자동 실행',
    })
    fireEvent.click(runButton)
    fireEvent.click(runButton)

    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(api.prepareFixture).toHaveBeenCalledTimes(1)
    expect(api.submit).toHaveBeenCalledTimes(1)
    expect(api.review).toHaveBeenCalledTimes(1)
    expect(api.getVerification).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText(/백엔드가 Issuer와 Reviewer를 자동 실행합니다/),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(RAW_UID)
    expect(document.body).toHaveTextContent(SUBMISSION_TRANSACTION_HASH)
    expect(document.body).toHaveTextContent(SUBMISSION_ATTESTATION_UID)
    expect(document.body).toHaveTextContent(REVIEW_TRANSACTION_HASH)
    expect(document.body).toHaveTextContent(REVIEW_ATTESTATION_UID)
    expect(
      screen.getByText('승인 조건을 모두 충족했습니다.'),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '검증 새로고침' }),
    )
    await waitFor(() => {
      expect(api.getVerification).toHaveBeenCalledTimes(2)
    })
  })

  it('shows UNUSABLE after the automated Reviewer rejects the report', async () => {
    const api = createApi({
      review: vi.fn(async () =>
        status('REJECTED', {
          submissionConfirmed: true,
          reviewConfirmed: true,
        }),
      ),
      getVerification: vi.fn(async () => ({
        lifecycle: 'REJECTED',
        result: 'UNUSABLE',
        reasonCode: 'REVIEW_REJECTED',
      } as const)),
    })

    render(<LocalReportAttestationDemo api={api} />)
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByText('UNUSABLE')).toBeInTheDocument()
    expect(
      screen.getByText(
        '검토 기준을 통과하지 못해 이 장부는 사용할 수 없습니다.',
      ),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('REVIEW_REJECTED')
    expect(
      screen.getByText(
        '검토에서 반려되어 승인본이 만들어지지 않았으므로 이 장부는 사용할 수 없습니다.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('반려 Tx')).toBeInTheDocument()
    expect(screen.getByText('REJECT Attestation UID')).toBeInTheDocument()
    expect(document.body).toHaveTextContent(REVIEW_TRANSACTION_HASH)
    expect(document.body).toHaveTextContent(REVIEW_ATTESTATION_UID)
  })

  it('shows manual review as a separate completion without verification', async () => {
    const api = createApi({
      review: vi.fn(async () =>
        status('MANUAL_REVIEW', { submissionConfirmed: true }),
      ),
    })

    render(<LocalReportAttestationDemo api={api} />)
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(
      await screen.findAllByText('사람 검토 필요'),
    ).toHaveLength(2)
    expect(api.getVerification).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: '검증 새로고침' }),
    ).not.toBeInTheDocument()
  })

  it('resumes durable Issuer states with bounded idempotent submission calls', async () => {
    const submit = vi
      .fn<LocalReportAttestationApi['submit']>()
      .mockResolvedValueOnce(status('SUBMISSION_QUEUED'))
      .mockResolvedValueOnce(status('SUBMISSION_QUEUED'))
    const getStatus = vi
      .fn<LocalReportAttestationApi['getStatus']>()
      .mockResolvedValueOnce(status('RETRY_REQUIRED'))
      .mockResolvedValueOnce(
        status('SUBMITTED', { submissionConfirmed: true }),
      )
    const api = createApi({
      prepareFixture: vi.fn(async () => status('PENDING')),
      submit,
      getStatus,
    })

    render(
      <LocalReportAttestationDemo
        api={api}
        pollIntervalMs={1}
        pollTimeoutMs={100}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(api.review).toHaveBeenCalledTimes(1)
  })

  it('resumes durable Reviewer states without repeating Issuer submission', async () => {
    const review = vi
      .fn<LocalReportAttestationApi['review']>()
      .mockResolvedValueOnce(
        status('REVIEW_QUEUED', { submissionConfirmed: true }),
      )
      .mockResolvedValueOnce(
        status('REVIEW_QUEUED', { submissionConfirmed: true }),
      )
    const getStatus = vi
      .fn<LocalReportAttestationApi['getStatus']>()
      .mockResolvedValueOnce(
        status('PENDING', { submissionConfirmed: true }),
      )
      .mockResolvedValueOnce(
        status('APPROVED', {
          submissionConfirmed: true,
          reviewConfirmed: true,
        }),
      )
    const api = createApi({
      prepareFixture: vi.fn(async () =>
        status('RECONCILIATION_REQUIRED', {
          submissionConfirmed: true,
        }),
      ),
      review,
      getStatus,
    })

    render(
      <LocalReportAttestationDemo
        api={api}
        pollIntervalMs={1}
        pollTimeoutMs={100}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(api.submit).not.toHaveBeenCalled()
    expect(review).toHaveBeenCalledTimes(2)
  })

  it('stops durable resume after the configured maximum attempts', async () => {
    const submit = vi.fn(async () => status('RETRY_REQUIRED'))
    const api = createApi({
      prepareFixture: vi.fn(async () => status('PENDING')),
      submit,
    })

    render(
      <LocalReportAttestationDemo
        api={api}
        maxResumeAttempts={2}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '백엔드 증명 단계가 완료되지 않았습니다',
    )
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('surfaces a bounded polling timeout without exposing internal data', async () => {
    const api = createApi({
      submit: vi.fn(async () => status('SUBMITTING')),
      getStatus: vi.fn(async () => status('SUBMITTING')),
    })

    render(
      <LocalReportAttestationDemo
        api={api}
        pollIntervalMs={1}
        pollTimeoutMs={5}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '처리 시간이 초과되었습니다',
    )
    expect(
      screen.getByRole('button', { name: '다시 시도' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(RAW_UID)
  })

  it('times out a never-resolving API request and leaves the UI retryable', async () => {
    const api = createApi({
      prepareFixture: vi.fn(
        () =>
          new Promise<ReportAttestationStatus>(() => undefined),
      ),
    })

    render(
      <LocalReportAttestationDemo
        api={api}
        requestTimeoutMs={5}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '처리 시간이 초과되었습니다',
    )
    expect(
      screen.getByRole('button', { name: '다시 시도' }),
    ).toBeInTheDocument()
  })

  it('bounds a never-resolving verification refresh', async () => {
    const getVerification = vi
      .fn<LocalReportAttestationApi['getVerification']>()
      .mockResolvedValueOnce(usableVerification)
      .mockImplementationOnce(
        () => new Promise(() => undefined),
      )
    const api = createApi({ getVerification })

    render(
      <LocalReportAttestationDemo
        api={api}
        requestTimeoutMs={5}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )
    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '검증 새로고침' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '처리 시간이 초과되었습니다',
    )
    expect(getVerification).toHaveBeenCalledTimes(2)
  })

  it('offers an idempotent retry after a request error', async () => {
    const prepareFixture = vi
      .fn<LocalReportAttestationApi['prepareFixture']>()
      .mockRejectedValueOnce(new Error('private backend detail'))
      .mockResolvedValueOnce(status('PREPARED'))
    const api = createApi({ prepareFixture })

    render(<LocalReportAttestationDemo api={api} />)
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )

    expect(await screen.findByRole('alert')).not.toHaveTextContent(
      'private backend detail',
    )
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))

    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(prepareFixture).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight run and offers a safe resume', async () => {
    const prepareFixture = vi.fn<LocalReportAttestationApi['prepareFixture']>(
      (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('private abort detail', 'AbortError'),
              ),
            { once: true },
          )
        }),
    )
    const api = createApi({ prepareFixture })

    render(<LocalReportAttestationDemo api={api} />)
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '실행 중단' }),
    )

    expect(await screen.findByText(/실행을 중단했습니다/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '다시 시도' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('private abort detail')
  })

  it('aborts a never-resolving request on unmount without a state warning', async () => {
    let requestSignal: AbortSignal | undefined
    const prepareFixture = vi.fn<LocalReportAttestationApi['prepareFixture']>(
      (signal) => {
        requestSignal = signal
        return new Promise(() => undefined)
      },
    )
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const api = createApi({ prepareFixture })
    const view = render(<LocalReportAttestationDemo api={api} />)
    fireEvent.click(
      screen.getByRole('button', { name: '로컬 증명 자동 실행' }),
    )
    await waitFor(() => expect(requestSignal).toBeDefined())

    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(requestSignal?.aborted).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
