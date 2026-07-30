import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { AppLink } from '../../components/AppLink.tsx'
import { useEffect, useRef, useState } from 'react'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import {
  createSyncJob,
  disconnectWalletSource,
  listSyncJobs,
  listSources,
  retrySyncJob,
  updateWalletSourceNetworks,
  type SourceApiModel,
  type SyncJobApiModel,
  watchSyncJob,
} from './sourceApi.ts'
import {
  evmWalletNetworkMetadata,
  getEvmWalletNetwork,
} from './evmNetworks.ts'

const jobStatusLabel: Record<SyncJobApiModel['state'], string> = {
  QUEUED: '처리 대기',
  RUNNING: '처리 중',
  SUCCEEDED: '처리 완료',
  FAILED: '처리 확인 필요',
}

function SourceJobStatus({
  expanded,
  job,
  onToggle,
}: {
  expanded: boolean
  job: SyncJobApiModel | undefined
  onToggle: () => void
}) {
  if (!job) return null
  if (job.state === 'FAILED') {
    const label = `${jobStatusLabel[job.state]}${job.failureCode ? ` · ${job.failureCode}` : ''}`
    return (
      <button
        aria-controls={`source-job-details-${job.id}`}
        aria-expanded={expanded}
        className="source-job-status source-job-status--failed"
        data-job-state={job.state}
        onClick={onToggle}
        type="button"
      >
        <span>{label}</span>
        <span aria-hidden="true">{expanded ? '접기' : '확인'}</span>
      </button>
    )
  }
  if (job.state === 'SUCCEEDED') {
    return (
      <AppLink
        className="source-job-status source-job-status--succeeded"
        href="/ledger"
      >
        <span>{jobStatusLabel[job.state]}</span>
        <span>장부 보기</span>
      </AppLink>
    )
  }
  const label =
    job.state === 'QUEUED' && job.failureCode
      ? '자동 재시도 중'
      : jobStatusLabel[job.state]
  return (
    <small data-job-state={job.state} title={job.failureMessage}>
      {label}
      {job.failureCode ? ` · ${job.failureCode}` : ''}
    </small>
  )
}

function maskAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatJobTimestamp(value: string) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function createRetryIntentKey(jobId: string) {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `source-retry:${jobId}:${suffix}`
}

function createNetworkUpdateIntentKey(sourceId: string) {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `source-networks:${sourceId}:${suffix}`
}

