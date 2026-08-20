import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ReportAttestationControl } from './ReportAttestationControl.tsx'
import type {
  LocalReportAttestationApi,
  ReportAttestationEligibility,
  ReportAttestationStatus,
  ReportVerification,
} from './reportAttestationApi.ts'

const reportId = `tax-report-v2:${'a'.repeat(64)}`
const transactionHash = `0x${'1'.repeat(64)}`
const attestationUID = `0x${'2'.repeat(64)}`
const status = (
  lifecycle: ReportAttestationStatus['lifecycle'],
): ReportAttestationStatus => ({
  reportId,
  lifecycle,
  failureCode: null,
  submissionConfirmed: lifecycle === 'APPROVED',
  reviewConfirmed: lifecycle === 'APPROVED',
  submissionEvidence: lifecycle === 'APPROVED'
    ? { transactionHash, attestationUID }
    : null,
  reviewEvidence: null,
})

const eligibility = (eligible: boolean): ReportAttestationEligibility => ({
  reportId,
  eligible,
  checks: [
    'CURRENT_REPORT',
    'CALCULATION_RESULT',
    'EVIDENCE_PACK',
    'CURRENT_LEDGER',
    'CURRENT_SOURCE_COVERAGE',
    'ONCHAIN_RUNTIME',
  ].map((code) => ({
    code: code as ReportAttestationEligibility['checks'][number]['code'],
    status: eligible || code === 'ONCHAIN_RUNTIME' ? 'PASSED' : 'FAILED',
  })),
})

describe('ReportAttestationControl', () => {
  it('uses only the generic product prepare, submit, status, and verification API', async () => {
    const api: LocalReportAttestationApi = {
      getEligibility: vi.fn(async () => eligibility(true)),
      prepare: vi.fn(async () => status('PREPARED')),
      prepareFixture: vi.fn(async () => status('PREPARED')),
      submit: vi.fn(async () => status('APPROVED')),
      review: vi.fn(async () => status('APPROVED')),
      getStatus: vi.fn(async () => status('PREPARED')),
      getVerification: vi.fn(async (): Promise<ReportVerification> => ({
        lifecycle: 'APPROVED', result: 'USABLE', reasonCode: null,
      })),
    }

    render(
      <ReportAttestationControl
        reportId={reportId}
        api={api}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '증빙 상태 확인' }))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '변경 불가 증명 대상 확인' })).toBeInTheDocument()
    expect(screen.getByText('GIWA 테스트 네트워크')).toBeInTheDocument()
    expect(screen.getByText('증명 범위')).toBeInTheDocument()
    expect(screen.getAllByText('현재 장부')).toHaveLength(2)
    expect(screen.getByText('현재 계산 결과와 원본 근거')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '변경 불가 증명 제출' }))
    expect(await screen.findByText('검증 가능한 승인본')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '블록체인 기록 완료' })).toBeInTheDocument()
    expect(screen.getAllByText('원본 근거 보관됨')).toHaveLength(2)
    expect(screen.queryByText(transactionHash)).not.toBeInTheDocument()
    expect(screen.queryByText(attestationUID)).not.toBeInTheDocument()
    expect(api.prepare).toHaveBeenCalledWith(reportId, expect.any(AbortSignal))
    expect(api.getEligibility).toHaveBeenCalledWith(
      reportId,
      expect.any(AbortSignal),
    )
    expect(api.submit).toHaveBeenCalledWith(reportId, expect.any(AbortSignal))
    expect(api.getVerification).toHaveBeenCalledWith(
      reportId,
      expect.any(AbortSignal),
    )
    expect(api.prepareFixture).not.toHaveBeenCalled()
    expect(api.review).not.toHaveBeenCalled()
  })

  it('reads immutable attestation evidence for an ineligible historical report without allowing a new write', async () => {
    const api: LocalReportAttestationApi = {
      getEligibility: vi.fn(async () => eligibility(false)),
      prepare: vi.fn(async () => status('PREPARED')),
      prepareFixture: vi.fn(async () => status('PREPARED')),
      submit: vi.fn(async () => status('APPROVED')),
      review: vi.fn(async () => status('APPROVED')),
      getStatus: vi.fn(async () => status('APPROVED')),
      getVerification: vi.fn(async (): Promise<ReportVerification> => ({
        lifecycle: 'APPROVED', result: 'USABLE', reasonCode: null,
      })),
    }

    render(
      <ReportAttestationControl
        reportId={reportId}
        api={api}
      />,
    )

    expect(await screen.findByText('검증 가능한 승인본')).toBeInTheDocument()
    expect(screen.getByText('원본 근거 보관됨')).toBeInTheDocument()
    expect(screen.queryByText(transactionHash)).not.toBeInTheDocument()
    expect(screen.queryByText(attestationUID)).not.toBeInTheDocument()
    expect(screen.getByText('이 장부에 남은 블록체인 증명을 확인합니다.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '현재 장부 확인 필요' })).toBeDisabled()
    expect(screen.getAllByText('확인 필요')).toHaveLength(5)
    expect(screen.getByText('블록체인 연결')).toBeInTheDocument()
    expect(api.getStatus).toHaveBeenCalledWith(reportId, expect.any(AbortSignal))
    expect(api.getVerification).toHaveBeenCalledWith(
      reportId,
      expect.any(AbortSignal),
    )
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.prepareFixture).not.toHaveBeenCalled()
    expect(api.review).not.toHaveBeenCalled()
  })
})
