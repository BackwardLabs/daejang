const refreshWithoutResubmitting =
  '요청이 증명 네트워크에 반영됐을 수 있지만 최종 확인을 마치지 못했습니다. 같은 요청을 다시 보내지 말고 ‘현재 상태 새로고침’을 눌러 주세요.'

const waitForConfirmation =
  '증명 네트워크의 확인이 진행 중입니다. 잠시 후 ‘현재 상태 새로고침’을 눌러 주세요.'

const refreshRecordedState =
  '이미 기록된 상태와 현재 요청이 일치하지 않습니다. 같은 요청을 다시 보내지 말고 ‘현재 상태 새로고침’을 눌러 주세요.'

const statusReasonMessages: Readonly<Record<string, string>> = {
  BROADCAST_OUTCOME_UNKNOWN: refreshWithoutResubmitting,
  RECEIPT_OR_POST_STATE_NOT_VERIFIED: refreshWithoutResubmitting,
  POST_BROADCAST_RESULT_NOT_CONFIRMED: refreshWithoutResubmitting,
  OPERATION_CONFIRMATION_NOT_PERSISTED: refreshWithoutResubmitting,
  PROCESS_RESTART_REQUIRES_RECONCILIATION: refreshWithoutResubmitting,
  INTERRUPTED_WRITE_REQUIRES_RECONCILIATION: refreshWithoutResubmitting,
  REVIEW_RECONCILIATION_FAILED: refreshWithoutResubmitting,
  RECEIPT_PENDING: waitForConfirmation,
  MINIMUM_CONFIRMATIONS_NOT_REACHED: waitForConfirmation,
  DECISION_BLOCK_NOT_READY: waitForConfirmation,
  REPORT_PENDING_REVIEW:
    '장부 제출 기록이 검토를 기다리고 있습니다. ‘현재 상태 새로고침’을 눌러 주세요.',
  SUBMIT_ALREADY_ONCHAIN: refreshRecordedState,
  DECISION_ALREADY_ONCHAIN: refreshRecordedState,
  REPORT_REVISION_STATE_MISMATCH: refreshRecordedState,
  SUBMISSION_STATE_MISMATCH: refreshRecordedState,
  PENDING_SUBMISSION_MISMATCH: refreshRecordedState,
  SIMULATION_FAILED:
    '제출 전 확인을 완료하지 못해 요청을 보내지 않았습니다. 잠시 후 다시 시도해 주세요.',
  INTERRUPTED_BEFORE_BROADCAST:
    '제출 전에 처리가 중단되어 요청을 보내지 않았습니다. 잠시 후 다시 시도해 주세요.',
  PREPARATION_EXECUTION_FAILED:
    '장부 제출 준비를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  PREPARATION_RESULT_REJECTED:
    '장부가 제출 조건을 충족하지 못했습니다. 장부 내용을 확인한 뒤 다시 시도해 주세요.',
  ISSUER_EXECUTION_FAILED:
    '장부 제출을 완료하지 못했습니다. 현재 상태를 새로고침한 뒤 다시 시도해 주세요.',
  ISSUER_RESULT_REJECTED:
    '장부 제출 요청이 처리되지 않았습니다. 현재 상태를 새로고침한 뒤 다시 시도해 주세요.',
  REVIEWER_EXECUTION_FAILED:
    '검토 결과를 기록하지 못했습니다. 현재 상태를 새로고침한 뒤 다시 시도해 주세요.',
  REVIEWER_RESULT_REJECTED:
    '검토 결과가 처리되지 않았습니다. 현재 상태를 새로고침한 뒤 다시 시도해 주세요.',
  REVIEW_OUTCOME_MISMATCH:
    '검토 결과와 저장된 상태가 일치하지 않아 처리를 중단했습니다. 운영자 확인이 필요합니다.',
  RUNTIME_RESULT_BINDING_MISMATCH:
    '요청 결과와 장부 정보가 일치하지 않아 처리를 중단했습니다. 운영자 확인이 필요합니다.',
  RUNTIME_CLOSED:
    '처리 중 서버 연결이 중단되었습니다. 현재 상태를 새로고침해 확인해 주세요.',
  PROCESS_INTERRUPTED:
    '처리 중 서버 연결이 중단되었습니다. 현재 상태를 새로고침해 확인해 주세요.',
  MANUAL_REVIEW_REQUIRED:
    '자동 검토만으로 결정할 수 없어 담당자 확인이 필요합니다.',
  HUMAN_DECISION_REQUIRED:
    '자동 검토만으로 결정할 수 없어 담당자 확인이 필요합니다.',
  NEEDS_HUMAN_REVIEW:
    '자동 검토만으로 결정할 수 없어 담당자 확인이 필요합니다.',
  LOCAL_FIXTURE_UNCERTAIN:
    '자동 검토만으로 결정할 수 없어 담당자 확인이 필요합니다.',
  AUTOMATED_POLICY_PASS: '자동 검토 조건을 통과했습니다.',
  SYNTHETIC_POLICY_PASS: '자동 검토 조건을 통과했습니다.',
}

