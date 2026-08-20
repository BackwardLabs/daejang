import { useEffect, useRef, useState } from 'react'

import { ApiClientError } from '../../api/client.ts'
import {
  localReportAttestationApi,
  pollReportAttestationStatus,
  type LocalReportAttestationApi,
  type ReportAttestationEligibility,
  type ReportAttestationEligibilityCheckCode,
  type ReportAttestationStatus,
  type ReportVerification,
} from './reportAttestationApi.ts'

const failed = new Set([
  'PREPARATION_FAILED',
  'SUBMISSION_FAILED',
  'REJECTED',
  'REVIEW_FAILED',
])

const final = new Set(['APPROVED', 'REJECTED', 'MANUAL_REVIEW'])

const lifecycleLabel: Record<string, string> = {
  PREPARING: '증명 자료 준비 중',
  PREPARED: '증명 자료 준비 완료',
  SUBMISSION_QUEUED: '블록체인 기록 대기',
  SUBMITTING: '블록체인 기록 중',
  SUBMITTED: '블록체인 기록 완료',
  REVIEW_QUEUED: '검증 대기',
  REVIEWING: '검증 중',
  APPROVED: '블록체인 기록 검증 완료',
  REJECTED: '블록체인 기록 검증 반려',
  MANUAL_REVIEW: '사람 검토 필요',
  RETRY_REQUIRED: '다시 시도 필요',
  RECONCILIATION_REQUIRED: '상태 확인 필요',
  PREPARATION_FAILED: '증명 준비 실패',
  SUBMISSION_FAILED: '블록체인 기록 실패',
  REVIEW_FAILED: '블록체인 기록 검증 실패',
  PENDING: '처리 대기',
}

const eligibilityCopy: Record<
  ReportAttestationEligibilityCheckCode,
  Readonly<{ title: string; description: string }>
> = {
  CURRENT_REPORT: {
    title: '현재 장부',
    description: '지금 보고 있는 장부가 최신 계산 결과인지 확인합니다.',
  },
  CALCULATION_RESULT: {
    title: '계산 결과',
    description: '세금 계산 결과와 장부 내용이 서로 일치하는지 확인합니다.',
  },
  EVIDENCE_PACK: {
    title: '원본 근거',
    description: '장부를 만든 원본 자료와 정책 근거가 준비됐는지 확인합니다.',
  },
  CURRENT_LEDGER: {
    title: '최신 거래 반영',
    description: '현재 거래 장부가 계산 결과에 반영됐는지 확인합니다.',
  },
  CURRENT_SOURCE_COVERAGE: {
    title: '자료 범위',
    description: '제출 대상 장부에 포함된 자료 범위가 최신인지 확인합니다.',
  },
  ONCHAIN_RUNTIME: {
    title: '블록체인 연결',
    description: 'GIWA 네트워크에 증빙을 기록할 준비가 됐는지 확인합니다.',
  },
}

