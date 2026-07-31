import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SyntheticReportAttestationPanel } from './SyntheticReportAttestationPanel.tsx'
import type {
  SyntheticReportAttestationApi,
  SyntheticReportAttestationSnapshot,
} from './syntheticReportAttestationApi.ts'

const SUBMIT_TX = `0x${'1'.repeat(64)}`
const SUBMIT_UID = `0x${'2'.repeat(64)}`
const REVIEW_TX = `0x${'3'.repeat(64)}`
const REVIEW_UID = `0x${'4'.repeat(64)}`
const INTERNAL_USER_ID = 'private-user-0001'
const INTERNAL_CONTRACT_REPORT_ID = `0x${'f'.repeat(64)}`

const capability = {
  enabled: true,
  network: 'eip155:91342',
  mode: 'SYNTHETIC_TESTNET',
  explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
  reasonCode: null,
} as const

const fixture = {
  taxYear: 2025,
  transactionCount: 12,
  completeCount: 10,
  exceptionCount: 2,
  denomination: 'KRW',
} as const

const snapshot = (
  lifecycle?: 'SUBMITTED' | 'APPROVED' | 'REJECTED',
): SyntheticReportAttestationSnapshot => {
  const submitted = lifecycle !== undefined
  const reviewed = lifecycle === 'APPROVED' || lifecycle === 'REJECTED'
  return {
    capability,
    fixture,
    status: lifecycle
      ? {
          lifecycle,
          failureCode: null,
          reasonCode: null,
          submissionConfirmed: submitted,
          reviewConfirmed: reviewed,
          submissionEvidence: submitted
            ? {
                transactionHash: SUBMIT_TX,
                attestationUID: SUBMIT_UID,
              }
            : null,
          reviewEvidence: reviewed
            ? {
                transactionHash: REVIEW_TX,
                attestationUID: REVIEW_UID,
              }
            : null,
        }
      : null,
    verification:
      lifecycle === 'APPROVED'
        ? { lifecycle, result: 'USABLE', reasonCode: null }
        : lifecycle === 'REJECTED'
          ? {
              lifecycle,
              result: 'UNUSABLE',
              reasonCode: 'REVIEW_REJECTED',
            }
          : null,
  }
}