const capabilityReasonMessages: Readonly<Record<string, string>> = {
  NOT_CONFIGURED:
    '현재 증명 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.',
  WRITER_NOT_CONFIGURED:
    '현재 증명 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.',
  DEPLOYMENT_NOT_CONFIGURED:
    '현재 증명 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.',
  RPC_UNAVAILABLE:
    '현재 증명 네트워크에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  SIGNER_UNAVAILABLE:
    '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
  SIGNER_FILE_UNAVAILABLE:
    '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
  SIGNER_FILE_PERMISSIONS:
    '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
  SIGNER_FILE_INVALID:
    '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
  SIGNER_KEYSTORE_DECRYPTION_FAILED:
    '현재 증명 요청을 처리할 수 없습니다. 잠시 후 다시 확인해 주세요.',
  ROLE_MISMATCH:
    '증명 처리 권한을 확인하는 중입니다. 현재 요청은 진행할 수 없습니다.',
  STORE_UNAVAILABLE:
    '증명 진행 상태를 안전하게 저장할 수 없어 요청을 중단했습니다. 잠시 후 다시 확인해 주세요.',
  GIWA_CONTRACTS_MODULE_UNAVAILABLE:
    '현재 증명 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.',
  GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE:
    '현재 증명 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.',
}

const verificationReasonMessages: Readonly<Record<string, string>> = {
  REVIEW_REJECTED:
    '검토 기준을 통과하지 못해 이 장부는 사용할 수 없습니다.',
  APPROVAL_NOT_AVAILABLE:
    '현재 사용할 수 있도록 승인된 장부가 없습니다.',
  ONCHAIN_APPROVAL_NOT_USABLE:
    '승인 기록은 있지만 현재 사용 조건을 충족하지 못했습니다.',
  COMMITMENT_MISMATCH:
    '현재 장부 내용과 승인 당시 기록이 일치하지 않아 사용할 수 없습니다.',
  PREPARED_REPORT_MISMATCH:
    '현재 장부 내용과 승인 당시 기록이 일치하지 않아 사용할 수 없습니다.',
  SNAPSHOT_PROVENANCE_MISMATCH:
    '조회한 증거의 출처를 확인할 수 없어 이 장부를 사용할 수 없습니다.',
  VERIFICATION_EXECUTION_FAILED:
    '검증을 완료하지 못해 사용할 수 있는 장부로 확정하지 않았습니다. 잠시 후 다시 확인해 주세요.',
  VERIFY_FAILED:
    '검증을 완료하지 못해 사용할 수 있는 장부로 확정하지 않았습니다. 잠시 후 다시 확인해 주세요.',
}

