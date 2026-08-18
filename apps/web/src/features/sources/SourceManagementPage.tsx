import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { AppLink } from '../../components/AppLink.tsx'
import { useEffect, useRef, useState } from 'react'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import {
  createSyncJob,
  disconnectWalletSource,
  findLatestSyncJob,
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
import {
  EVM_WALLET_COVERAGE_END_DATE,
  EVM_WALLET_COVERAGE_START_DATE,
  validateEvmWalletPeriodDraft,
} from './evmWalletFlow.ts'

const jobStatusLabel: Record<SyncJobApiModel['state'], string> = {
  QUEUED: '처리 대기',
  RUNNING: '처리 중',
  SUCCEEDED: '처리 완료',
  FAILED: '처리 확인 필요',
}

type SourceJobFailurePresentation = {
  kind: string
  message: string
  title: string
}

const temporaryCollectionFailure: SourceJobFailurePresentation = {
  kind: '수집 서비스 일시 오류',
  title: '거래 수집이 잠시 중단되었습니다',
  message:
    '수집 서비스 연결이 원활하지 않습니다. 잠시 후 다시 수집해 주세요.',
}

// A retryable upstream problem leaves the job QUEUED for the worker's own
// retry, so a FAILED job carrying one of these codes means the upstream call
// was refused for a reason that a later attempt repeats.
const persistentCollectionFailure: SourceJobFailurePresentation = {
  kind: '수집 처리 확인 필요',
  title: '거래 수집이 처리 도중 멈췄습니다',
  message:
    '수집 처리에서 문제가 확인되었습니다. 같은 조건으로 다시 시도하면 같은 지점에서 멈출 수 있습니다.',
}

const invalidCollectionResponse: SourceJobFailurePresentation = {
  kind: '수집 처리 응답 오류',
  title: '거래 수집을 완료하지 못했습니다',
  message:
    '수집 결과를 확인하는 동안 문제가 발생했습니다. 잠시 후 다시 수집해 주세요.',
}

const sourceJobFailureFallback: SourceJobFailurePresentation = {
  kind: '수집 처리 문제',
  title: '수집 작업을 완료하지 못했습니다',
  message: '일시적인 문제가 발생했습니다. 잠시 후 다시 수집해 주세요.',
}

const sourceJobFailurePresentationByCode: Record<
  string,
  SourceJobFailurePresentation
> = {
  JIT_START_FAILED: persistentCollectionFailure,
  JIT_SELECTION_FAILED: persistentCollectionFailure,
  JIT_STATUS_FAILED: persistentCollectionFailure,
  JIT_RUN_FAILED: persistentCollectionFailure,
  JIT_AWAIT_TIMEOUT: temporaryCollectionFailure,
  JIT_RETRYABLE_FAILURE: temporaryCollectionFailure,
  SYNC_UPSTREAM_TIMEOUT: temporaryCollectionFailure,
  SYNC_RETRYABLE_FAILURE: temporaryCollectionFailure,
  EVM_JIT_UNAVAILABLE: {
    kind: '수집 서비스 준비 필요',
    title: '거래 수집을 시작할 수 없습니다',
    message:
      '수집 서비스가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
  },
  SOURCE_NOT_FOUND: {
    kind: '연결 정보 확인 필요',
    title: '데이터 소스 연결을 확인해 주세요',
    message:
      '연결된 데이터 소스를 찾을 수 없습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
  },
  SYNC_COVERAGE_MISSING: {
    kind: '수집 기간 확인 필요',
    title: '수집 기간을 확인할 수 없습니다',
    message: '조회 기간을 다시 확인한 뒤 새 수집을 시작해 주세요.',
  },
  JIT_COVERAGE_MAPPING_UNAVAILABLE: {
    kind: '수집 기간 확인 필요',
    title: '선택한 기간의 거래를 수집할 수 없습니다',
    message:
      '현재 선택한 기간은 수집할 수 없습니다. 조회 기간을 확인한 뒤 다시 시도해 주세요.',
  },
  JIT_CHAIN_UNSUPPORTED: {
    kind: '지원 네트워크 확인 필요',
    title: '선택한 네트워크를 수집할 수 없습니다',
    message:
      '지원하는 수집 네트워크를 선택한 뒤 다시 수집해 주세요.',
  },
  JIT_REQUEST_INVALID: {
    kind: '수집 정보 확인 필요',
    title: '수집 요청 정보를 확인해 주세요',
    message:
      '지갑 연결과 수집 기간을 확인한 뒤 다시 수집해 주세요.',
  },
  JIT_REQUEST_FAILED: invalidCollectionResponse,
  JIT_START_INVALID_RESPONSE: invalidCollectionResponse,
  JIT_SELECTION_INVALID_RESPONSE: invalidCollectionResponse,
  JIT_RUN_INVALID: invalidCollectionResponse,
  JIT_STATUS_INVALID_RESPONSE: invalidCollectionResponse,
  JIT_TERMINAL_FRAGMENT_MISSING: invalidCollectionResponse,
  JIT_STATUS_UNKNOWN: invalidCollectionResponse,
  JIT_SNAPSHOT_MISMATCH: invalidCollectionResponse,
  UNSUPPORTED_SOURCE_KIND: {
    kind: '지원 소스 확인 필요',
    title: '이 데이터 소스는 아직 수집할 수 없습니다',
    message: '지원하는 데이터 소스를 연결한 뒤 다시 시도해 주세요.',
  },
  INVALID_OBJECT_KEY: {
    kind: '등록 파일 확인 필요',
    title: '등록한 PDF를 확인할 수 없습니다',
    message: 'Upbit 거래내역서 PDF를 다시 등록해 주세요.',
  },
  OBJECT_NOT_FOUND: {
    kind: '등록 파일 확인 필요',
    title: '등록한 PDF를 찾을 수 없습니다',
    message: 'Upbit 거래내역서 PDF를 다시 등록해 주세요.',
  },
  OBJECT_DECRYPT_FAILED: {
    kind: '등록 파일 확인 필요',
    title: '등록한 PDF를 읽을 수 없습니다',
    message: 'Upbit 거래내역서 PDF를 다시 등록해 주세요.',
  },
  INVALID_PDF: {
    kind: 'PDF 파일 확인 필요',
    title: 'PDF 파일을 처리할 수 없습니다',
    message: '올바른 Upbit 거래내역서 PDF를 다시 등록해 주세요.',
  },
  DIGEST_MISMATCH: {
    kind: '파일 무결성 확인 필요',
    title: '등록한 PDF를 안전하게 확인할 수 없습니다',
    message: '원본 Upbit 거래내역서 PDF를 다시 등록해 주세요.',
  },
  UPBIT_PDF_LAYOUT_UNSUPPORTED: {
    kind: '지원 형식 확인 필요',
    title: '현재 지원하지 않는 PDF 형식입니다',
    message: '지원되는 Upbit 거래내역서 형식인지 확인해 주세요.',
  },
}

function getSourceJobFailurePresentation(failureCode: string | undefined) {
  if (!failureCode) return sourceJobFailureFallback
  return (
    sourceJobFailurePresentationByCode[failureCode] ??
    sourceJobFailureFallback
  )
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
    return (
      <button
        aria-controls={`source-job-details-${job.id}`}
        aria-expanded={expanded}
        className="source-job-status source-job-status--failed"
        data-job-state={job.state}
        onClick={onToggle}
        type="button"
      >
        <span>{jobStatusLabel[job.state]}</span>
        <span aria-hidden="true">{expanded ? '접기' : '확인'}</span>
      </button>
    )
  }
  if (job.state === 'SUCCEEDED') {
    if (job.sourceKind === 'EVM_WALLET') {
      if (job.ledgerMaterializationState === 'POSTED') {
        return (
          <AppLink
            className="source-job-status source-job-status--succeeded"
            href="/ledger"
          >
            <span>장부 반영 완료</span>
            <span>
              {job.ledgerPostingCount === undefined
                ? '장부 보기'
                : `${job.ledgerPostingCount}개 항목`}
            </span>
          </AppLink>
        )
      }
      const materializationCopy = {
        NO_POSTING: ['실행 분석 완료', '장부 항목 없음'],
        PENDING: ['실행 분석 완료', '장부 반영 중'],
        REVIEW_REQUIRED: ['분류 확인 필요', '장부 반영 보류'],
        UNAVAILABLE: ['실행 분석 완료', '장부 상태 확인 필요'],
      }[job.ledgerMaterializationState ?? 'UNAVAILABLE']
      return (
        <small
          className={`source-job-status source-job-status--${
            job.ledgerMaterializationState?.toLowerCase().replace('_', '-') ??
            'unavailable'
          }`}
          data-job-state={job.state}
          data-ledger-state={job.ledgerMaterializationState ?? 'UNAVAILABLE'}
        >
          <span>{materializationCopy[0]}</span>
          <span>{materializationCopy[1]}</span>
        </small>
      )
    }
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
    <small data-job-state={job.state}>{label}</small>
  )
}

