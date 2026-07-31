import { useEffect, useRef, useState } from 'react'

import {
  ReportAttestationLifecycleError,
  ReportAttestationPollingTimeoutError,
  runReportAttestationRequestWithTimeout,
  type ReportAttestationLifecycle,
  type ReportVerification,
} from './reportAttestationApi.ts'
import {
  giwaExplorerTransactionUrl,
  syntheticReportAttestationApi,
  type SyntheticReportAttestationApi,
  type SyntheticReportAttestationSnapshot,
} from './syntheticReportAttestationApi.ts'
import {
  describeReportAttestationCapabilityReason,
  describeReportAttestationStatusReason,
  describeReportVerificationReason,
} from './reportAttestationPresentation.ts'

type Action =
  | 'loading'
  | 'idle'
  | 'refreshing'
  | 'submitting'
  | 'reviewing'
  | 'error'

const finalReviewLifecycles = new Set<ReportAttestationLifecycle>([
  'APPROVED',
  'REJECTED',
  'MANUAL_REVIEW',
])

const failureLifecycles = new Set<ReportAttestationLifecycle>([
  'PREPARATION_FAILED',
  'SUBMISSION_FAILED',
  'REVIEW_FAILED',
])

const lifecycleLabels: Record<ReportAttestationLifecycle, string> = {
  PREPARING: '장부 준비 중',
  PREPARED: '제출 준비 완료',
  PREPARATION_FAILED: '장부 준비 실패',
  SUBMISSION_QUEUED: '제출 대기 중',
  SUBMITTING: 'Issuer 제출 중',
  SUBMITTED: '제출 완료',
  SUBMISSION_FAILED: '제출 실패',
  REVIEW_QUEUED: '검토 대기 중',
  REVIEWING: 'Reviewer 검토 중',
  APPROVED: '승인 완료',
  REJECTED: '반려 완료',
  PENDING: '온체인 확인 대기',
  MANUAL_REVIEW: '사람 검토 필요',
  RETRY_REQUIRED: '재시도 필요',
  RECONCILIATION_REQUIRED: '온체인 상태 재확인 필요',
  REVIEW_FAILED: '검토 실패',
}

const verificationExplanation = (
  verification: ReportVerification | null,
) => {
  if (!verification) {
    return 'Reviewer 결정과 ReportRegistryV1의 현재 상태를 확인하면 최종 판정이 표시됩니다.'
  }
  if (verification.result === 'USABLE') {
    return 'Reviewer가 승인했고, 합성 장부의 commitment와 현재 온체인 승인본이 일치해 사용할 수 있습니다.'
  }

  switch (verification.reasonCode) {
    case 'REVIEW_REJECTED':
      return 'Reviewer가 반려해 승인본이 만들어지지 않았으므로 사용할 수 없습니다.'
    case 'APPROVAL_NOT_AVAILABLE':
      return '현재 사용할 수 있는 승인 attestation이 없습니다.'
    case 'ONCHAIN_APPROVAL_NOT_USABLE':
      return '승인 기록은 있지만 ReportRegistryV1의 현재 사용 가능 조건을 충족하지 못했습니다.'
    case 'COMMITMENT_MISMATCH':
      return '합성 장부에서 다시 계산한 commitment와 온체인 승인 기록이 일치하지 않습니다.'
    case 'VERIFICATION_EXECUTION_FAILED':
      return '온체인 검증을 완료하지 못해 사용할 수 있는 장부로 확정하지 않았습니다.'
    default:
      return '온체인 사용 가능 조건을 충족하지 못해 이 장부를 사용할 수 없습니다.'
  }
}

const abortError = () =>
  new DOMException('The operation was aborted.', 'AbortError')

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let timeout: number | undefined
    const cleanup = () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    timeout = window.setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const isAborted = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

export type SyntheticReportAttestationPanelProps = Readonly<{
  api?: SyntheticReportAttestationApi
  pollIntervalMs?: number
  pollTimeoutMs?: number
  requestTimeoutMs?: number
}>

