import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { AppLink } from '../../components/AppLink.tsx'
import { useEffect, useState } from 'react'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import { consumeWalletRegistrationNotice } from './sourceRegistrationNotice.ts'
import {
  disconnectWalletSource,
  listSyncJobs,
  listSources,
  type SourceApiModel,
  type SyncJobApiModel,
} from './sourceApi.ts'

const jobStatusLabel: Record<SyncJobApiModel['state'], string> = {
  QUEUED: '처리 대기', RUNNING: '처리 중', SUCCEEDED: '처리 완료', FAILED: '처리 확인 필요',
}

function SourceJobStatus({ job }: { job: SyncJobApiModel | undefined }) {
  if (!job) return null
  return (
    <small data-job-state={job.state} title={job.failureMessage}>
      {jobStatusLabel[job.state]}
      {job.failureCode ? ` · ${job.failureCode}` : ''}
    </small>
  )
}

function maskAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function SourceDataState({
  onRetry,
  status,
}: {
  onRetry: () => void
  status: 'loading' | 'error'
}) {
  const isLoading = status === 'loading'

  return (
    <section
      className={`source-data-state source-data-state--${status}`}
      aria-busy={isLoading}
      aria-labelledby="source-data-state-title"
    >
      <div className="source-data-state__header">
        <div>
          <h2 id="source-data-state-title">연결된 데이터 소스 목록</h2>
          <p>
            {isLoading
              ? '등록된 거래소와 지갑을 확인하고 있습니다.'
              : '데이터를 다시 불러오면 연결 상태와 처리 현황을 확인할 수 있습니다.'}
          </p>
        </div>
        <span className="source-data-state__badge">
          {isLoading ? '확인 중' : '불러오기 실패'}
        </span>
      </div>

      <div
        className="source-data-state__notice"
        role={isLoading ? 'status' : 'alert'}
      >
        <span
          className={`source-data-state__icon${isLoading ? ' is-loading' : ''}`}
          aria-hidden="true"
        >
          {isLoading ? '' : '!'}
        </span>
        <div>
          <strong>
            {isLoading
              ? '데이터 소스를 불러오는 중입니다.'
              : '데이터 소스를 불러오지 못했습니다.'}
          </strong>
          <span>
            {isLoading
              ? '잠시만 기다려 주세요. 이 화면에서 데이터 소스를 추가할 수 있습니다.'
              : '연결 상태를 확인한 뒤 다시 시도해 주세요. 데이터 소스 추가는 계속할 수 있습니다.'}
          </span>
        </div>
        {!isLoading ? (
          <button type="button" onClick={onRetry}>
            데이터 소스 다시 불러오기
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="source-data-state__skeleton" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div className="source-data-state__skeleton-row" key={item}>
              <i />
              <span>
                <b />
                <small />
              </span>
              <em />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export function SourceManagementPage() {
  const [sources, setSources] = useState<SourceApiModel[]>([])
  const [jobs, setJobs] = useState<SyncJobApiModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [disconnectingId, setDisconnectingId] = useState<string>()
  const [reloadKey, setReloadKey] = useState(0)
  const [showRegistrationNotice, setShowRegistrationNotice] = useState(false)
  const activeSources = sources.filter((source) => source.status === 'ACTIVE')

  useEffect(() => {
    if (consumeWalletRegistrationNotice()) {
      setShowRegistrationNotice(true)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    void listSources(controller.signal)
      .then((sourceResult) => {
        setSources(sourceResult.items)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setStatus('error')
        }
      })
    void listSyncJobs(controller.signal)
      .then((jobResult) => setJobs(jobResult.items))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setJobs([])
        }
      })
    return () => controller.abort()
  }, [reloadKey])

  useEffect(() => {
    if (!showRegistrationNotice) return
    const timeoutId = window.setTimeout(
      () => setShowRegistrationNotice(false),
      5_000,
    )
    return () => window.clearTimeout(timeoutId)
  }, [showRegistrationNotice])

  async function handleDisconnect(sourceId: string) {
    setDisconnectingId(sourceId)
    try {
      const disconnected = await disconnectWalletSource(sourceId)
      setSources((current) =>
        current.map((source) =>
          source.id === disconnected.id ? disconnected : source,
        ),
      )
    } catch {
      setStatus('error')
    } finally {
      setDisconnectingId(undefined)
    }
  }

  return (
    <SourceFlowLayout
      description="거래내역서와 지갑 연결을 한곳에서 관리합니다."
      title="데이터 소스 관리"
    >
      {showRegistrationNotice ? (
        <div className="source-toast" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>연결 완료</strong>
            <p>지갑 데이터 소스가 등록되었습니다.</p>
          </div>
          <button
            type="button"
            aria-label="알림 닫기"
            onClick={() => setShowRegistrationNotice(false)}
          >
            ×
          </button>
        </div>
      ) : null}
      <section
        className="source-summary-card"
        aria-labelledby="connected-source-title"
      >
        <div>
          <h2 id="connected-source-title">연결된 데이터 소스</h2>
          <p>
            현재 연결된 소스{' '}
            {status === 'ready' ? `${activeSources.length}개` : '—'}
          </p>
        </div>
        <AppLink className="source-primary-action" href="/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </AppLink>
      </section>

      {status !== 'ready' ? (
        <SourceDataState
          status={status}
          onRetry={() => setReloadKey((current) => current + 1)}
        />
      ) : null}

      {status === 'ready' && sources.length > 0 ? (
        <section className="source-list" aria-label="등록된 데이터 소스">
          {sources.map((source) => (
            <article className="source-list__item" key={source.id}>
              <div className="source-list__identity">
                <img src={source.type === 'UPBIT_PDF' ? upbitLogo : ethereumDiamond} alt="" />
                <div>
                  <strong>{source.type === 'UPBIT_PDF' ? 'Upbit 거래내역서' : source.label ?? 'EVM Wallet'}</strong>
                  <span>{source.type === 'UPBIT_PDF' ? source.originalFilename : maskAddress(source.address)}</span>
                </div>
              </div>
              <div className="source-list__meta">
                <span>{source.type === 'UPBIT_PDF' ? `${source.coverageStart} – ${source.coverageEnd}` : source.chainScopes.map(({ chainId }) => chainId).join(', ')}</span>
                <b data-status={source.status}>
                  {source.status === 'ACTIVE' ? '연결됨' : '연결 해제'}
                </b>
                <SourceJobStatus job={jobs.find((job) => job.sourceId === source.id)} />
              </div>
              {source.status === 'ACTIVE' && source.type === 'EVM_WALLET' ? (
                <button
                  type="button"
                  disabled={disconnectingId === source.id}
                  onClick={() => void handleDisconnect(source.id)}
                >
                  {disconnectingId === source.id ? '해제 중…' : '연결 해제'}
                </button>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {status === 'ready' && sources.length === 0 ? (
        <section className="source-empty-state" aria-labelledby="source-empty-title">
        <div className="source-empty-state__logos" aria-hidden="true">
          <img src={upbitLogo} alt="" />
          <img src={ethereumDiamond} alt="" />
        </div>
        <h2 id="source-empty-title">아직 연결된 데이터 소스가 없어요</h2>
        <p>
          Upbit 거래내역서 PDF를 등록하거나 EVM Wallet을 연결하면
          <br />
          선택한 조회 기간의 거래 수집을 시작할 수 있습니다.
        </p>
        <div className="source-method-chips" aria-label="지원 데이터 소스">
          <span className="source-chip source-chip--upbit">Upbit PDF</span>
          <span className="source-chip source-chip--evm">EVM Wallet</span>
        </div>
        <AppLink className="source-primary-action" href="/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </AppLink>
        <div className="source-processing-note" role="note">
          <strong>등록 완료와 거래 처리 완료는 달라요</strong>
          <span>
            등록 후 조회 기간과 예상 거래를 확인해야 실제 수집을 시작할 수
            있습니다.
          </span>
        </div>
        </section>
      ) : null}

      <p className="source-footer-note">
        각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.
      </p>
    </SourceFlowLayout>
  )
}