export function ReportAttestationControl({
  reportId,
  api = localReportAttestationApi,
}: {
  reportId: string
  api?: LocalReportAttestationApi
}) {
  const [eligibility, setEligibility] = useState<ReportAttestationEligibility>()
  const [status, setStatus] = useState<ReportAttestationStatus>()
  const [verification, setVerification] = useState<ReportVerification>()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [successOpen, setSuccessOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'running' | 'error'>(
    'loading',
  )
  const controllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setConfirmOpen(false)
    setSuccessOpen(false)
    setEligibility(undefined)
    setStatus(undefined)
    setVerification(undefined)
    setPhase('loading')
    void api
      .getEligibility(reportId, controller.signal)
      .then(async (nextEligibility) => {
        if (controller.signal.aborted) return
        setEligibility(nextEligibility)
        const value = await api
          .getStatus(reportId, controller.signal)
          .catch((error: unknown) => {
            if (error instanceof ApiClientError && error.status === 404) {
              return undefined
            }
            throw error
          })
        if (controller.signal.aborted) return
        setStatus(value)
        if (value?.lifecycle === 'APPROVED') {
          setVerification(await api.getVerification(reportId, controller.signal))
        }
        if (!controller.signal.aborted) setPhase('idle')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setPhase('error')
      })
    return () => controller.abort()
  }, [api, reportId])

  useEffect(() => {
    const controller = new AbortController()
    const interval = window.setInterval(() => {
      void api.getEligibility(reportId, controller.signal)
        .then((value) => {
          setEligibility(value)
          setPhase((current) => current === 'error' ? 'idle' : current)
        })
        .catch(() => undefined)
    }, 15_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [api, reportId])

  const start = async () => {
    if (!eligibility?.eligible || phase === 'running') return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase('running')
    setVerification(undefined)
    try {
      const latestEligibility = await api.getEligibility(
        reportId,
        controller.signal,
      )
      setEligibility(latestEligibility)
      if (!latestEligibility.eligible) {
        setPhase('idle')
        return
      }
      let next = await api.prepare(reportId, controller.signal)
      setStatus(next)
      if (next.lifecycle === 'PREPARING') {
        next = await pollReportAttestationStatus(api.getStatus, reportId, {
          done: (value) => value.lifecycle !== 'PREPARING',
          failed: (value) => failed.has(value.lifecycle),
          signal: controller.signal,
          timeoutMs: 60_000,
        })
        setStatus(next)
      }
      if (next.lifecycle === 'PREPARED') {
        next = await api.submit(reportId, controller.signal)
        setStatus(next)
      }
      if (!final.has(next.lifecycle)) {
        next = await pollReportAttestationStatus(api.getStatus, reportId, {
          done: (value) => final.has(value.lifecycle),
          failed: (value) => failed.has(value.lifecycle),
          signal: controller.signal,
          timeoutMs: 120_000,
        })
        setStatus(next)
      }
      if (next.lifecycle === 'APPROVED') {
        setVerification(await api.getVerification(reportId, controller.signal))
        setSuccessOpen(true)
      }
      if (!controller.signal.aborted) setPhase('idle')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setPhase('error')
      }
    }
  }

  const eligible = eligibility?.eligible === true

  return (
    <section className="tax-report-v2__attestation" aria-label="블록체인 기록 검증">
      <div className="tax-report-v2__attestation-heading">
        <span>기록 검증</span>
        <h4>현재 장부 증빙</h4>
        <p>
          {eligible
            ? '현재 장부의 계산 결과와 원본 근거를 변경 불가한 기록으로 남깁니다.'
            : status?.submissionEvidence
              ? '이 장부에 남은 블록체인 증명을 확인합니다.'
            : '현재 장부를 불러온 뒤 증빙할 수 있습니다.'}
        </p>
      </div>
      <div
        className="tax-report-v2__attestation-readiness"
        aria-label="EAS 증빙 준비 상태"
      >
        {eligibility?.checks.map((check) => {
          const copy = eligibilityCopy[check.code]
          return (
            <article key={check.code} data-status={check.status}>
              <span aria-hidden="true" />
              <div>
                <strong>{copy.title}</strong>
                <p>{copy.description}</p>
              </div>
              <b>{check.status === 'PASSED' ? '준비됨' : '확인 필요'}</b>
            </article>
          )
        }) ?? (
          <p className="tax-report-v2__attestation-loading" role="status">
            증빙 준비 상태를 확인하고 있습니다.
          </p>
        )}
      </div>
      <div className="tax-report-v2__attestation-action">
        {status ? (
          <span data-status={status.lifecycle}>
            {lifecycleLabel[status.lifecycle] ?? '기록 상태 확인 필요'}
          </span>
        ) : null}
        {verification ? (
          <strong data-result={verification.result}>
            {verification.result === 'USABLE'
              ? '검증 가능한 승인본'
              : '검증 결과 확인 필요'}
          </strong>
        ) : null}
        {status?.submissionEvidence ? (
          <dl className="tax-report-v2__attestation-evidence">
            <div><dt>기록 네트워크</dt><dd>GIWA 테스트 네트워크</dd></div>
            <div><dt>검증 기록</dt><dd>원본 근거 보관됨</dd></div>
          </dl>
        ) : null}
        <button
          type="button"
          disabled={!eligible || phase === 'loading' || phase === 'running'}
          onClick={() => setConfirmOpen(true)}
        >
          {!eligible
            ? '현재 장부 확인 필요'
            : phase === 'running'
              ? '처리 중…'
              : status
                ? '증빙 상태 확인'
                : '현재 장부 증빙하기'}
        </button>
        {phase === 'error' ? <small role="alert">증빙 준비 상태를 확인하지 못했습니다.</small> : null}
      </div>
      {confirmOpen ? (
        <div className="tax-report-v2__confirm" role="dialog" aria-modal="true" aria-labelledby="report-attestation-confirm-title">
          <div>
            <header>
              <div>
                <span>기록 제출</span>
                <h4 id="report-attestation-confirm-title">변경 불가 증명 대상 확인</h4>
              </div>
              <button type="button" onClick={() => setConfirmOpen(false)} aria-label="증명 확인 닫기">닫기</button>
            </header>
            <p>제출하면 현재 장부의 정확한 상태가 네트워크에 남습니다. 이후 계산 내용이 바뀌면 새 상태를 다시 증빙할 수 있습니다.</p>
            <dl>
              <div><dt>기록 네트워크</dt><dd>GIWA 테스트 네트워크</dd></div>
              <div><dt>대상</dt><dd>현재 장부</dd></div>
              <div><dt>증명 범위</dt><dd>현재 계산 결과와 원본 근거</dd></div>
            </dl>
            <footer>
              <button type="button" onClick={() => setConfirmOpen(false)}>취소</button>
              <button type="button" onClick={() => { setConfirmOpen(false); void start() }}>변경 불가 증명 제출</button>
            </footer>
          </div>
        </div>
      ) : null}
      {successOpen && status?.submissionEvidence ? (
        <div className="tax-report-v2__confirm" role="dialog" aria-modal="true" aria-labelledby="report-attestation-success-title">
          <div>
            <header>
              <div>
                <span>기록 완료</span>
                <h4 id="report-attestation-success-title">블록체인 기록 완료</h4>
              </div>
              <button type="button" onClick={() => setSuccessOpen(false)} aria-label="블록체인 기록 완료 닫기">닫기</button>
            </header>
            <p>현재 장부의 계산 결과와 원본 근거가 네트워크에 기록되었습니다.</p>
            <dl>
              <div><dt>기록 네트워크</dt><dd>GIWA 테스트 네트워크</dd></div>
              <div><dt>검증 기록</dt><dd>원본 근거 보관됨</dd></div>
            </dl>
          </div>
        </div>
      ) : null}
    </section>
  )
}