export function SyntheticReportAttestationPanel({
  api = syntheticReportAttestationApi,
  pollIntervalMs = 500,
  pollTimeoutMs = 120_000,
  requestTimeoutMs = 20_000,
}: SyntheticReportAttestationPanelProps) {
  const [snapshot, setSnapshot] =
    useState<SyntheticReportAttestationSnapshot>()
  const [action, setAction] = useState<Action>('loading')
  const [message, setMessage] = useState<string>()
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()
    controllerRef.current = controller

    void runReportAttestationRequestWithTimeout(
      (signal) => api.load(signal),
      { signal: controller.signal, timeoutMs: requestTimeoutMs },
    )
      .then((loaded) => {
        if (!mountedRef.current) return
        setSnapshot(loaded)
        setAction('idle')
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || isAborted(error)) return
        setMessage(
          error instanceof ReportAttestationPollingTimeoutError
            ? '초기 상태 조회 시간이 초과되었습니다. 잠시 후 다시 열어 주세요.'
            : '합성 장부 증명 상태를 불러오지 못했습니다.',
        )
        setAction('error')
      })

    return () => {
      mountedRef.current = false
      controller.abort()
    }
  }, [api, requestTimeoutMs])

  const request = (
    operation: (signal: AbortSignal) =>
      Promise<SyntheticReportAttestationSnapshot>,
    signal: AbortSignal,
  ) =>
    runReportAttestationRequestWithTimeout(operation, {
      signal,
      timeoutMs: requestTimeoutMs,
    })

  const poll = async (
    initial: SyntheticReportAttestationSnapshot,
    done: (current: SyntheticReportAttestationSnapshot) => boolean,
    signal: AbortSignal,
  ) => {
    if (done(initial)) return initial

    const deadline = Date.now() + Math.max(1, pollTimeoutMs)
    let current = initial
    while (Date.now() < deadline) {
      await wait(Math.max(1, pollIntervalMs), signal)
      current = await request(
        (requestSignal) => api.load(requestSignal),
        signal,
      )
      if (mountedRef.current) setSnapshot(current)

      if (
        current.status &&
        failureLifecycles.has(current.status.lifecycle)
      ) {
        throw new ReportAttestationLifecycleError(
          current.status.lifecycle,
        )
      }
      if (done(current)) return current
    }

    throw new ReportAttestationPollingTimeoutError()
  }

  const perform = async (
    nextAction: Extract<Action, 'submitting' | 'reviewing'>,
  ) => {
    if (runningRef.current || !snapshot?.capability.enabled) return

    runningRef.current = true
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    setAction(nextAction)
    setMessage(undefined)

    try {
      const requested = await request(
        (signal) =>
          nextAction === 'submitting'
            ? api.submit(signal)
            : api.review(signal),
        controller.signal,
      )
      if (mountedRef.current) setSnapshot(requested)

      const completed = await poll(
        requested,
        nextAction === 'submitting'
          ? (current) => current.status?.submissionConfirmed === true
          : (current) => {
              const lifecycle = current.status?.lifecycle
              if (!lifecycle || !finalReviewLifecycles.has(lifecycle)) {
                return false
              }
              return lifecycle === 'MANUAL_REVIEW' ||
                current.verification !== null
            },
        controller.signal,
      )

      if (mountedRef.current) {
        setSnapshot(completed)
        setAction('idle')
        setMessage(
          nextAction === 'submitting'
            ? 'SUBMIT attestation이 확정되었습니다. 이제 고정 합성 테스트 정책 검토를 요청할 수 있습니다.'
            : completed.status?.lifecycle === 'MANUAL_REVIEW'
              ? '합성 테스트 정책 검토가 사람 확인이 필요한 예외로 분류됐습니다.'
              : 'Reviewer 결정과 온체인 사용 가능 여부를 확인했습니다.',
        )
      }
    } catch (error) {
      if (!mountedRef.current || isAborted(error)) return
      setAction('error')
      setMessage(
        error instanceof ReportAttestationPollingTimeoutError
          ? '온체인 확정에 시간이 더 필요합니다. 쓰기를 다시 보내지 말고 현재 상태를 새로고침해 확인해 주세요.'
          : error instanceof ReportAttestationLifecycleError
            ? '온체인 증명 단계가 확정 실패했습니다. 운영자 확인이 필요합니다.'
            : '증명 요청 결과를 확인하지 못했습니다. 현재 상태를 새로고침하고, 문제가 계속되면 운영자에게 알려 주세요.',
      )
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined
      }
      runningRef.current = false
    }
  }

  const refresh = async () => {
    if (runningRef.current) return

    runningRef.current = true
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    setAction('refreshing')
    setMessage(undefined)
    try {
      const current = await request(
        (signal) => api.load(signal),
        controller.signal,
      )
      if (!mountedRef.current) return
      setSnapshot(current)
      setAction('idle')
      setMessage(
        '새 트랜잭션을 보내지 않고 서버와 온체인의 현재 상태를 다시 확인했습니다.',
      )
    } catch (error) {
      if (!mountedRef.current || isAborted(error)) return
      setAction('error')
      setMessage(
        '현재 상태를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.',
      )
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined
      }
      runningRef.current = false
    }
  }

  const status = snapshot?.status
  const verification = snapshot?.verification ?? null
  const capability = snapshot?.capability
  const fixture = snapshot?.fixture
  const localFixture =
    import.meta.env.DEV &&
    import.meta.env.VITE_GIWA28_LOCAL_DEMO === 'true' &&
    capability?.mode === 'LOCAL_ANVIL'
  const executionNetworkLabel = localFixture
    ? '로컬 Anvil'
    : 'GIWA Sepolia'
  const busy =
    action === 'refreshing' ||
    action === 'submitting' ||
    action === 'reviewing'
  const reviewComplete =
    status !== null &&
    status !== undefined &&
    finalReviewLifecycles.has(status.lifecycle)
  const canSubmit =
    capability?.enabled === true &&
    (status === null ||
      status === undefined ||
      status.lifecycle === 'PREPARED' ||
      status.lifecycle === 'PREPARATION_FAILED' ||
      (status.lifecycle === 'PENDING' &&
        status.submissionConfirmed !== true) ||
      (status.lifecycle === 'RETRY_REQUIRED' &&
        status.submissionConfirmed !== true)) &&
    !busy
  const canReview =
    capability?.enabled === true &&
    status?.submissionConfirmed === true &&
    (status.lifecycle === 'SUBMITTED' ||
      status.lifecycle === 'PENDING' ||
      status.lifecycle === 'RETRY_REQUIRED' ||
      (status.lifecycle === 'RECONCILIATION_REQUIRED' &&
        status.reviewConfirmed === true &&
        status.failureCode ===
          'REVIEW_RECONCILIATION_FAILED')) &&
    !reviewComplete &&
    !busy
  const phaseLabel =
    action === 'loading'
      ? '상태 확인 중'
      : action === 'refreshing'
        ? '현재 상태 다시 확인 중'
        : action === 'submitting'
          ? `Issuer가 ${executionNetworkLabel}에 제출 중`
          : action === 'reviewing'
            ? 'Reviewer가 검토하고 온체인 검증 중'
            : status
              ? lifecycleLabels[status.lifecycle]
              : '실행 전'

  return (
    <section
      className="report-attestation-demo report-attestation-demo--testnet"
      aria-labelledby="synthetic-report-attestation-title"
    >
      <header>
        <div>
          <span>
            {localFixture
              ? 'SYNTHETIC · LOCAL ANVIL'
              : 'SYNTHETIC · GIWA SEPOLIA TESTNET'}
          </span>
          <h2 id="synthetic-report-attestation-title">
            합성 장부 온체인 증명
          </h2>
        </div>
        <b>{localFixture ? '로컬 개발 전용' : '테스트넷 전용'}</b>
      </header>
      <p>
        실제 세금 보고서가 아니라 GIWA-28 흐름을 확인하기 위한 안전한 합성
        데이터입니다. 모든 계정에 같은 내용이 보이지만 증명 진행 상태는
        로그인 계정별로 분리됩니다.
      </p>

      {fixture ? (
        <dl className="report-attestation-demo__fixture">
          <div>
            <dt>과세연도</dt>
            <dd>{fixture.taxYear}년</dd>
          </div>
          <div>
            <dt>전체 거래</dt>
            <dd>{fixture.transactionCount}건</dd>
          </div>
          <div>
            <dt>완료 / 예외</dt>
            <dd>
              {fixture.completeCount}건 / {fixture.exceptionCount}건
            </dd>
          </div>
          <div>
            <dt>표시 통화</dt>
            <dd>{fixture.denomination}</dd>
          </div>
        </dl>
      ) : null}

      <ol className="report-attestation-demo__steps">
        <li data-state={status?.submissionConfirmed ? 'complete' : 'current'}>
          <b>1</b>
          <span>
            <strong>장부 생성 및 제출</strong>
            <small>백엔드 Issuer가 SUBMIT attestation을 기록합니다.</small>
          </span>
        </li>
        <li
          data-state={
            reviewComplete
              ? 'complete'
              : status?.submissionConfirmed
                ? 'current'
                : 'waiting'
          }
        >
          <b>2</b>
          <span>
            <strong>검토 요청 및 검증</strong>
            <small>
              고정 합성 테스트 정책으로 Reviewer 승인을 기록한 뒤
              ReportConsumer의 사용 가능 여부를 확인합니다.
            </small>
          </span>
        </li>
      </ol>

      <dl className="report-attestation-demo__status" aria-live="polite">
        <div>
          <dt>현재 단계</dt>
          <dd>{phaseLabel}</dd>
        </div>
        <div>
          <dt>최종 판정</dt>
          <dd
            className={
              verification
                ? `is-${verification.result.toLowerCase()}`
                : status?.lifecycle === 'MANUAL_REVIEW'
                  ? 'is-manual-review'
                  : undefined
            }
          >
            {verification?.result ??
              (status?.lifecycle === 'MANUAL_REVIEW'
                ? '사람 검토 필요'
                : '아직 없음')}
          </dd>
        </div>
        {status?.reasonCode ? (
          <div>
            <dt>현재 사유</dt>
            <dd>
              {describeReportAttestationStatusReason(
                status.reasonCode,
              )}
            </dd>
          </div>
        ) : null}
      </dl>

      {capability && !capability.enabled ? (
        <p className="report-attestation-demo__capability" role="status">
          {describeReportAttestationCapabilityReason(
            capability.reasonCode,
          )}
        </p>
      ) : null}

      {verification ? (
        <section
          className="report-attestation-demo__decision"
          aria-labelledby="synthetic-report-decision-title"
        >
          <div>
            <h3 id="synthetic-report-decision-title">판정 근거</h3>
            <b data-result={verification.result}>
              {verification.lifecycle}
            </b>
          </div>
          <p>{verificationExplanation(verification)}</p>
          <dl>
            <div>
              <dt>판정 사유</dt>
              <dd>
                {describeReportVerificationReason(
                  verification.reasonCode,
                )}
              </dd>
            </div>
            <div>
              <dt>온체인 사용 가능</dt>
              <dd>{verification.result === 'USABLE' ? 'true' : 'false'}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {status?.submissionEvidence || status?.reviewEvidence ? (
        <section
          className="report-attestation-demo__evidence"
          aria-labelledby="synthetic-report-evidence-title"
        >
          <header>
            <div>
              <span>
                {localFixture
                  ? 'LOCAL ANVIL RECEIPTS'
                  : 'GIWA SEPOLIA RECEIPTS'}
              </span>
              <h3 id="synthetic-report-evidence-title">온체인 증거</h3>
            </div>
            <b>{localFixture ? 'Local Anvil' : 'GIWA Explorer'}</b>
          </header>
          <p>
            {localFixture
              ? '아래 값은 실제 로컬 EVM 트랜잭션과 EAS attestation 식별자입니다. Anvil을 종료하면 로컬 체인과 함께 사라집니다.'
              : '트랜잭션 해시와 Attestation UID로 제출·검토 기록을 직접 확인할 수 있습니다.'}
          </p>
          <dl>
            {status.submissionEvidence ? (
              <>
                <div>
                  <dt>장부 제출 Tx</dt>
                  <dd>
                    {capability?.explorerBaseUrl ? (
                      <a
                        href={giwaExplorerTransactionUrl(
                          status.submissionEvidence.transactionHash,
                          capability.explorerBaseUrl,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>
                          {status.submissionEvidence.transactionHash}
                        </code>
                      </a>
                    ) : (
                      <code>
                        {status.submissionEvidence.transactionHash}
                      </code>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>SUBMIT Attestation UID</dt>
                  <dd>
                    <code>
                      {status.submissionEvidence.attestationUID}
                    </code>
                  </dd>
                </div>
              </>
            ) : null}
            {status.reviewEvidence ? (
              <>
                <div>
                  <dt>
                    {status.lifecycle === 'REJECTED' ? '반려 Tx' : '승인 Tx'}
                  </dt>
                  <dd>
                    {capability?.explorerBaseUrl ? (
                      <a
                        href={giwaExplorerTransactionUrl(
                          status.reviewEvidence.transactionHash,
                          capability.explorerBaseUrl,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>
                          {status.reviewEvidence.transactionHash}
                        </code>
                      </a>
                    ) : (
                      <code>{status.reviewEvidence.transactionHash}</code>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    {status.lifecycle === 'REJECTED'
                      ? 'REJECT Attestation UID'
                      : 'APPROVE Attestation UID'}
                  </dt>
                  <dd>
                    <code>{status.reviewEvidence.attestationUID}</code>
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      {message ? (
        <p
          className={`report-attestation-demo__message ${
            action === 'error' ? 'is-error' : 'is-success'
          }`}
          role={action === 'error' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}

      <div className="report-attestation-demo__actions">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void perform('submitting')}
        >
          {action === 'submitting'
            ? '제출 중…'
            : status?.submissionConfirmed
              ? '장부 제출 완료'
              : status?.lifecycle === 'PENDING' ||
                  status?.lifecycle === 'RETRY_REQUIRED'
                ? '제출 상태 이어서 확인'
                : '장부 생성 및 제출'}
        </button>
        <button
          type="button"
          className="is-secondary"
          disabled={!canReview}
          onClick={() => void perform('reviewing')}
        >
          {action === 'reviewing'
            ? '검토 및 검증 중…'
            : status?.lifecycle === 'MANUAL_REVIEW'
              ? '사람 검토 대기'
              : reviewComplete
                ? '검토 및 검증 완료'
                : '검토 요청 및 검증'}
        </button>
        <button
          type="button"
          className="is-secondary"
          disabled={busy || action === 'loading'}
          onClick={() => void refresh()}
        >
          {action === 'refreshing'
            ? '현재 상태 확인 중…'
            : '현재 상태 새로고침'}
        </button>
      </div>
    </section>
  )
}