const createApi = (
  initial: SyntheticReportAttestationSnapshot,
  overrides: Partial<SyntheticReportAttestationApi> = {},
): SyntheticReportAttestationApi => ({
  load: vi.fn(async () => initial),
  submit: vi.fn(async () => snapshot('SUBMITTED')),
  review: vi.fn(async () => snapshot('APPROVED')),
  ...overrides,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SyntheticReportAttestationPanel', () => {
  it('renders the production testnet pilot without issuing a write on mount', async () => {
    const api = createApi(snapshot())

    render(<SyntheticReportAttestationPanel api={api} />)

    expect(
      await screen.findByText('SYNTHETIC · GIWA SEPOLIA TESTNET'),
    ).toBeInTheDocument()
    expect(screen.getByText('2025년')).toBeInTheDocument()
    expect(screen.getByText('12건')).toBeInTheDocument()
    expect(api.load).toHaveBeenCalledTimes(1)
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.review).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: '장부 생성 및 제출' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: '검토 요청 및 검증' }),
    ).toBeDisabled()
  })

  it('stops at SUBMITTED, unlocks review, and suppresses double submission', async () => {
    const api = createApi(snapshot())
    render(
      <SyntheticReportAttestationPanel
        api={api}
        pollIntervalMs={1}
        pollTimeoutMs={100}
      />,
    )
    const submit = await screen.findByRole('button', {
      name: '장부 생성 및 제출',
    })

    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(
      await screen.findByText(
        'SUBMIT attestation이 확정되었습니다. 이제 고정 합성 테스트 정책 검토를 요청할 수 있습니다.',
      ),
    ).toBeInTheDocument()
    expect(api.submit).toHaveBeenCalledTimes(1)
    expect(api.review).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: '장부 제출 완료' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: '검토 요청 및 검증' }),
    ).toBeEnabled()
  })

  it('shows an approved USABLE decision and linked onchain evidence', async () => {
    const initial = {
      ...snapshot('SUBMITTED'),
      privateUserId: INTERNAL_USER_ID,
      contractReportId: INTERNAL_CONTRACT_REPORT_ID,
    } as SyntheticReportAttestationSnapshot
    const api = createApi(initial, {
      review: vi.fn(async () => snapshot('APPROVED')),
    })

    render(<SyntheticReportAttestationPanel api={api} />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: '검토 요청 및 검증',
      }),
    )

    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(
      screen.getByText('승인 조건을 모두 충족했습니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Reviewer가 승인했고, 합성 장부의 commitment와 현재 온체인 승인본이 일치해 사용할 수 있습니다.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: SUBMIT_TX })).toHaveAttribute(
      'href',
      `https://sepolia-explorer.giwa.io/tx/${SUBMIT_TX}`,
    )
    expect(screen.getByRole('link', { name: REVIEW_TX })).toHaveAttribute(
      'href',
      `https://sepolia-explorer.giwa.io/tx/${REVIEW_TX}`,
    )
    expect(document.body).toHaveTextContent(SUBMIT_UID)
    expect(document.body).toHaveTextContent(REVIEW_UID)
    expect(document.body).not.toHaveTextContent(INTERNAL_USER_ID)
    expect(document.body).not.toHaveTextContent(INTERNAL_CONTRACT_REPORT_ID)
    expect(api.review).toHaveBeenCalledTimes(1)
  })

  it('uses the current synthetic UI for local Anvil without creating false Explorer links', async () => {
    vi.stubEnv('VITE_GIWA28_LOCAL_DEMO', 'true')
    const localCapability = {
      enabled: true,
      network: 'eip155:31337',
      mode: 'LOCAL_ANVIL',
      explorerBaseUrl: null,
      reasonCode: null,
    } as const
    const localApproved: SyntheticReportAttestationSnapshot = {
      ...snapshot('APPROVED'),
      capability: localCapability,
    }

    render(
      <SyntheticReportAttestationPanel
        api={createApi(localApproved)}
      />,
    )

    expect(
      await screen.findByText('SYNTHETIC · LOCAL ANVIL'),
    ).toBeInTheDocument()
    expect(screen.getByText('로컬 개발 전용')).toBeInTheDocument()
    expect(screen.getByText('Local Anvil')).toBeInTheDocument()
    expect(screen.getByText(SUBMIT_TX).closest('a')).toBeNull()
    expect(screen.getByText(REVIEW_TX).closest('a')).toBeNull()
    expect(
      screen.getByText(/Anvil을 종료하면 로컬 체인과 함께 사라집니다/),
    ).toBeInTheDocument()
  })

  it('explains a rejected result without exposing its internal code', async () => {
    const api = createApi(snapshot('SUBMITTED'), {
      review: vi.fn(async () => snapshot('REJECTED')),
    })

    render(<SyntheticReportAttestationPanel api={api} />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: '검토 요청 및 검증',
      }),
    )

    expect(await screen.findByText('UNUSABLE')).toBeInTheDocument()
    expect(
      screen.getByText(
        '검토 기준을 통과하지 못해 이 장부는 사용할 수 없습니다.',
      ),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('REVIEW_REJECTED')
    expect(screen.getByText('반려 Tx')).toBeInTheDocument()
    expect(screen.getByText('REJECT Attestation UID')).toBeInTheDocument()
    expect(
      screen.queryByRole('radio', { name: /승인|반려/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps actions fail-closed when the server capability is disabled', async () => {
    const disabled: SyntheticReportAttestationSnapshot = {
      capability: {
        enabled: false,
        network: 'eip155:91342',
        mode: 'SYNTHETIC_TESTNET',
        explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
        reasonCode: 'SIGNER_UNAVAILABLE',
      },
      fixture,
      status: null,
      verification: null,
    }
    const api = createApi(disabled)

    render(<SyntheticReportAttestationPanel api={api} />)

    expect(
      await screen.findByText(
        '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '장부 생성 및 제출' }),
    ).toBeDisabled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('allows only the safe read-only retry for a confirmed review receipt', async () => {
    const reconciliation: SyntheticReportAttestationSnapshot = {
      capability,
      fixture,
      status: {
        lifecycle: 'RECONCILIATION_REQUIRED',
        failureCode: 'REVIEW_RECONCILIATION_FAILED',
        reasonCode: 'REVIEW_RECONCILIATION_FAILED',
        submissionConfirmed: true,
        reviewConfirmed: true,
        submissionEvidence: {
          transactionHash: SUBMIT_TX,
          attestationUID: SUBMIT_UID,
        },
        reviewEvidence: {
          transactionHash: REVIEW_TX,
          attestationUID: REVIEW_UID,
        },
      },
      verification: null,
    }
    const api = createApi(reconciliation, {
      review: vi.fn(async () => snapshot('APPROVED')),
    })

    render(<SyntheticReportAttestationPanel api={api} />)

    expect(
      await screen.findByText(
        /요청이 증명 네트워크에 반영됐을 수 있지만/,
      ),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(
      'REVIEW_RECONCILIATION_FAILED',
    )
    const retry = await screen.findByRole('button', {
      name: '검토 요청 및 검증',
    })
    expect(retry).toBeEnabled()
    fireEvent.click(retry)
    expect(await screen.findByText('USABLE')).toBeInTheDocument()
    expect(api.review).toHaveBeenCalledTimes(1)
  })

  it('polls an asynchronous submission without issuing another POST', async () => {
    const queued: SyntheticReportAttestationSnapshot = {
      capability,
      fixture,
      status: {
        lifecycle: 'SUBMITTING',
        failureCode: null,
        reasonCode: null,
        submissionConfirmed: false,
        reviewConfirmed: false,
        submissionEvidence: null,
        reviewEvidence: null,
      },
      verification: null,
    }
    const load = vi
      .fn<SyntheticReportAttestationApi['load']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot('SUBMITTED'))
    const api = createApi(snapshot(), {
      load,
      submit: vi.fn(async () => queued),
    })

    render(
      <SyntheticReportAttestationPanel
        api={api}
        pollIntervalMs={1}
        pollTimeoutMs={100}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '장부 생성 및 제출' }),
    )

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByRole('button', { name: '장부 제출 완료' }),
    ).toBeInTheDocument()
    expect(api.submit).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('continues a pending submission without exposing a dead-end', async () => {
    const pending: SyntheticReportAttestationSnapshot = {
      capability,
      fixture,
      status: {
        lifecycle: 'PENDING',
        failureCode: null,
        reasonCode: 'RECEIPT_PENDING',
        submissionConfirmed: false,
        reviewConfirmed: false,
        submissionEvidence: null,
        reviewEvidence: null,
      },
      verification: null,
    }
    const api = createApi(pending, {
      submit: vi.fn(async () => snapshot('SUBMITTED')),
    })

    render(<SyntheticReportAttestationPanel api={api} />)

    expect(
      await screen.findByText(/증명 네트워크의 확인이 진행 중입니다/),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('RECEIPT_PENDING')
    const continuation = await screen.findByRole('button', {
      name: '제출 상태 이어서 확인',
    })
    expect(continuation).toBeEnabled()
    fireEvent.click(continuation)
    expect(
      await screen.findByRole('button', { name: '장부 제출 완료' }),
    ).toBeDisabled()
    expect(api.submit).toHaveBeenCalledTimes(1)
  })

  it('refreshes with GET only and never turns refresh into an onchain write', async () => {
    const api = createApi(snapshot('SUBMITTED'))

    render(<SyntheticReportAttestationPanel api={api} />)

    const refresh = await screen.findByRole('button', {
      name: '현재 상태 새로고침',
    })
    fireEvent.click(refresh)
    expect(
      await screen.findByText(
        '새 트랜잭션을 보내지 않고 서버와 온체인의 현재 상태를 다시 확인했습니다.',
      ),
    ).toHaveClass('is-success')
    expect(api.load).toHaveBeenCalledTimes(2)
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.review).not.toHaveBeenCalled()
  })

  it('labels manual review as pending human work, not completed verification', async () => {
    const manual: SyntheticReportAttestationSnapshot = {
      capability,
      fixture,
      status: {
        lifecycle: 'MANUAL_REVIEW',
        failureCode: null,
        reasonCode: 'MANUAL_REVIEW_REQUIRED',
        submissionConfirmed: true,
        reviewConfirmed: false,
        submissionEvidence: {
          transactionHash: SUBMIT_TX,
          attestationUID: SUBMIT_UID,
        },
        reviewEvidence: null,
      },
      verification: null,
    }

    render(
      <SyntheticReportAttestationPanel
        api={createApi(manual)}
      />,
    )

    expect(
      await screen.findByRole('button', { name: '사람 검토 대기' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: '검토 및 검증 완료' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        '자동 검토만으로 결정할 수 없어 담당자 확인이 필요합니다.',
      ),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(
      'MANUAL_REVIEW_REQUIRED',
    )
  })

  it('explains uncertain post-broadcast state without suggesting another write', async () => {
    const uncertain: SyntheticReportAttestationSnapshot = {
      capability,
      fixture,
      status: {
        lifecycle: 'RECONCILIATION_REQUIRED',
        failureCode: null,
        reasonCode: 'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
        submissionConfirmed: false,
        reviewConfirmed: false,
        submissionEvidence: null,
        reviewEvidence: null,
      },
      verification: null,
    }

    render(
      <SyntheticReportAttestationPanel
        api={createApi(uncertain)}
      />,
    )

    expect(
      await screen.findByText(
        /같은 요청을 다시 보내지 말고 ‘현재 상태 새로고침’을 눌러 주세요/,
      ),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(
      'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    )
    expect(
      screen.getByRole('button', { name: '장부 생성 및 제출' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: '현재 상태 새로고침' }),
    ).toBeEnabled()
  })
})