function formatCoverageDate(value: string) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(
    timestamp,
  )
}

function SourceDeliveredCoverage({ job }: { job: SyncJobApiModel | undefined }) {
  if (
    job?.state !== 'SUCCEEDED' ||
    job.sourceKind !== 'EVM_WALLET' ||
    !job.deliveredCoverage?.length
  ) {
    return null
  }
  const requestedWindow =
    job.requestedCoverageStart && job.requestedCoverageEnd
      ? `${job.requestedCoverageStart} – ${job.requestedCoverageEnd}`
      : undefined
  return (
    <section className="source-coverage" aria-label="실제 수집 범위">
      <header>
        <b>실제 수집 범위</b>
        {requestedWindow ? <span>요청 기간 {requestedWindow}</span> : null}
      </header>
      <ul>
        {job.deliveredCoverage.map((coverage) => {
          const incomplete =
            coverage.status !== 'COMPLETE' || Number(coverage.gapSegmentCount) > 0
          return (
            <li data-coverage-status={coverage.status} key={coverage.chainId}>
              <b>
                {getEvmWalletNetwork(coverage.chainId)?.label ??
                  coverage.chainId}
              </b>
              <span>
                {formatCoverageDate(coverage.fromTime)} –{' '}
                {formatCoverageDate(coverage.toTime)} 반영
              </span>
              {incomplete ? (
                <em>
                  일부 구간 미수집 · 인덱스가 채워지면 재수집 시 반영됩니다
                </em>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function maskAddress(address: string) {
  const normalizedAddress = address.replace(/^0[×X]/, '0x')
  return `${normalizedAddress.slice(0, 6)}…${normalizedAddress.slice(-4)}`
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

function getActiveWalletChainIds(
  source: Extract<SourceApiModel, { type: 'EVM_WALLET' }>,
) {
  return source.chainScopes
    .filter((scope) => scope.status === 'ACTIVE')
    .map((scope) => scope.chainId)
    .sort()
}

function haveSameChainIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((chainId, index) => chainId === sortedRight[index])
}

function isSyncJobActive(job: SyncJobApiModel | undefined) {
  return job?.state === 'QUEUED' || job?.state === 'RUNNING'
}

export function SourceManagementPage() {
  const [sources, setSources] = useState<SourceApiModel[]>([])
  const [jobs, setJobs] = useState<SyncJobApiModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [disconnectingId, setDisconnectingId] = useState<string>()
  const [editingNetworksId, setEditingNetworksId] = useState<string>()
  const [networkDraft, setNetworkDraft] = useState<string[]>([])
  const [coverageDraft, setCoverageDraft] = useState({
    endDate: EVM_WALLET_COVERAGE_END_DATE,
    startDate: EVM_WALLET_COVERAGE_START_DATE,
  })
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
  const networkUpdateInFlight = useRef(new Set<string>())
  const activeSources = sources.filter((source) => source.status === 'ACTIVE')
  const sourceCountText =
    status === 'ready'
      ? `현재 연결된 소스 ${activeSources.length}개`
      : status === 'loading'
        ? '현재 연결된 소스 확인 중'
        : '현재 연결된 소스 수를 확인할 수 없습니다'

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

        sourceResult.items.forEach((source) => {
          const latestJob = findLatestSyncJob(jobResult.items, source.id)
          if (!latestJob || !isSyncJobActive(latestJob)) return

          const watchKey = `initial:${source.id}`
          const watchController = new AbortController()
          retryWatchControllers.current.set(watchKey, watchController)
          void watchSyncJob({
            jobId: latestJob.id,
            signal: watchController.signal,
            waitForLedger: true,
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
        })
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
      await disconnectWalletSource(sourceId)
      setSources((current) =>
        current.filter((source) => source.id !== sourceId),
      )
      setJobs((current) =>
        current.filter((job) => job.sourceId !== sourceId),
      )
      setEditingNetworksId((current) =>
        current === sourceId ? undefined : current,
      )
      setNetworkUpdateMessage((current) =>
        current?.sourceId === sourceId ? undefined : current,
      )
    } catch {
      setStatus('error')
    } finally {
      setDisconnectingId(undefined)
    }
  }

  function openNetworkEditor(
    source: Extract<SourceApiModel, { type: 'EVM_WALLET' }>,
    latestJob: SyncJobApiModel | undefined,
  ) {
    setEditingNetworksId(source.id)
    setNetworkDraft(
      source.chainScopes
        .filter(
          (scope) =>
            scope.status === 'ACTIVE' &&
            evmWalletNetworkMetadata.some(
              (network) =>
                network.chainId === scope.chainId &&
                network.collectionEnabled,
            ),
        )
        .map((scope) => scope.chainId),
    )
    setCoverageDraft({
      endDate:
        latestJob?.requestedCoverageEnd ?? EVM_WALLET_COVERAGE_END_DATE,
      startDate:
        latestJob?.requestedCoverageStart ?? EVM_WALLET_COVERAGE_START_DATE,
    })
    setNetworkUpdateMessage(undefined)
  }

  async function handleNetworkUpdate(
    source: Extract<SourceApiModel, { type: 'EVM_WALLET' }>,
    latestJob: SyncJobApiModel | undefined,
  ) {
    const savedChainIds = getActiveWalletChainIds(source)
      .filter((chainId) =>
        evmWalletNetworkMetadata.some(
          (network) =>
            network.chainId === chainId && network.collectionEnabled,
        ),
      )
    const periodChanged =
      latestJob?.requestedCoverageStart !== coverageDraft.startDate ||
      latestJob?.requestedCoverageEnd !== coverageDraft.endDate
    if (
      networkUpdateInFlight.current.has(source.id) ||
      isSyncJobActive(latestJob) ||
      (haveSameChainIds(savedChainIds, networkDraft) && !periodChanged)
    ) {
      return
    }

    if (networkDraft.length === 0) {
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 네트워크를 하나 이상 선택해 주세요.',
      })
      return
    }

    const periodError = validateEvmWalletPeriodDraft({
      endDate: coverageDraft.endDate,
      mode: 'CUSTOM',
      startDate: coverageDraft.startDate,
    })
    if (
      periodError ||
      coverageDraft.startDate < EVM_WALLET_COVERAGE_START_DATE ||
      coverageDraft.endDate > EVM_WALLET_COVERAGE_END_DATE
    ) {
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: `수집 기간은 ${EVM_WALLET_COVERAGE_START_DATE}부터 ${EVM_WALLET_COVERAGE_END_DATE}까지 선택해 주세요.`,
      })
      return
    }

    networkUpdateInFlight.current.add(source.id)
    setUpdatingNetworksId(source.id)
    setNetworkUpdateMessage(undefined)
    const controller = new AbortController()
    let updated: Extract<SourceApiModel, { type: 'EVM_WALLET' }>
    try {
      if (!haveSameChainIds(savedChainIds, networkDraft)) {
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
      }
    } catch {
      controller.abort()
      networkUpdateInFlight.current.delete(source.id)
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 네트워크를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      })
      setUpdatingNetworksId(undefined)
      return
    }

    try {
      {
        const { job } = await createSyncJob({
          coverageStart: coverageDraft.startDate,
          coverageEnd: coverageDraft.endDate,
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
          waitForLedger: true,
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
        text: '수집 설정을 저장하고 선택한 기간의 새 수집을 시작했습니다.',
      })
    } catch {
      controller.abort()
      setEditingNetworksId(undefined)
      setNetworkUpdateMessage({
        sourceId: source.id,
        tone: 'error',
        text: '수집 설정은 저장했지만 새 수집을 시작하지 못했습니다. 잠시 후 다시 수집해 주세요.',
      })
    } finally {
      networkUpdateInFlight.current.delete(source.id)
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
        waitForLedger: true,
        onUpdate: (snapshot) => {
          setJobs((current) =>
            current.map((currentJob) =>
              currentJob.id === snapshot.id
                ? { ...currentJob, ...snapshot }
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
          <p aria-live="polite">{sourceCountText}</p>
        </div>
        <AppLink className="source-primary-action" href="/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </AppLink>
      </section>

      {status === 'loading' ? (
        <section
          className="source-state-card source-state-card--loading"
          role="status"
        >
          <p>데이터 소스를 불러오는 중입니다</p>
        </section>
      ) : null}

      {status === 'error' ? (
        <section
          className="source-state-card source-state-card--error"
          role="alert"
        >
          <h2>데이터 소스를 불러오지 못했습니다</h2>
          <p>잠시 후 다시 시도해 주세요</p>
        </section>
      ) : null}

      {status === 'ready' && activeSources.length > 0 ? (
        <section className="source-list" aria-label="등록된 데이터 소스">
          {activeSources.map((source) => {
            const latestJob = findLatestSyncJob(jobs, source.id)
            const activeJob = isSyncJobActive(latestJob)
            const savedChainIds =
              source.type === 'EVM_WALLET'
                ? getActiveWalletChainIds(source)
                : []
            const networkDraftChanged =
              source.type === 'EVM_WALLET' &&
              !haveSameChainIds(savedChainIds, networkDraft)
            const periodDraftChanged =
              latestJob?.requestedCoverageStart !== coverageDraft.startDate ||
              latestJob?.requestedCoverageEnd !== coverageDraft.endDate
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
            const failurePresentation =
              latestJob?.state === 'FAILED'
                ? getSourceJobFailurePresentation(latestJob.failureCode)
                : undefined

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
                <div className="source-list__right-controls">
                  <div className="source-list__meta">
                    <span>
                      {source.type === 'UPBIT_PDF'
                        ? `${source.coverageStart} – ${source.coverageEnd}`
                        : source.chainScopes
                            .filter(
                              ({ status: scopeStatus }) =>
                                scopeStatus === 'ACTIVE',
                            )
                            .map(
                              ({ chainId }) =>
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
                          current === latestJob?.id
                            ? undefined
                            : latestJob?.id,
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
                        onClick={() => openNetworkEditor(source, latestJob)}
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
                </div>
                <SourceDeliveredCoverage job={latestJob} />
                {source.type === 'EVM_WALLET' &&
                editingNetworksId === source.id ? (
                  <section
                    className="source-network-editor"
                    aria-label="수집 네트워크 관리"
                  >
                    <header className="source-network-editor__header">
                      <div>
                        <span className="source-network-editor__eyebrow">
                          수집 설정
                        </span>
                        <h3>수집 네트워크</h3>
                        <p>이 주소에서 거래를 확인할 네트워크를 선택합니다.</p>
                      </div>
                      <dl className="source-network-editor__status">
                        <div>
                          <dt>최근 상태</dt>
                          <dd>
                            {latestJob
                              ? jobStatusLabel[latestJob.state]
                              : '수집 기록 없음'}
                          </dd>
                        </div>
                        <div>
                          <dt>처리한 거래</dt>
                          <dd>
                            {latestJob
                              ? `${String(latestJob.processedRecords)}건`
                              : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>마지막 업데이트</dt>
                          <dd>
                            {latestJob
                              ? formatJobTimestamp(latestJob.updatedAt)
                              : '—'}
                          </dd>
                        </div>
                      </dl>
                    </header>
                    <div className="source-network-editor__body">
                      <div className="source-network-editor__fields">
                        <fieldset disabled={Boolean(activeJob)}>
                          <legend>수집 대상</legend>
                          <div className="source-network-editor__options">
                            {evmWalletNetworkMetadata.map((network) => (
                              <label key={network.chainId}>
                                <input
                                  type="checkbox"
                                  checked={networkDraft.includes(network.chainId)}
                                  disabled={
                                    updatingNetworksId === source.id ||
                                    Boolean(activeJob) ||
                                    !network.collectionEnabled
                                  }
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked
                                    setNetworkDraft((current) =>
                                      checked
                                        ? [...current, network.chainId]
                                        : current.filter(
                                            (chainId) =>
                                              chainId !== network.chainId,
                                          ),
                                    )
                                  }}
                                />
                                <span>
                                  {network.label}
                                  {'disabledReason' in network
                                    ? ` · ${network.disabledReason}`
                                    : ''}
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <fieldset
                          className="source-network-editor__period"
                          disabled={Boolean(activeJob)}
                        >
                          <legend>수집 기간</legend>
                          <label>
                            <span>시작일</span>
                            <input
                              aria-label="수집 시작일"
                              type="date"
                              min={EVM_WALLET_COVERAGE_START_DATE}
                              max={coverageDraft.endDate}
                              value={coverageDraft.startDate}
                              onChange={(event) => {
                                const startDate = event.currentTarget.value
                                setCoverageDraft((current) => ({
                                  ...current,
                                  startDate,
                                }))
                              }}
                            />
                          </label>
                          <label>
                            <span>종료일</span>
                            <input
                              aria-label="수집 종료일"
                              type="date"
                              min={coverageDraft.startDate}
                              max={EVM_WALLET_COVERAGE_END_DATE}
                              value={coverageDraft.endDate}
                              onChange={(event) => {
                                const endDate = event.currentTarget.value
                                setCoverageDraft((current) => ({
                                  ...current,
                                  endDate,
                                }))
                              }}
                            />
                          </label>
                        </fieldset>
                      </div>
                      <div className="source-network-editor__guidance">
                        {activeJob ? (
                          <p role="status">
                            현재 수집이 진행 중입니다. 완료된 뒤 네트워크 설정을
                            변경할 수 있습니다.
                          </p>
                        ) : networkDraftChanged || periodDraftChanged ? (
                          <p>저장하면 선택한 네트워크와 기간으로 새 수집을 시작합니다.</p>
                        ) : (
                          <p>현재 저장된 설정과 같습니다.</p>
                        )}
                      </div>
                    </div>
                    <footer className="source-network-editor__actions">
                      <button
                        type="button"
                        onClick={() => setEditingNetworksId(undefined)}
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        disabled={
                          updatingNetworksId === source.id ||
                          networkDraft.length === 0 ||
                          (!networkDraftChanged && !periodDraftChanged) ||
                          Boolean(activeJob)
                        }
                        onClick={() => void handleNetworkUpdate(source, latestJob)}
                      >
                        {updatingNetworksId === source.id
                          ? '저장 중…'
                          : activeJob
                            ? '수집 진행 중'
                            : networkDraftChanged || periodDraftChanged
                              ? '설정 저장 후 수집'
                              : '변경사항 없음'}
                      </button>
                    </footer>
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
                {isExpanded && latestJob && failurePresentation ? (
                  <section
                    className="source-job-details"
                    id={`source-job-details-${latestJob.id}`}
                    aria-labelledby={`source-job-details-title-${latestJob.id}`}
                  >
                    <div className="source-job-details__heading">
                      <div>
                        <span>수집 상태</span>
                        <h3 id={`source-job-details-title-${latestJob.id}`}>
                          {failurePresentation.title}
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
                      {failurePresentation.message}
                    </p>
                    <dl className="source-job-details__facts">
                      <div>
                        <dt>문제 유형</dt>
                        <dd>{failurePresentation.kind}</dd>
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

      {status === 'ready' && activeSources.length === 0 ? (
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

      {status === 'ready' ? (
        <p className="source-footer-note">
          각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.
        </p>
      ) : null}
    </SourceFlowLayout>
  )
}
