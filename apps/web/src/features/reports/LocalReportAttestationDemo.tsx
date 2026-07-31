import { useEffect, useRef, useState } from 'react'
import {
  localReportAttestationApi,
  pollReportAttestationStatus,
  ReportAttestationLifecycleError,
  ReportAttestationPollingTimeoutError,
  runReportAttestationRequestWithTimeout,
  type LocalReportAttestationApi,
  type ReportAttestationLifecycle,
  type ReportAttestationStatus,
  type ReportVerification,
} from './reportAttestationApi.ts'
import {
  describeReportVerificationReason,
} from './reportAttestationPresentation.ts'

type DemoPhase =
  | 'idle'
  | 'preparing'
  | 'submitting'
  | 'reviewing'
  | 'verifying'
  | 'complete'
  | 'manual-review'
  | 'cancelled'
  | 'error'

type DemoState = Readonly<{
  phase: DemoPhase
  verification?: ReportVerification
  errorKind?: 'timeout' | 'lifecycle' | 'request'
}>

const finalReviewLifecycles = new Set<ReportAttestationLifecycle>([
  'APPROVED',
  'REJECTED',
  'MANUAL_REVIEW',
])

const failedLifecycles = new Set<ReportAttestationLifecycle>([
  'PREPARATION_FAILED',
  'SUBMISSION_FAILED',
  'REVIEW_FAILED',
])

const resumableLifecycles = new Set<ReportAttestationLifecycle>([
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'PENDING',
])

const phaseLabels: Record<DemoPhase, string> = {
  idle: '실행 전',
  preparing: '안전한 mock 장부 준비 중',
  submitting: '백엔드 Issuer 제출 중',
  reviewing: '백엔드 Reviewer 검토 중',
  verifying: '승인본 검증 중',
  complete: '검증 완료',
  'manual-review': '사람 검토 필요',
  cancelled: '실행 중단',
  error: '확인 필요',
}

const verificationExplanation = (
  verification: ReportVerification | undefined,
) => {
  if (!verification) return undefined
  if (verification.result === 'USABLE') {
    return '검토에서 승인되었고, 현재 온체인 승인본과 mock 장부의 commitment가 일치합니다.'
  }
  switch (verification.reasonCode) {
    case 'REVIEW_REJECTED':
      return '검토에서 반려되어 승인본이 만들어지지 않았으므로 이 장부는 사용할 수 없습니다.'
    case 'APPROVAL_NOT_AVAILABLE':
      return '현재 사용할 수 있는 승인 attestation이 없습니다.'
    case 'ONCHAIN_APPROVAL_NOT_USABLE':
      return '승인 기록은 있지만 ReportRegistryV1의 현재 사용 가능 조건을 충족하지 못했습니다.'
    case 'COMMITMENT_MISMATCH':
      return '현재 장부 내용으로 다시 계산한 commitment가 온체인 승인 기록과 다릅니다.'
    case 'VERIFICATION_EXECUTION_FAILED':
      return '온체인 검증 요청을 완료하지 못해 결과를 확정할 수 없습니다.'
    default:
      return '온체인 검증 조건을 충족하지 못해 이 장부를 사용할 수 없습니다.'
  }
}

const isFailed = (status: ReportAttestationStatus) =>
  failedLifecycles.has(status.lifecycle)

const isAborted = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

const unexpectedLifecycle = (lifecycle: ReportAttestationLifecycle) =>
  new ReportAttestationLifecycleError(lifecycle)

const errorKind = (error: unknown): DemoState['errorKind'] =>
  error instanceof ReportAttestationPollingTimeoutError
    ? 'timeout'
    : error instanceof ReportAttestationLifecycleError
      ? 'lifecycle'
      : 'request'

export type LocalReportAttestationDemoProps = Readonly<{
  api?: LocalReportAttestationApi
  pollIntervalMs?: number
  pollTimeoutMs?: number
  requestTimeoutMs?: number
  maxResumeAttempts?: number
}>

