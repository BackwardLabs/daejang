import { useEffect, useRef, useState } from 'react'

import { ApiClientError } from '../../api/client.ts'
import {
  localReportAttestationApi,
  pollReportAttestationStatus,
  type LocalReportAttestationApi,
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

export function ReportAttestationControl({
  reportId,
  eligible,
  api = localReportAttestationApi,
}: {
  reportId: string
  reportModelDigest: string
  pointerVersion: number | string
  eligible: boolean
  api?: LocalReportAttestationApi
}) {
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
    setStatus(undefined)
    setVerification(undefined)
    setPhase('loading')
    void api.getStatus(reportId, controller.signal)
      .then(async (value) => {
        if (controller.signal.aborted) return
        setStatus(value)
        if (value.lifecycle === 'APPROVED') {
          setVerification(await api.getVerification(reportId, controller.signal))
        }
        if (!controller.signal.aborted) setPhase('idle')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiClientError && error.status === 404) {
          setStatus(undefined)
          setPhase('idle')
          return
        }
        setPhase('error')
      })
    return () => controller.abort()
  }, [api, eligible, reportId])

  const start = async () => {
    if (!eligible || phase === 'running') return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase('running')
    setVerification(undefined)
    try {
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

  return (
    <section className="tax-report-v2__attestation" aria-label="블록체인 기록 검증">
      <div>
        <span>기록 검증</span>
        <h4>블록체인 기록 검증</h4>
        <p>
          {eligible
            ? '현재 확정 장부의 변경 이력 확인 정보를 제출하고 검증합니다.'
            : status?.submissionEvidence
              ? '이 발행본에 남은 온체인 증명을 읽기 전용으로 확인합니다.'
            : '연간 자료·마감 확인 후 가능합니다.'}
        </p>
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
            ? '새 증명 제출 불가'
            : phase === 'running'
              ? '처리 중…'
              : status
                ? '상태 갱신·검증'
                : '온체인 검증 시작'}
        </button>
        {phase === 'error' ? <small role="alert">온체인 검증 상태를 확인하지 못했습니다.</small> : null}
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
            <p>제출하면 이 발행본의 변경 이력 확인 정보가 네트워크에 남습니다. 수정이 필요하면 새 발행본을 만들어야 합니다.</p>
            <dl>
              <div><dt>기록 네트워크</dt><dd>GIWA 테스트 네트워크</dd></div>
              <div><dt>발행본</dt><dd>현재 발행본</dd></div>
              <div><dt>증명 범위</dt><dd>이 발행본의 계산 결과와 원본 근거</dd></div>
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
            <p>이 발행본의 변경 이력 확인 정보가 네트워크에 기록되었습니다. 원본 근거 보기에서 연결 상태를 확인할 수 있습니다.</p>
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