export function SourceManagementPage() {
  const [sources, setSources] = useState<SourceApiModel[]>([])
  const [jobs, setJobs] = useState<SyncJobApiModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [disconnectingId, setDisconnectingId] = useState<string>()
  const [editingNetworksId, setEditingNetworksId] = useState<string>()
  const [networkDraft, setNetworkDraft] = useState<string[]>([])
  const [updatingNetworksId, setUpdatingNetworksId] = useState<string>()
  const [networkUpdateMessage, setNetworkUpdateMessage] = useState<{
    sourceId: string
    tone: 'error' | 'success'
    text: string
  }>()
  const [expandedJobId, setExpandedJobId] = useState<string>()
  const [retryingJobId, setRetryingJobId] = useState<string>()
  const [retryFailure, setRetryFailure] = useState<{
    jobId: string
    message: string
  }>()
  const retryIntentKeys = useRef(new Map<string, string>())
  const retryWatchControllers = useRef(new Map<string, AbortController>())
  const activeSources = sources.filter((source) => source.status === 'ACTIVE')

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      listSources(controller.signal),
      listSyncJobs(controller.signal),
    ])
      .then(([sourceResult, jobResult]) => {
        setSources(sourceResult.items)
        setJobs(jobResult.items)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setStatus('error')
        }
      })
    return () => {
      controller.abort()
      retryWatchControllers.current.forEach((retryController) =>
        retryController.abort(),
      )
      retryWatchControllers.current.clear()
    }
  }, [])

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

  function openNetworkEditor(source: Extract<SourceApiModel, { type: 'EVM_WALLET' }>) {
    setEditingNetworksId(source.id)
    setNetworkDraft(
      source.chainScopes
        .filter(
          (scope) =>
            scope.status === 'ACTIVE' &&
            evmWalletNetworkMetadata.some(
              (network) => network.chainId === scope.chainId,
            ),
        )
        .map((scope) => scope.chainId),
    )
    setNetworkUpdateMessage(undefined)
  }

  async function handleNetworkUpdate(
    source: Extract<SourceApiModel, { type: 'EVM_WALLET' }>,
    latestJob: SyncJobApiModel | undefined,
  ) {
    if (networkDraft.length === 0) {
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 네트워크를 하나 이상 선택해 주세요.',
      })
      return
    }

    setUpdatingNetworksId(source.id)
    setNetworkUpdateMessage(undefined)
    const controller = new AbortController()
    let updated: Extract<SourceApiModel, { type: 'EVM_WALLET' }>
    try {
      updated = await updateWalletSourceNetworks({
        chainIds: networkDraft,
        signal: controller.signal,
        sourceId: source.id,
      })
      setSources((current) =>
        current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      )
    } catch {
      controller.abort()
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 네트워크를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      })
      setUpdatingNetworksId(undefined)
      return
    }

    try {
      if (latestJob?.requestedCoverageStart && latestJob.requestedCoverageEnd) {
        const { job } = await createSyncJob({
          coverageStart: latestJob.requestedCoverageStart,
          coverageEnd: latestJob.requestedCoverageEnd,
          intentKey: createNetworkUpdateIntentKey(source.id),
          signal: controller.signal,
          sourceId: source.id,
        })
        setJobs((current) => [job, ...current])
        const watchKey = `networks:${source.id}`
        retryWatchControllers.current.get(watchKey)?.abort()
        retryWatchControllers.current.set(watchKey, controller)
        void watchSyncJob({
          jobId: job.id,
          signal: controller.signal,
          onUpdate: (snapshot) => {
            setJobs((current) =>
              current.map((candidate) =>
                candidate.id === snapshot.id
                  ? { ...candidate, ...snapshot }
                  : candidate,
              ),
            )
          },
        })
          .catch(() => undefined)
          .finally(() => {
            retryWatchControllers.current.delete(watchKey)
          })
      }

      setEditingNetworksId(undefined)
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'success',
        text: latestJob?.requestedCoverageStart && latestJob.requestedCoverageEnd
          ? '수집 네트워크를 저장하고 같은 기간의 새 수집을 시작했습니다.'
          : '수집 네트워크를 저장했습니다.',
      })
    } catch {
      controller.abort()
      setEditingNetworksId(undefined)
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 네트워크는 저장했지만 새 수집을 시작하지 못했습니다. 잠시 후 다시 수집해 주세요.',
      })
    } finally {
      setUpdatingNetworksId(undefined)
    }
  }

  async function handleRetry(job: SyncJobApiModel) {
    if (
      job.state !== 'FAILED' ||
      !job.requestedCoverageStart ||
      !job.requestedCoverageEnd
    ) {
      return
    }

    setRetryingJobId(job.id)
    setRetryFailure(undefined)
    const controller = new AbortController()
    const intentKey =
      retryIntentKeys.current.get(job.id) ?? createRetryIntentKey(job.id)
    retryIntentKeys.current.set(job.id, intentKey)
    try {
      const result = await retrySyncJob({
        intentKey,
        jobId: job.id,
        signal: controller.signal,
      })
      retryIntentKeys.current.delete(job.id)
      setJobs((current) => [
        result.job,
        ...current.filter((currentJob) => currentJob.id !== result.job.id),
      ])
      setExpandedJobId(undefined)
      retryWatchControllers.current.set(job.id, controller)
      void watchSyncJob({
        jobId: result.job.id,
        signal: controller.signal,
        onUpdate: (snapshot) => {
          setJobs((current) =>
            current.map((currentJob) =>
              currentJob.id === snapshot.id
                ? {
                    ...currentJob,
                    state: snapshot.state,
                    processedRecords: snapshot.processedRecords,
                    ...(snapshot.failureCode
                      ? { failureCode: snapshot.failureCode }
                      : {}),
                    ...(snapshot.failureMessage
                      ? { failureMessage: snapshot.failureMessage }
                      : {}),
                  }
                : currentJob,
            ),
          )
        },
      })
        .catch(() => undefined)
        .finally(() => {
          retryWatchControllers.current.delete(job.id)
        })
    } catch {
      controller.abort()
      setRetryFailure({
        jobId: job.id,
        message:
          '다시 수집 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      })
    } finally {
      setRetryingJobId(undefined)
    }
  }

  return (
    <SourceFlowLayout
      description="거래내역서와 지갑 연결을 한곳에서 관리합니다."
      title="데이터 소스 관리"
    >
      <section
        className="source-summary-card"
        aria-labelledby="connected-source-title"
      >
        <div>
          <h2 id="connected-source-title">연결된 데이터 소스</h2>
          <p>현재 연결된 소스 {activeSources.length}개</p>
        </div>
        <AppLink className="source-primary-action" href="/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </AppLink>
      </section>

      {status === 'loading' ? (
        <p className="source-api-notice" role="status">
          데이터 소스를 불러오는 중입니다.
        </p>
      ) : null}

      {status === 'error' ? (
        <p className="source-api-notice" role="alert">
          데이터 소스를 잠시 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.
        </p>
      ) : null}

      {status === 'ready' && sources.length > 0 ? (
        <section className="source-list" aria-label="등록된 데이터 소스">
          {sources.map((source) => {
            const latestJob = jobs.find((job) => job.sourceId === source.id)
            const isExpanded =
              latestJob?.state === 'FAILED' &&
              expandedJobId === latestJob.id
            const canRetry =
              source.status === 'ACTIVE' &&
              latestJob?.state === 'FAILED' &&
              Boolean(
                latestJob.requestedCoverageStart &&
                  latestJob.requestedCoverageEnd,
              )

            return (
              <article
                className={`source-list__item${isExpanded ? ' source-list__item--expanded' : ''}`}
                key={source.id}
              >
                <div className="source-list__identity">
                  <img
                    src={
                      source.type === 'UPBIT_PDF'
                        ? upbitLogo
                        : ethereumDiamond
                    }
                    alt=""
                  />
                  <div>
                    <strong>
                      {source.type === 'UPBIT_PDF'
                        ? 'Upbit 거래내역서'
                        : source.label ?? 'EVM Wallet'}
                    </strong>
                    <span>
                      {source.type === 'UPBIT_PDF'
                        ? source.originalFilename
                        : maskAddress(source.address)}
                    </span>
                  </div>
                </div>
                <div className="source-list__meta">
                  <span>
                    {source.type === 'UPBIT_PDF'
                      ? `${source.coverageStart} – ${source.coverageEnd}`
                      : source.chainScopes
                          .filter(({ status: scopeStatus }) => scopeStatus === 'ACTIVE')
                          .map(({ chainId }) =>
                            getEvmWalletNetwork(chainId)?.label ?? chainId,
                          )
                          .join(', ')}
                  </span>
                  <b data-status={source.status}>
                    {source.status === 'ACTIVE' ? '연결됨' : '연결 해제'}
                  </b>
                  <SourceJobStatus
                    expanded={isExpanded}
                    job={latestJob}
                    onToggle={() =>
                      setExpandedJobId((current) =>
                        current === latestJob?.id ? undefined : latestJob?.id,
                      )
                    }
                  />
                </div>
                {source.status === 'ACTIVE' &&
                source.type === 'EVM_WALLET' ? (
                  <div className="source-list__actions">
                    <button
                      className="source-list__networks"
                      type="button"
                      aria-expanded={editingNetworksId === source.id}
                      onClick={() => openNetworkEditor(source)}
                    >
                      수집 네트워크 관리
                    </button>
                    <button
                      className="source-list__disconnect"
                      type="button"
                      disabled={disconnectingId === source.id}
                      onClick={() => void handleDisconnect(source.id)}
                    >
                      {disconnectingId === source.id
                        ? '해제 중…'
                        : '연결 해제'}
                    </button>
                  </div>
                ) : null}
                {source.type === 'EVM_WALLET' &&
                editingNetworksId === source.id ? (
                  <section className="source-network-editor" aria-label="수집 네트워크 관리">
                    <div>
                      <h3>이 주소에서 수집할 네트워크</h3>
                      <p>지갑을 다시 연결하거나 네트워크를 전환할 필요가 없습니다.</p>
                    </div>
                    <fieldset>
                      <legend className="sr-only">수집 네트워크</legend>
                      {evmWalletNetworkMetadata.map((network) => (
                        <label key={network.chainId}>
                          <input
                            type="checkbox"
                            checked={networkDraft.includes(network.chainId)}
                            disabled={updatingNetworksId === source.id}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked
                              setNetworkDraft((current) =>
                                checked
                                  ? [...current, network.chainId]
                                  : current.filter((chainId) => chainId !== network.chainId),
                              )
                            }}
                          />
                          {network.label}
                        </label>
                      ))}
                    </fieldset>
                    <div className="source-network-editor__actions">
                      <button
                        type="button"
                        onClick={() => setEditingNetworksId(undefined)}
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        disabled={updatingNetworksId === source.id}
                        onClick={() => void handleNetworkUpdate(source, latestJob)}
                      >
                        {updatingNetworksId === source.id ? '저장 중…' : '저장하고 수집'}
                      </button>
                    </div>
                  </section>
                ) : null}
                {networkUpdateMessage?.sourceId === source.id ? (
                  <p
                    className={`source-network-message source-network-message--${networkUpdateMessage.tone}`}
                    role={networkUpdateMessage.tone === 'error' ? 'alert' : 'status'}
                  >
                    {networkUpdateMessage.text}
                  </p>
                ) : null}
                {isExpanded && latestJob ? (
                  <section
                    className="source-job-details"
                    id={`source-job-details-${latestJob.id}`}
                    aria-labelledby={`source-job-details-title-${latestJob.id}`}
                  >
                    <div className="source-job-details__heading">
                      <div>
                        <span>수집 상태</span>
                        <h3 id={`source-job-details-title-${latestJob.id}`}>
                          수집 문제를 확인해 주세요
                        </h3>
                      </div>
                      <button
                        aria-label="수집 문제 상세 닫기"
                        className="source-job-details__close"
                        onClick={() => setExpandedJobId(undefined)}
                        type="button"
                      >
                        닫기
                      </button>
                    </div>
                    <p className="source-job-details__message">
                      {latestJob.failureMessage ??
                        '수집 작업을 완료하지 못했습니다. 연동 상태를 확인한 뒤 다시 시도해 주세요.'}
                    </p>
                    <dl className="source-job-details__facts">
                      <div>
                        <dt>오류 코드</dt>
                        <dd>{latestJob.failureCode ?? '확인되지 않음'}</dd>
                      </div>
                      <div>
                        <dt>마지막 시도</dt>
                        <dd>{formatJobTimestamp(latestJob.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt>수집 기간</dt>
                        <dd>
                          {latestJob.requestedCoverageStart &&
                          latestJob.requestedCoverageEnd
                            ? `${latestJob.requestedCoverageStart} – ${latestJob.requestedCoverageEnd}`
                            : '확인되지 않음'}
                        </dd>
                      </div>
                      <div>
                        <dt>시도 횟수</dt>
                        <dd>{String(latestJob.attempts)}</dd>
                      </div>
                    </dl>
                    <div className="source-job-details__footer">
                      <p>
                        연동 환경이 복구된 뒤 다시 수집하면 기존 실패 기록은
                        보존되고 새 작업이 시작됩니다.
                      </p>
                      {canRetry ? (
                        <button
                          className="source-job-details__retry"
                          disabled={retryingJobId === latestJob.id}
                          onClick={() => void handleRetry(latestJob)}
                          type="button"
                        >
                          {retryingJobId === latestJob.id
                            ? '다시 수집 중…'
                            : '다시 수집'}
                        </button>
                      ) : null}
                    </div>
                    {!canRetry ? (
                      <p className="source-job-details__notice" role="note">
                        수집 기간을 확인할 수 없거나 연결이 해제되어 새 작업을
                        시작할 수 없습니다.
                      </p>
                    ) : null}
                    {retryFailure?.jobId === latestJob.id ? (
                      <p className="source-job-details__error" role="alert">
                        {retryFailure.message}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </article>
            )
          })}
        </section>
      ) : null}

      {status === 'ready' && sources.length === 0 ? (
        <section
          className="source-empty-state"
          aria-labelledby="source-empty-title"
        >
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