export function LocalReportAttestationDemo({
  api = localReportAttestationApi,
  pollIntervalMs,
  pollTimeoutMs,
  requestTimeoutMs = 15_000,
  maxResumeAttempts = 3,
}: LocalReportAttestationDemoProps) {
  const [state, setState] = useState<DemoState>({ phase: 'idle' })
  const [reportId, setReportId] = useState<string>()
  const [receiptStatus, setReceiptStatus] =
    useState<ReportAttestationStatus>()
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const resumeLimit =
    Number.isFinite(maxResumeAttempts) && maxResumeAttempts > 0
      ? Math.floor(maxResumeAttempts)
      : 3

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const updateState = (next: DemoState) => {
    if (mountedRef.current) {
      setState(next)
    }
  }

  const waitFor = (
    id: string,
    done: (status: ReportAttestationStatus) => boolean,
    signal: AbortSignal,
  ) =>
    pollReportAttestationStatus(api.getStatus, id, {
      done,
      failed: isFailed,
      signal,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
    })

  const request = <T,>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) =>
    runReportAttestationRequestWithTimeout(operation, {
      signal,
      timeoutMs: requestTimeoutMs,
    })

  const prepare = async (signal: AbortSignal) => {
    let status = await request(
      (requestSignal) => api.prepareFixture(requestSignal),
      signal,
    )
    if (mountedRef.current) {
      setReportId(status.reportId)
    }
    if (isFailed(status)) {
      throw unexpectedLifecycle(status.lifecycle)
    }
    if (status.lifecycle === 'PREPARING') {
      status = await waitFor(
        status.reportId,
        (current) => current.lifecycle !== 'PREPARING',
        signal,
      )
    }
    return status
  }

  const submit = async (
    initial: ReportAttestationStatus,
    signal: AbortSignal,
  ) => {
    if (
      initial.submissionConfirmed ||
      initial.lifecycle === 'SUBMITTED' ||
      initial.lifecycle === 'REVIEW_QUEUED' ||
      initial.lifecycle === 'REVIEWING' ||
      finalReviewLifecycles.has(initial.lifecycle)
    ) {
      return initial
    }

    updateState({ phase: 'submitting' })
    let status = initial
    let resumeAttempts = 0

    while (resumeAttempts <= resumeLimit) {
      if (isFailed(status)) {
        throw unexpectedLifecycle(status.lifecycle)
      }
      if (
        status.submissionConfirmed ||
        status.lifecycle === 'SUBMITTED' ||
        status.lifecycle === 'REVIEW_QUEUED' ||
        status.lifecycle === 'REVIEWING' ||
        finalReviewLifecycles.has(status.lifecycle)
      ) {
        return status
      }
      if (
        status.lifecycle === 'SUBMISSION_QUEUED' ||
        status.lifecycle === 'SUBMITTING'
      ) {
        status = await waitFor(
          status.reportId,
          (current) =>
            current.submissionConfirmed ||
            current.lifecycle === 'SUBMITTED' ||
            current.lifecycle === 'REVIEW_QUEUED' ||
            current.lifecycle === 'REVIEWING' ||
            resumableLifecycles.has(current.lifecycle) ||
            finalReviewLifecycles.has(current.lifecycle),
          signal,
        )
        continue
      }
      if (
        status.lifecycle === 'PREPARED' ||
        (resumableLifecycles.has(status.lifecycle) &&
          !status.submissionConfirmed)
      ) {
        if (resumeAttempts === resumeLimit) {
          throw unexpectedLifecycle(status.lifecycle)
        }
        resumeAttempts += 1
        status = await request(
          (requestSignal) => api.submit(status.reportId, requestSignal),
          signal,
        )
        continue
      }
      throw unexpectedLifecycle(status.lifecycle)
    }

    throw unexpectedLifecycle(status.lifecycle)
  }

  const review = async (
    initial: ReportAttestationStatus,
    signal: AbortSignal,
  ) => {
    if (finalReviewLifecycles.has(initial.lifecycle)) {
      return initial
    }

    updateState({ phase: 'reviewing' })
    let status = initial
    let resumeAttempts = 0

    while (resumeAttempts <= resumeLimit) {
      if (isFailed(status)) {
        throw unexpectedLifecycle(status.lifecycle)
      }
      if (finalReviewLifecycles.has(status.lifecycle)) {
        return status
      }
      if (
        status.lifecycle === 'REVIEW_QUEUED' ||
        status.lifecycle === 'REVIEWING'
      ) {
        status = await waitFor(
          status.reportId,
          (current) =>
            resumableLifecycles.has(current.lifecycle) ||
            finalReviewLifecycles.has(current.lifecycle),
          signal,
        )
        continue
      }
      if (
        status.lifecycle === 'SUBMITTED' ||
        (resumableLifecycles.has(status.lifecycle) &&
          status.submissionConfirmed)
      ) {
        if (resumeAttempts === resumeLimit) {
          throw unexpectedLifecycle(status.lifecycle)
        }
        resumeAttempts += 1
        status = await request(
          (requestSignal) => api.review(status.reportId, requestSignal),
          signal,
        )
        continue
      }
      throw unexpectedLifecycle(status.lifecycle)
    }

    throw unexpectedLifecycle(status.lifecycle)
  }

  const run = async () => {
    if (runningRef.current) {
      return
    }

    runningRef.current = true
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    setReceiptStatus(undefined)
    updateState({ phase: 'preparing' })

    try {
      const prepared = await prepare(controller.signal)
      setReceiptStatus(prepared)
      const submitted = await submit(prepared, controller.signal)
      setReceiptStatus(submitted)
      const reviewed = await review(submitted, controller.signal)
      setReceiptStatus(reviewed)
      if (reviewed.lifecycle === 'MANUAL_REVIEW') {
        updateState({ phase: 'manual-review' })
        return
      }
      updateState({ phase: 'verifying' })
      const verification = await request(
        (requestSignal) =>
          api.getVerification(reviewed.reportId, requestSignal),
        controller.signal,
      )
      updateState({ phase: 'complete', verification })
    } catch (error) {
      if (isAborted(error)) {
        updateState({ phase: 'cancelled' })
      } else {
        updateState({
          phase: 'error',
          errorKind: errorKind(error),
        })
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined
      }
      runningRef.current = false
    }
  }

  const refreshVerification = async () => {
    if (!reportId || runningRef.current) {
      return
    }

    runningRef.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    updateState({ phase: 'verifying', verification: state.verification })

    try {
      const verification = await request(
        (requestSignal) => api.getVerification(reportId, requestSignal),
        controller.signal,
      )
      updateState({ phase: 'complete', verification })
    } catch (error) {
      updateState(
        isAborted(error)
          ? { phase: 'cancelled' }
          : { phase: 'error', errorKind: errorKind(error) },
      )
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined
      }
      runningRef.current = false
    }
  }

  const busy =
    state.phase === 'preparing' ||
    state.phase === 'submitting' ||
    state.phase === 'reviewing' ||
    state.phase === 'verifying'

  return (
    <section
      className="report-attestation-demo"
      aria-labelledby="report-attestation-demo-title"
    >
      <header>
        <div>
          <span>GIWA-28 · LOCAL MOCK</span>
          <h2 id="report-attestation-demo-title">
            장부 생성부터 EAS 검증까지
          </h2>
        </div>
        <b>개발 전용</b>
      </header>
      <p>
        모든 사용자가 아래와 같은 안전한 mock 장부를 사용합니다. 내부
        contractReportId는 로그인 사용자별로 따로 만들고, 백엔드가 Issuer와
        Reviewer를 자동 실행합니다.
      </p>
      <dl className="report-attestation-demo__fixture">
        <div>
          <dt>과세연도</dt>
          <dd>2025년</dd>
        </div>
        <div>
          <dt>전체 거래</dt>
          <dd>12건</dd>
        </div>
        <div>
          <dt>완료 / 예외</dt>
          <dd>10건 / 2건</dd>
        </div>
        <div>
          <dt>표시 통화</dt>
          <dd>KRW</dd>
        </div>
        <div>
          <dt>mock 준비 상태</dt>
          <dd>{reportId ? '준비 완료' : '실행 전'}</dd>
        </div>
        <div>
          <dt>온체인 Report ID</dt>
          <dd>사용자별 자동 생성</dd>
        </div>
      </dl>
      <dl className="report-attestation-demo__status" aria-live="polite">
        <div>
          <dt>현재 단계</dt>
          <dd>{phaseLabels[state.phase]}</dd>
        </div>
        <div>
          <dt>최종 판정</dt>
          <dd
            className={
              state.phase === 'manual-review'
                ? 'is-manual-review'
                : state.verification
                  ? `is-${state.verification.result.toLowerCase()}`
                  : undefined
            }
          >
            {state.phase === 'manual-review'
              ? '사람 검토 필요'
              : state.verification?.result ?? '아직 없음'}
          </dd>
        </div>
      </dl>
      {state.verification ? (
        <section
          className="report-attestation-demo__decision"
          aria-labelledby="report-attestation-decision-title"
        >
          <div>
            <h3 id="report-attestation-decision-title">판정 근거</h3>
            <b data-result={state.verification.result}>
              {state.verification.lifecycle}
            </b>
          </div>
          <p>{verificationExplanation(state.verification)}</p>
          <dl>
            <div>
              <dt>판정 사유</dt>
              <dd>
                {describeReportVerificationReason(
                  state.verification.reasonCode,
                )}
              </dd>
            </div>
            <div>
              <dt>온체인 사용 가능</dt>
              <dd>{state.verification.result === 'USABLE' ? 'true' : 'false'}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {receiptStatus?.submissionEvidence ||
      receiptStatus?.reviewEvidence ? (
        <section
          className="report-attestation-demo__evidence"
          aria-labelledby="report-attestation-evidence-title"
        >
          <header>
            <div>
              <span>LOCAL CHAIN RECEIPTS</span>
              <h3 id="report-attestation-evidence-title">온체인 증거</h3>
            </div>
            <b>Local Anvil</b>
          </header>
          <p>
            아래 값은 실제 로컬 EVM 트랜잭션과 EAS attestation 식별자입니다.
            Anvil을 종료하면 로컬 체인과 함께 사라집니다.
          </p>
          <dl>
            {receiptStatus.submissionEvidence ? (
              <>
                <div>
                  <dt>장부 제출 Tx</dt>
                  <dd>
                    <code>
                      {receiptStatus.submissionEvidence.transactionHash}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>SUBMIT Attestation UID</dt>
                  <dd>
                    <code>
                      {receiptStatus.submissionEvidence.attestationUID}
                    </code>
                  </dd>
                </div>
              </>
            ) : null}
            {receiptStatus.reviewEvidence ? (
              <>
                <div>
                  <dt>
                    {receiptStatus.lifecycle === 'REJECTED'
                      ? '반려 Tx'
                      : '승인 Tx'}
                  </dt>
                  <dd>
                    <code>
                      {receiptStatus.reviewEvidence.transactionHash}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>
                    {receiptStatus.lifecycle === 'REJECTED'
                      ? 'REJECT Attestation UID'
                      : 'APPROVE Attestation UID'}
                  </dt>
                  <dd>
                    <code>
                      {receiptStatus.reviewEvidence.attestationUID}
                    </code>
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
      {state.phase === 'error' ? (
        <p className="report-attestation-demo__message" role="alert">
          {state.errorKind === 'timeout'
            ? '처리 시간이 초과되었습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.'
            : state.errorKind === 'lifecycle'
              ? '백엔드 증명 단계가 완료되지 않았습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.'
              : '로컬 증명 요청을 완료하지 못했습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.'}
        </p>
      ) : null}
      {state.phase === 'cancelled' ? (
        <p className="report-attestation-demo__message" role="status">
          실행을 중단했습니다. 같은 흐름을 다시 실행하면 현재 상태에서
          이어집니다.
        </p>
      ) : null}
      <div className="report-attestation-demo__actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy
            ? '자동 실행 중…'
            : state.phase === 'error' || state.phase === 'cancelled'
              ? '다시 시도'
              : '로컬 증명 자동 실행'}
        </button>
        {busy ? (
          <button
            type="button"
            className="is-secondary"
            onClick={() => controllerRef.current?.abort()}
          >
            실행 중단
          </button>
        ) : null}
        {reportId && state.verification && !busy ? (
          <button
            type="button"
            className="is-secondary"
            onClick={() => void refreshVerification()}
          >
            검증 새로고침
          </button>
        ) : null}
      </div>
    </section>
  )
}
