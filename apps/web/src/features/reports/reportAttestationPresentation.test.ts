import { describe, expect, it } from 'vitest'

import {
  describeReportAttestationCapabilityReason,
  describeReportAttestationStatusReason,
  describeReportVerificationReason,
} from './reportAttestationPresentation.ts'

describe('report attestation customer messages', () => {
  it('turns an uncertain broadcast result into a safe recovery action', () => {
    const message = describeReportAttestationStatusReason(
      'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    )

    expect(message).toContain('반영됐을 수 있지만')
    expect(message).toContain('같은 요청을 다시 보내지 말고')
    expect(message).toContain('현재 상태 새로고침')
    expect(message).not.toContain(
      'RECEIPT_OR_POST_STATE_NOT_VERIFIED',
    )
  })

  it('does not expose an unknown internal code to the customer', () => {
    const internalCode = 'UNEXPECTED_INTERNAL_REASON'

    expect(
      describeReportAttestationStatusReason(internalCode),
    ).not.toContain(internalCode)
    expect(
      describeReportAttestationCapabilityReason(internalCode),
    ).not.toContain(internalCode)
    expect(
      describeReportVerificationReason(internalCode),
    ).not.toContain(internalCode)
  })

  it.each([
    ['REPORT_PENDING_REVIEW', '검토를 기다리고 있습니다'],
    ['DECISION_BLOCK_NOT_READY', '확인이 진행 중입니다'],
    ['SUBMIT_ALREADY_ONCHAIN', '이미 기록된 상태'],
    ['PREPARATION_EXECUTION_FAILED', '제출 준비'],
    ['REVIEWER_EXECUTION_FAILED', '검토 결과'],
    ['HUMAN_DECISION_REQUIRED', '담당자 확인'],
  ])(
    'explains known status reason %s with customer copy',
    (reasonCode, expectedCopy) => {
      const message =
        describeReportAttestationStatusReason(reasonCode)

      expect(message).toContain(expectedCopy)
      expect(message).not.toContain(reasonCode)
    },
  )

  it.each([
    ['REPORT_NOT_FOUND', '승인 기록이 없습니다'],
    ['REPORT_SUSPENDED', '현재 유효하지 않아'],
    ['APPROVAL_DATA_INVALID', '형식 또는 적용 기준'],
    ['ROLE_SEPARATION_VIOLATION', '권한 정보'],
    ['REGISTRY_ACTIVE_UID_MISMATCH', '증명 기록이 일치하지 않아'],
    ['SNAPSHOT_PROVENANCE_MISMATCH', '증거의 출처'],
  ])(
    'explains known verification reason %s with customer copy',
    (reasonCode, expectedCopy) => {
      const message = describeReportVerificationReason(reasonCode)

      expect(message).toContain(expectedCopy)
      expect(message).not.toContain(reasonCode)
    },
  )
})