const unavailableApprovalReasons = new Set([
  'REPORT_NOT_FOUND',
  'APPROVAL_NOT_FOUND',
  'SUBMISSION_NOT_FOUND',
  'NOT_ACTIVE_UID',
])

const invalidApprovalReasons = new Set([
  'REPORT_SUSPENDED',
  'APPROVAL_REVOKED',
  'APPROVAL_EXPIRED',
  'SUBMISSION_REVOKED',
  'SUBMISSION_EXPIRED',
])

const invalidRecordFormatReasons = new Set([
  'SCHEMA_UNBOUND',
  'APPROVAL_SCHEMA_MISMATCH',
  'APPROVAL_DATA_INVALID',
  'APPROVAL_ACTION_MISMATCH',
  'SUBMISSION_SCHEMA_MISMATCH',
  'SUBMISSION_DATA_INVALID',
  'SUBMISSION_ACTION_MISMATCH',
  'ENVELOPE_POLICY_MISMATCH',
])

const invalidAuthorityReasons = new Set([
  'SUBMISSION_ATTESTER_MISMATCH',
  'APPROVAL_ATTESTER_MISMATCH',
  'REGISTRY_ISSUER_MISMATCH',
  'ROLE_SEPARATION_VIOLATION',
])

const recordMismatchReasons = new Set([
  'SNAPSHOT_ID_MISMATCH',
  'EVIDENCE_SCHEMA_MISMATCH',
  'RELATION_MISMATCH',
  'SUBMISSION_UID_MISMATCH',
  'SUBMISSION_REF_UID_MISMATCH',
  'SUBMISSION_ENVELOPE_MISMATCH',
  'SUBMISSION_EXPIRATION_MISMATCH',
  'SUBMISSION_DATA_MISMATCH',
  'APPROVAL_UID_MISMATCH',
  'APPROVAL_REF_UID_MISMATCH',
  'APPROVAL_ENVELOPE_MISMATCH',
  'APPROVAL_EXPIRATION_MISMATCH',
  'APPROVAL_DATA_MISMATCH',
  'REGISTRY_REPORT_ID_MISMATCH',
  'REGISTRY_ACTIVE_UID_MISMATCH',
])

export const describeReportAttestationStatusReason = (
  reasonCode: string,
) =>
  statusReasonMessages[reasonCode] ??
  '증명 처리 상태를 확인하지 못했습니다. 같은 요청을 반복하지 말고 ‘현재 상태 새로고침’을 눌러 주세요.'

export const describeReportAttestationCapabilityReason = (
  reasonCode: string,
) =>
  capabilityReasonMessages[reasonCode] ??
  '현재 증명 기능을 사용할 수 없습니다. 잠시 후 다시 확인해 주세요.'

export const describeReportVerificationReason = (
  reasonCode: string | null,
) => {
  if (reasonCode === null) {
    return '승인 조건을 모두 충족했습니다.'
  }
  if (verificationReasonMessages[reasonCode]) {
    return verificationReasonMessages[reasonCode]
  }
  if (unavailableApprovalReasons.has(reasonCode)) {
    return '현재 사용할 수 있는 승인 기록이 없습니다.'
  }
  if (invalidApprovalReasons.has(reasonCode)) {
    return '승인 기록이 현재 유효하지 않아 이 장부를 사용할 수 없습니다.'
  }
  if (invalidRecordFormatReasons.has(reasonCode)) {
    return '증명 기록의 형식 또는 적용 기준이 올바르지 않아 이 장부를 사용할 수 없습니다.'
  }
  if (invalidAuthorityReasons.has(reasonCode)) {
    return '발행·검토 권한 정보가 일치하지 않아 이 장부를 사용할 수 없습니다.'
  }
  if (recordMismatchReasons.has(reasonCode)) {
    return '장부 내용과 증명 기록이 일치하지 않아 이 장부를 사용할 수 없습니다.'
  }
  return '현재 사용 조건을 충족하지 못해 이 장부를 사용할 수 없습니다.'
}
