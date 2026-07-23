export type LedgerFlowState =
  | 'S0'
  | 'S1'
  | 'S2'
  | 'S3'
  | 'R'
  | 'A'
  | 'A+'
  | 'B'
  | 'C'
  | 'C0'
  | 'D'
  | 'E'
  | 'P'
  | 'F'
  | 'G'
  | 'G1'
  | 'OK'
  | 'J'

export type LedgerTone = 'accent' | 'negative' | 'neutral' | 'positive' | 'warning'

export type LedgerJourneyStep = {
  detail: string
  evidenceId: string
  key:
    | 'source'
    | 'observation'
    | 'interpretation'
    | 'posting'
    | 'valuation'
    | 'publication'
  label: string
  status: string
  tone: LedgerTone
}

export type LedgerJourney = {
  currentRevisionId: string
  economicEventId: string
  eventId: string
  id: string
  occurredAt: string
  observationIds: string[]
  policyVersion: string
  postingIds: string[]
  publicationStatus: 'DRAFT' | 'NOT_READY'
  sourceArtifactId: string
  sourceRecordId: string
  steps: LedgerJourneyStep[]
  transactionId: string
  valuationId: string
}

export type LedgerReviewOption = {
  id: string
  label: string
  outcome: 'confirmed' | 'on_hold'
  profitDeltaWon: number
  resolutionCode: string
}

export type LedgerReviewTask = {
  heldAt?: string
  id: string
  options: LedgerReviewOption[]
  prompt: string
  reasonCode: string
  resolvedAt?: string
  selectedOptionId?: string
  status: 'ON_HOLD' | 'OPEN' | 'RESOLVED'
}

export type LedgerTransaction = {
  asset: string
  confirmed: boolean
  date: string
  detail: string
  id: string
  impact: string
  impactTone: LedgerTone
  occurredAt: string
  source: {
    id: string
    name: string
    type: 'exchange' | 'wallet'
  }
  status: string
  statusCode:
    | 'confirmed'
    | 'display_only'
    | 'needs_review'
    | 'on_hold'
    | 'provisional'
  statusTone: LedgerTone
  title: string
  journey: LedgerJourney
  reviewTask?: LedgerReviewTask
}

export type LedgerTransactionsResponse = {
  data: {
    items: LedgerTransaction[]
    page: number
    pageSize: number
    total: number
  }
  meta: {
    generatedAt: string
    persistence: 'localStorage'
    schemaVersion: 'ledger-transactions.v5'
    source: 'mock'
  }
}

export type LedgerReviewResult = {
  fact: string
  impact: string
  revision: string
  transaction: LedgerTransaction
}

export const ledgerRevisionResults = {
  'rev.3': {
    profitWon: 720_000,
  },
  'rev.4': {
    profitWon: 875_000,
  },
  'rev.5': {
    profitWon: 1_055_000,
  },
} as const

export type LedgerRevision = `rev.${number}`

export type MockLedgerRevisionSnapshot = {
  createdAt: string
  fact: string
  profitDeltaWon: number
  profitWon: number
  resolutionCode: string
  revision: LedgerRevision
  source: 'BASELINE' | 'USER_FACT'
  transactionId?: string
  transactionTitle?: string
}

const ledgerBaseRevisionNumber = 4

function getRevisionNumber(revisionId: string) {
  return Number(revisionId.match(/rev\.(\d+)$/)?.[1] ?? 0)
}

export function deriveMockLedgerRevisionHistory(
  transactions: LedgerTransaction[],
): MockLedgerRevisionSnapshot[] {
  const resolvedReviews = transactions
    .filter(
    (transaction) =>
      transaction.reviewTask?.status === 'RESOLVED' &&
      transaction.reviewTask.selectedOptionId,
    )
    .sort(
      (left, right) =>
        getRevisionNumber(left.journey.currentRevisionId) -
        getRevisionNumber(right.journey.currentRevisionId),
    )

  const history: MockLedgerRevisionSnapshot[] = [
    {
      createdAt: '2027-03-14T08:44:00+09:00',
      fact: '검토 시작 전 기준 계산',
      profitDeltaWon: 0,
      profitWon: Number(ledgerRevisionResults['rev.4'].profitWon),
      resolutionCode: 'BASELINE_CALCULATION',
      revision: 'rev.4',
      source: 'BASELINE',
    },
  ]

  resolvedReviews.forEach((transaction) => {
    const selectedOption = transaction.reviewTask?.options.find(
      (option) => option.id === transaction.reviewTask?.selectedOptionId,
    )
    const previous = history.at(-1)
    const profitDeltaWon = selectedOption?.profitDeltaWon ?? 0
    const revisionNumber =
      getRevisionNumber(transaction.journey.currentRevisionId) ||
      ledgerBaseRevisionNumber + history.length

    history.push({
      createdAt:
        transaction.reviewTask?.resolvedAt ?? '2027-07-20T09:12:00+09:00',
      fact: selectedOption?.label ?? transaction.detail,
      profitDeltaWon,
      profitWon:
        (previous?.profitWon ??
          Number(ledgerRevisionResults['rev.4'].profitWon)) + profitDeltaWon,
      resolutionCode: selectedOption?.resolutionCode ?? 'USER_FACT_CONFIRMED',
      revision: `rev.${revisionNumber}`,
      source: 'USER_FACT',
      transactionId: transaction.id,
      transactionTitle: transaction.title,
    })
  })

  return history
}

export function deriveMockLedgerResult(transactions: LedgerTransaction[]) {
  const history = deriveMockLedgerRevisionHistory(transactions)
  const current = history[history.length - 1]!

  return {
    profitWon: current.profitWon,
    resolvedReviewCount: history.length - 1,
    revision: current.revision,
  }
}

export function formatMockLedgerWon(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''

  return `${sign}${Math.abs(value).toLocaleString('ko-KR')}원`
}

export type MockLedgerPublication = {
  profitWon: number
  publishedAt: string
  revision: string
  transactionCount: number
}

export const ledgerPublicationStorageKey = 'daejang.mock.ledger-publication.v2'

export function readMockLedgerPublication(): MockLedgerPublication | null {
  if (typeof window === 'undefined') return null

  try {
    const stored = window.localStorage.getItem(ledgerPublicationStorageKey)

    return stored ? (JSON.parse(stored) as MockLedgerPublication) : null
  } catch {
    window.localStorage.removeItem(ledgerPublicationStorageKey)
    return null
  }
}

export function publishMockLedgerSnapshot(
  transactions: LedgerTransaction[],
): MockLedgerPublication {
  const ledgerResult = deriveMockLedgerResult(transactions)
  const publication = {
    profitWon: ledgerResult.profitWon,
    publishedAt: '2027-08-04 11:05',
    revision: ledgerResult.revision,
    transactionCount: transactions.length,
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        ledgerPublicationStorageKey,
        JSON.stringify(publication),
      )
    } catch {
      // The current UI still reaches the verified state when storage is unavailable.
    }
  }

  return publication
}

function formatMockLedgerDelta(value: number) {
  if (value === 0) return '변경 없음'

  return formatMockLedgerWon(value)
}

export type LedgerStateMock = {
  actionLabel: string
  badge: string
  description: string
  nextDescription: string
  nextState: LedgerFlowState
  noticeBody: string
  noticeTitle: string
  rows: Array<{
    detail: string
    label: string
    status: string
    tone?: LedgerTone
  }>
  stateLabel: string
  summary: Array<{ label: string; value: string; tone?: LedgerTone }>
  summaryValue: string
  title: string
}

export const ledgerPipeline = [
  { key: 'source', label: '원천 데이터' },
  { key: 'normalization', label: '정규화' },
  { key: 'linking', label: '자동 연결' },
  { key: 'valuation', label: '원화 평가' },
  { key: 'review', label: '검토' },
  { key: 'result', label: '결과·근거' },
  { key: 'publication', label: '발행' },
  { key: 'verification', label: 'GIWA 검증' },
] as const

function createJourney({
  id,
  occurredAt,
  sourceArtifactId,
  sourceLocator,
  normalizedDetail,
  interpretationDetail,
  postingDetail,
  valuationDetail,
  valuationStatus,
  revision = 'rev.4',
}: {
  id: string
  interpretationDetail: string
  normalizedDetail: string
  occurredAt: string
  postingDetail: string
  revision?: string
  sourceArtifactId: string
  sourceLocator: string
  valuationDetail: string
  valuationStatus: string
}): LedgerJourney {
  const currentRevisionId = `revision.${id}.${revision}`

  return {
    id: `journey.${id}`,
    transactionId: id,
    occurredAt,
    economicEventId: `economic-event.${id}`,
    eventId: `event.${id}`,
    currentRevisionId,
    sourceArtifactId,
    sourceRecordId: `source-record.${id}`,
    observationIds: [`observation.${id}.1`],
    postingIds: [`posting.${id}.1`, `posting.${id}.2`],
    valuationId: `valuation.${id}.krw`,
    policyVersion: 'kr-tax-ledger.v1.3',
    publicationStatus: 'NOT_READY',
    steps: [
      {
        key: 'source',
        label: '원본',
        detail: sourceLocator,
        evidenceId: `source-record.${id}`,
        status: '보존',
        tone: 'positive',
      },
      {
        key: 'observation',
        label: '관찰',
        detail: normalizedDetail,
        evidenceId: `observation.${id}.1`,
        status: '정규화',
        tone: 'positive',
      },
      {
        key: 'interpretation',
        label: '해석·revision',
        detail: interpretationDetail,
        evidenceId: currentRevisionId,
        status: interpretationDetail.includes('검토') ? '검토 필요' : '확정',
        tone: interpretationDetail.includes('검토') ? 'warning' : 'positive',
      },
      {
        key: 'posting',
        label: 'Posting',
        detail: postingDetail,
        evidenceId: `posting.${id}.1`,
        status: '균형 확인',
        tone: 'positive',
      },
      {
        key: 'valuation',
        label: '원화 평가·Lot',
        detail: valuationDetail,
        evidenceId: `valuation.${id}.krw`,
        status: valuationStatus,
        tone: valuationStatus === '확정' ? 'positive' : 'warning',
      },
      {
        key: 'publication',
        label: '발행',
        detail: 'Manifest 미생성 · 검토 완료 후 snapshot 고정',
        evidenceId: `manifest-candidate.${id}`,
        status: '대기',
        tone: 'accent',
      },
    ],
  }
}

function createReviewTask({
  id,
  prompt,
  reasonCode,
  options,
  status = 'OPEN',
}: {
  id: string
  options: Array<
    [
      string,
      string,
      LedgerReviewOption['outcome'],
      profitDeltaWon?: number,
    ]
  >
  prompt: string
  reasonCode: string
  status?: LedgerReviewTask['status']
}): LedgerReviewTask {
  return {
    id: `review.${id}`,
    prompt,
    reasonCode,
    status,
    heldAt: status === 'ON_HOLD' ? '2027-07-20T09:03:00+09:00' : undefined,
    options: options.map(
      ([label, resolutionCode, outcome, profitDeltaWon = 0], index) => ({
      id: `review-option.${id}.${index + 1}`,
      label,
      profitDeltaWon,
      resolutionCode,
      outcome,
      }),
    ),
  }
}

const ledgerTransactionItems: LedgerTransaction[] = [
  {
    id: 'btc-sell',
    asset: 'BTC',
    title: 'BTC 매도',
    occurredAt: '2027-03-14T09:12:00+09:00',
    date: '03-14',
    detail: '취득 출처 확인',
    impact: '+875,000',
    impactTone: 'positive',
    status: '잠정',
    statusCode: 'provisional',
    statusTone: 'warning',
    confirmed: false,
    source: { id: 'upbit', name: 'Upbit', type: 'exchange' },
    journey: createJourney({
      id: 'btc-sell',
      occurredAt: '2027-03-14T09:12:00+09:00',
      sourceArtifactId: 'artifact.upbit.2027-03.sha256-78fe41ac',
      sourceLocator: 'Upbit 거래내역서 PDF · p.3 · 12행',
      normalizedDetail: 'trade.sell · BTC 0.182 · KRW 13,840,000',
      interpretationDetail: '매도 이벤트 확정 · 취득 출처 검토 필요',
      postingDetail: 'BTC −0.182 / KRW +13,840,000',
      valuationDetail: '처분가 확정 · 취득 Lot 후보 1건',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'btc-sell',
      reasonCode: 'LOT_ACQUISITION_SOURCE_REQUIRED',
      prompt: '이 BTC Lot의 취득 출처를 선택해 주세요.',
      options: [
        [
          'Upbit 매수분입니다',
          'USER_CONFIRMED_CEX_ACQUISITION',
          'confirmed',
          180_000,
        ],
        [
          '외부 지갑에서 받은 자산입니다',
          'USER_DECLARED_EXTERNAL_INBOUND',
          'confirmed',
          -90_000,
        ],
        ['취득 자료를 모르겠습니다', 'INBOUND_ORIGIN_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'eth-sell',
    asset: 'ETH',
    title: 'ETH 매도',
    occurredAt: '2027-03-12T17:40:00+09:00',
    date: '03-12',
    detail: '확인 거래 여정',
    impact: '+820,000',
    impactTone: 'positive',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'upbit', name: 'Upbit', type: 'exchange' },
    journey: createJourney({
      id: 'eth-sell',
      occurredAt: '2027-03-12T17:40:00+09:00',
      sourceArtifactId: 'artifact.upbit.2027-03.sha256-78fe41ac',
      sourceLocator: 'Upbit 거래내역서 PDF · p.2 · 8행',
      normalizedDetail: 'trade.sell · ETH 1.4 · KRW 5,320,000',
      interpretationDetail: 'ETH 매도 · 사용자 확인 rev.4',
      postingDetail: 'ETH −1.4 / KRW +5,320,000',
      valuationDetail: '연간 총평균 취득가 적용 · 예상 손익 +820,000원',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'eth-transfer',
    asset: 'ETH',
    title: 'ETH 전송',
    occurredAt: '2027-03-10T11:18:00+09:00',
    date: '03-10',
    detail: '본인 지갑?',
    impact: '영향 +180,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'eth-transfer',
      occurredAt: '2027-03-10T11:18:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21940102',
      sourceLocator: 'Ethereum receipt · tx 0x72ad…9c31 · log 0',
      normalizedDetail: 'transfer.out · ETH 0.8 · 0x8f…3a2b → 0x41…91ce',
      interpretationDetail: '소유권·동일 세무주체 검토 필요',
      postingDetail: 'ETH 출고 observation · 상대 계정 연결 후보',
      valuationDetail: '자기이체 확정 전 손익 계산 차단',
      valuationStatus: '검토',
    }),
    reviewTask: createReviewTask({
      id: 'eth-transfer',
      reasonCode: 'OWNERSHIP_EVIDENCE_REQUIRED',
      prompt: '도착 지갑과 이체 당시 자산의 귀속 관계를 선택해 주세요.',
      options: [
        ['내가 관리하는 본인 지갑입니다', 'USER_DECLARED_SELF_TRANSFER', 'confirmed'],
        [
          '다른 사람에게 보낸 자산입니다',
          'USER_DECLARED_EXTERNAL_TRANSFER',
          'confirmed',
          180_000,
        ],
        ['소유 관계를 확인할 수 없습니다', 'ALLOCATION_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'token-swap',
    asset: 'ARB',
    title: '토큰 스왑',
    occurredAt: '2027-03-08T21:05:00+09:00',
    date: '03-08',
    detail: '가격 기준',
    impact: '영향 −32,000',
    impactTone: 'negative',
    status: '보류',
    statusCode: 'on_hold',
    statusTone: 'warning',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'token-swap',
      occurredAt: '2027-03-08T21:05:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21901244',
      sourceLocator: 'Ethereum receipt · tx 0x8ce1…401b · logs 12–15',
      normalizedDetail: 'dex.swap · ARB 2,100 → USDC 1,720 · fee 별도',
      interpretationDetail: 'DEX 교환 이벤트 · 가격 증거 검토 필요',
      postingDetail: 'ARB −2,100 / USDC +1,720 / ETH fee −0.004',
      valuationDetail: 'ARB 기준가격 후보 불일치 · −32,000원 범위',
      valuationStatus: '보류',
    }),
    reviewTask: createReviewTask({
      id: 'token-swap',
      reasonCode: 'PRICE_EVIDENCE_MISSING',
      prompt: '이 스왑에 적용할 가격 근거가 준비되었나요?',
      status: 'ON_HOLD',
      options: [
        [
          '거래 시점 가격 자료를 첨부했습니다',
          'PRICE_EVIDENCE_USER_SUPPLIED',
          'confirmed',
          -32_000,
        ],
        ['아직 가격 자료가 없습니다', 'PRICE_EVIDENCE_MISSING', 'on_hold'],
      ],
    }),
  },
  {
    id: 'nft-sell',
    asset: 'NFT',
    title: 'NFT 매도',
    occurredAt: '2027-03-06T14:32:00+09:00',
    date: '03-06',
    detail: '취득원가 없음',
    impact: '원가 미확정',
    impactTone: 'negative',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'nft-sell',
      occurredAt: '2027-03-06T14:32:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21887011',
      sourceLocator: 'Ethereum receipt · tx 0x124f…b67e · logs 4–7',
      normalizedDetail: 'nft.sell · collection #381 · WETH 0.42',
      interpretationDetail: 'NFT 매도 확정 · 취득가 검토 필요',
      postingDetail: 'NFT −1 / WETH +0.42 / ETH fee −0.003',
      valuationDetail: '처분가 1,512,000원 · 취득 Lot 미연결',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'nft-sell',
      reasonCode: 'LOT_COVERAGE_PARTIAL',
      prompt: '이 NFT의 취득가액 근거를 선택해 주세요.',
      options: [
        [
          '민팅·매수 원본을 확인했습니다',
          'USER_CONFIRMED_NFT_COST',
          'confirmed',
          264_000,
        ],
        [
          '무상으로 받은 NFT입니다',
          'USER_DECLARED_ZERO_COST_ACQUISITION',
          'confirmed',
          512_000,
        ],
        ['취득 자료가 없습니다', 'LOT_COVERAGE_PARTIAL', 'on_hold'],
      ],
    }),
  },
  {
    id: 'usdc-deposit',
    asset: 'USDC',
    title: 'USDC 입금',
    occurredAt: '2027-03-05T08:26:00+09:00',
    date: '03-05',
    detail: '확인 거래 여정',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'usdc-deposit',
      occurredAt: '2027-03-05T08:26:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-27118402',
      sourceLocator: 'Base receipt · tx 0xe310…a922 · log 3',
      normalizedDetail: 'transfer.in · USDC 2,500 · verified contract',
      interpretationDetail: '확인된 본인 지갑 간 입금 · rev.3',
      postingDetail: 'USDC +2,500 / transfer continuity 유지',
      valuationDetail: '자기이체 · 실현 손익 없음',
      valuationStatus: '확정',
      revision: 'rev.3',
    }),
  },
  {
    id: 'bridge-deposit',
    asset: 'ETH',
    title: '브리지 입금',
    occurredAt: '2027-03-02T19:11:00+09:00',
    date: '03-02',
    detail: 'Base',
    impact: '감지 지원',
    impactTone: 'neutral',
    status: '보류',
    statusCode: 'on_hold',
    statusTone: 'warning',
    confirmed: false,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'bridge-deposit',
      occurredAt: '2027-03-02T19:11:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-27041091',
      sourceLocator: 'Base receipt · tx 0x4b90…7ae1 · bridge log 1',
      normalizedDetail: 'bridge.in · ETH 0.64 · L1 message 후보 연결',
      interpretationDetail: '브리지 자산 동일성 검토 필요',
      postingDetail: 'Base ETH +0.64 / Ethereum 출고 후보 −0.64',
      valuationDetail: '브리지 연속성 확정 전 Lot 이월 차단',
      valuationStatus: '보류',
    }),
    reviewTask: createReviewTask({
      id: 'bridge-deposit',
      reasonCode: 'BRIDGE_IDENTITY_UNRESOLVED',
      prompt: '연결된 Ethereum 출고와 같은 자산 이동인지 확인해 주세요.',
      status: 'ON_HOLD',
      options: [
        ['같은 자산의 브리지 이동입니다', 'USER_CONFIRMED_BRIDGE_CONTINUITY', 'confirmed'],
        ['연결 관계를 확인할 수 없습니다', 'BRIDGE_IDENTITY_UNRESOLVED', 'on_hold'],
      ],
    }),
  },
  {
    id: 'staking-reward',
    asset: 'ETH',
    title: '스테이킹 보상',
    occurredAt: '2027-02-28T10:04:00+09:00',
    date: '02-28',
    detail: '소득 분류 확인',
    impact: '+96,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'staking-reward',
      occurredAt: '2027-02-28T10:04:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21820991',
      sourceLocator: 'Ethereum consensus reward · epoch 261,442',
      normalizedDetail: 'reward.in · ETH 0.024 · validator distribution',
      interpretationDetail: '스테이킹 보상 · 소득 귀속 시점 검토 필요',
      postingDetail: 'ETH +0.024 / reward income 후보 +96,000 KRW',
      valuationDetail: '수령 시점 가격 snapshot 4,000,000 KRW/ETH',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'staking-reward',
      reasonCode: 'REWARD_INCOME_CLASSIFICATION_REQUIRED',
      prompt: '이 입금이 직접 참여한 스테이킹 보상인지 확인해 주세요.',
      options: [
        [
          '직접 참여한 스테이킹 보상입니다',
          'USER_CONFIRMED_STAKING_REWARD',
          'confirmed',
          96_000,
        ],
        [
          '거래소에서 지급한 리워드입니다',
          'USER_CONFIRMED_CEX_REWARD',
          'confirmed',
          72_000,
        ],
        ['보상 성격을 확인할 수 없습니다', 'REWARD_ORIGIN_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'gas-fee',
    asset: 'ETH',
    title: '네트워크 수수료',
    occurredAt: '2027-02-24T16:22:00+09:00',
    date: '02-24',
    detail: '거래 부대비용 연결',
    impact: '영향 −18,000',
    impactTone: 'negative',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'gas-fee',
      occurredAt: '2027-02-24T16:22:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21799213',
      sourceLocator: 'Ethereum receipt · tx 0xf71a…003e · gasUsed',
      normalizedDetail: 'fee.network · ETH 0.0045 · EIP-1559',
      interpretationDetail: '연결 거래의 네트워크 부대비용 · rev.4',
      postingDetail: 'ETH fee −0.0045 / linked event token-swap',
      valuationDetail: '거래 시점 가격으로 수수료 18,000원 확정',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'wrap-eth',
    asset: 'WETH',
    title: 'ETH 래핑',
    occurredAt: '2027-02-20T13:08:00+09:00',
    date: '02-20',
    detail: '자산 동일성 확인',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'wrap-eth',
      occurredAt: '2027-02-20T13:08:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21770114',
      sourceLocator: 'WETH deposit event · tx 0x0bd3…7ad1 · log 2',
      normalizedDetail: 'wrap · ETH 0.5 → WETH 0.5',
      interpretationDetail: '동일 소유자 내 자산 표현 변경 · rev.4',
      postingDetail: 'ETH −0.5 / WETH +0.5 / ownership continuity',
      valuationDetail: '처분 없음 · 기존 Lot 이월',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'airdrop-receipt',
    asset: 'OP',
    title: '에어드롭 수령',
    occurredAt: '2027-02-14T20:31:00+09:00',
    date: '02-14',
    detail: '무상 취득 분류',
    impact: '+144,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'airdrop-receipt',
      occurredAt: '2027-02-14T20:31:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-26791002',
      sourceLocator: 'Base receipt · tx 0xaa19…44c2 · Transfer log 9',
      normalizedDetail: 'airdrop.in · OP 240 · claim contract',
      interpretationDetail: '무상 취득 또는 보상 소득 분류 검토 필요',
      postingDetail: 'OP +240 / counterparty airdrop distributor',
      valuationDetail: '수령 시점 평가 144,000원 · 분류 전 잠정',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'airdrop-receipt',
      reasonCode: 'AIRDROP_PURPOSE_REQUIRED',
      prompt: '이 토큰을 받은 이유를 선택해 주세요.',
      options: [
        [
          '서비스 이용에 따른 에어드롭입니다',
          'USER_CONFIRMED_PROTOCOL_AIRDROP',
          'confirmed',
          144_000,
        ],
        [
          '업무·용역 대가로 받은 토큰입니다',
          'USER_CONFIRMED_SERVICE_COMPENSATION',
          'confirmed',
          144_000,
        ],
        ['받은 이유를 확인할 수 없습니다', 'AIRDROP_PURPOSE_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'reverted-swap',
    asset: 'USDC',
    title: '실패한 스왑',
    occurredAt: '2027-02-11T07:42:00+09:00',
    date: '02-11',
    detail: '실행 실패 · 표시 전용',
    impact: '가스비만 반영',
    impactTone: 'neutral',
    status: '표시 전용',
    statusCode: 'display_only',
    statusTone: 'neutral',
    confirmed: false,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'reverted-swap',
      occurredAt: '2027-02-11T07:42:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-26760118',
      sourceLocator: 'Base receipt · tx 0xc172…dd09 · status 0',
      normalizedDetail: 'transaction.reverted · attempted swap USDC → ETH',
      interpretationDetail: '자산 교환 미발생 · 실패 거래로 확정',
      postingDetail: '토큰 posting 없음 / gas observation만 별도 연결',
      valuationDetail: '처분 손익 없음 · 네트워크 수수료만 별도 평가',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'sol-sell',
    asset: 'SOL',
    title: 'SOL 매도',
    occurredAt: '2027-02-08T18:14:00+09:00',
    date: '02-08',
    detail: '거래소 체결·원가 연결',
    impact: '+215,000',
    impactTone: 'positive',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'bithumb', name: 'Bithumb', type: 'exchange' },
    journey: createJourney({
      id: 'sol-sell',
      occurredAt: '2027-02-08T18:14:00+09:00',
      sourceArtifactId: 'artifact.bithumb.2027-02.sha256-91a50d2c',
      sourceLocator: 'Bithumb 거래 CSV · 2027-02 · 41행',
      normalizedDetail: 'trade.sell · SOL 12.4 · KRW 2,186,000',
      interpretationDetail: '현물 매도 · 거래소 매수 Lot과 자동 연결',
      postingDetail: 'SOL −12.4 / KRW +2,186,000',
      valuationDetail: '실현 손익 +215,000원',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'lp-withdrawal',
    asset: 'ETH·USDC',
    title: '유동성 회수',
    occurredAt: '2027-02-06T12:46:00+09:00',
    date: '02-06',
    detail: '원금·보상 분리 필요',
    impact: '영향 +38,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'lp-withdrawal',
      occurredAt: '2027-02-06T12:46:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21693281',
      sourceLocator: 'Uniswap V3 position receipt · tx 0x1ab4…e821',
      normalizedDetail: 'liquidity.remove · ETH 0.31 + USDC 1,240',
      interpretationDetail: '유동성 원금 회수와 수수료 보상 분리 필요',
      postingDetail: 'LP position −1 / ETH +0.31 / USDC +1,240',
      valuationDetail: '수수료 보상 후보 38,000원',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'lp-withdrawal',
      reasonCode: 'LP_REWARD_SPLIT_REQUIRED',
      prompt: '회수 자산 중 유동성 보상분의 처리 방법을 선택해 주세요.',
      options: [
        [
          '원금과 수수료 보상으로 분리합니다',
          'USER_CONFIRMED_LP_REWARD_SPLIT',
          'confirmed',
          38_000,
        ],
        [
          '전체를 자산 교환으로 처리합니다',
          'USER_DECLARED_LP_AS_SWAP',
          'confirmed',
          -74_000,
        ],
        ['풀 내역을 더 확인하겠습니다', 'LP_REWARD_SPLIT_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'lending-interest',
    asset: 'USDC',
    title: '대출 이자 수령',
    occurredAt: '2027-02-03T09:37:00+09:00',
    date: '02-03',
    detail: '이자·원금 구분',
    impact: '+72,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'lending-interest',
      occurredAt: '2027-02-03T09:37:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-26440119',
      sourceLocator: 'Aave withdrawal receipt · tx 0x28c1…a210',
      normalizedDetail: 'lending.withdraw · aUSDC 4,072 → USDC 4,072',
      interpretationDetail: '예치 원금 4,000 USDC · 초과분 성격 검토 필요',
      postingDetail: 'aUSDC −4,072 / USDC +4,072',
      valuationDetail: '이자 후보 72 USDC · 72,000원',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'lending-interest',
      reasonCode: 'LENDING_YIELD_CLASSIFICATION_REQUIRED',
      prompt: '원금을 초과해 받은 72 USDC의 성격을 선택해 주세요.',
      options: [
        [
          '대출 프로토콜 이자 소득입니다',
          'USER_CONFIRMED_LENDING_YIELD',
          'confirmed',
          72_000,
        ],
        ['원금 반환에 포함된 금액입니다', 'USER_DECLARED_PRINCIPAL_RETURN', 'confirmed'],
        [
          '프로토콜 명세를 더 확인하겠습니다',
          'LENDING_YIELD_CLASSIFICATION_UNKNOWN',
          'on_hold',
        ],
      ],
    }),
  },
  {
    id: 'usdt-depeg-settlement',
    asset: 'USDT',
    title: 'USDT 디페그 정산',
    occurredAt: '2027-01-31T14:24:00+09:00',
    date: '01-31',
    detail: '가격 이탈 손실 분류',
    impact: '영향 −115,000',
    impactTone: 'negative',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'bithumb', name: 'Bithumb', type: 'exchange' },
    journey: createJourney({
      id: 'usdt-depeg-settlement',
      occurredAt: '2027-01-31T14:24:00+09:00',
      sourceArtifactId: 'artifact.bithumb.2027-01.sha256-a71e0c42',
      sourceLocator: 'Bithumb 거래 CSV · 2027-01 · 188행',
      normalizedDetail: 'trade.sell · USDT 2,500 · KRW 3,485,000',
      interpretationDetail: 'stablecoin 가격 이탈 · 손실 귀속 검토 필요',
      postingDetail: 'USDT −2,500 / KRW +3,485,000',
      valuationDetail: '기준 환율 대비 평가 차이 −115,000원',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'usdt-depeg-settlement',
      reasonCode: 'STABLECOIN_DEPEG_CLASSIFICATION_REQUIRED',
      prompt: '이 정산의 가격 이탈을 실제 처분 손실로 확정할까요?',
      options: [
        [
          '실제 체결된 디페그 손실입니다',
          'USER_CONFIRMED_DEPEG_LOSS',
          'confirmed',
          -115_000,
        ],
        [
          '거래소 표시 오류로 정정된 체결입니다',
          'USER_CONFIRMED_EXCHANGE_CORRECTION',
          'confirmed',
        ],
        ['거래소 정정 내역을 더 확인하겠습니다', 'DEPEG_EVIDENCE_PENDING', 'on_hold'],
      ],
    }),
  },
  {
    id: 'restaking-reward',
    asset: 'EIGEN',
    title: '재스테이킹 보상',
    occurredAt: '2027-01-30T08:52:00+09:00',
    date: '01-30',
    detail: '보상 귀속 시점 확인',
    impact: '+128,000',
    impactTone: 'positive',
    status: '검토 필요',
    statusCode: 'needs_review',
    statusTone: 'negative',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'restaking-reward',
      occurredAt: '2027-01-30T08:52:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21611883',
      sourceLocator: 'EigenLayer claim receipt · tx 0x53c0…91ae · log 6',
      normalizedDetail: 'reward.claim · EIGEN 160 · operator distribution',
      interpretationDetail: '재스테이킹 보상 · 수령 조건 검토 필요',
      postingDetail: 'EIGEN +160 / reward distributor',
      valuationDetail: '수령 시점 평가 128,000원',
      valuationStatus: '부분',
    }),
    reviewTask: createReviewTask({
      id: 'restaking-reward',
      reasonCode: 'RESTAKING_REWARD_VESTING_REQUIRED',
      prompt: '이 보상은 즉시 처분 가능한 수령분인가요?',
      options: [
        [
          '즉시 처분 가능한 보상입니다',
          'USER_CONFIRMED_LIQUID_RESTAKING_REWARD',
          'confirmed',
          128_000,
        ],
        [
          '베스팅 조건이 있는 보상입니다',
          'USER_CONFIRMED_VESTED_RESTAKING_REWARD',
          'confirmed',
          92_000,
        ],
        ['베스팅 조건을 확인할 수 없습니다', 'RESTAKING_VESTING_UNKNOWN', 'on_hold'],
      ],
    }),
  },
  {
    id: 'exchange-fee-rebate',
    asset: 'KRW',
    title: '거래소 수수료 환급',
    occurredAt: '2027-01-29T23:41:00+09:00',
    date: '01-29',
    detail: '월간 수수료 정산',
    impact: '+41,000',
    impactTone: 'positive',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'upbit', name: 'Upbit', type: 'exchange' },
    journey: createJourney({
      id: 'exchange-fee-rebate',
      occurredAt: '2027-01-29T23:41:00+09:00',
      sourceArtifactId: 'artifact.upbit.2027-01.sha256-4bd8c102',
      sourceLocator: 'Upbit 원화 입출금 내역 · 2027-01 · 29행',
      normalizedDetail: 'fee.rebate · KRW 41,000 · monthly campaign',
      interpretationDetail: '거래 수수료 환급 · 연결 주문 14건',
      postingDetail: 'KRW +41,000 / fee expense reversal',
      valuationDetail: '환급액 41,000원 확정',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'reorg-invalidated-transfer',
    asset: 'ETH',
    title: 'Reorg 무효화 전송',
    occurredAt: '2027-01-29T22:44:00+09:00',
    date: '01-29',
    detail: '고아 블록 · 표시 전용',
    impact: '계산 제외',
    impactTone: 'neutral',
    status: '표시 전용',
    statusCode: 'display_only',
    statusTone: 'neutral',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'reorg-invalidated-transfer',
      occurredAt: '2027-01-29T22:44:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.orphan-block-21610791',
      sourceLocator: 'Ethereum block 21,610,791 · orphaned receipt',
      normalizedDetail: 'transfer.out · ETH 0.12 · invalidated by reorg',
      interpretationDetail: 'canonical block 불일치 · 계산 대상에서 제외',
      postingDetail: 'posting 미생성 / invalidation audit만 보존',
      valuationDetail: '무효화 run · 손익 계산 제외',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'bridge-withdrawal',
    asset: 'ETH',
    title: '브리지 출금',
    occurredAt: '2027-01-29T22:08:00+09:00',
    date: '01-29',
    detail: 'L1·L2 메시지 연결',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'base', name: 'Base 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'bridge-withdrawal',
      occurredAt: '2027-01-29T22:08:00+09:00',
      sourceArtifactId: 'artifact.base.8453.block-26211820',
      sourceLocator: 'Base withdrawal · tx 0xd430…bb19 · message 0',
      normalizedDetail: 'bridge.out · ETH 0.28 · L2ToL1MessagePasser',
      interpretationDetail: 'Ethereum 수령과 message hash 일치',
      postingDetail: 'Base ETH −0.28 / Ethereum ETH +0.28',
      valuationDetail: '자기 지갑 간 이동 · 손익 없음',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'btc-buy',
    asset: 'BTC',
    title: 'BTC 매수',
    occurredAt: '2027-01-24T15:21:00+09:00',
    date: '01-24',
    detail: '취득 Lot 생성',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'upbit', name: 'Upbit', type: 'exchange' },
    journey: createJourney({
      id: 'btc-buy',
      occurredAt: '2027-01-24T15:21:00+09:00',
      sourceArtifactId: 'artifact.upbit.2027-01.sha256-31ef8bd0',
      sourceLocator: 'Upbit 거래내역서 PDF · p.1 · 19행',
      normalizedDetail: 'trade.buy · BTC 0.041 · KRW 3,980,000',
      interpretationDetail: '원화 매수 · BTC 취득 Lot 생성',
      postingDetail: 'BTC +0.041 / KRW −3,980,000',
      valuationDetail: '취득원가 3,984,120원(수수료 포함)',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'validator-slashing',
    asset: 'ETH',
    title: '검증자 슬래싱',
    occurredAt: '2027-01-18T06:42:00+09:00',
    date: '01-18',
    detail: '손실 확정',
    impact: '영향 −54,000',
    impactTone: 'negative',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'validator-slashing',
      occurredAt: '2027-01-18T06:42:00+09:00',
      sourceArtifactId: 'artifact.ethereum.consensus.epoch-258021',
      sourceLocator: 'Beacon validator statement · epoch 258,021',
      normalizedDetail: 'validator.penalty · ETH 0.0135',
      interpretationDetail: '검증자 패널티 · 운영 손실로 분류',
      postingDetail: 'ETH −0.0135 / staking penalty',
      valuationDetail: '발생 시점 평가 손실 54,000원',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'token-migration',
    asset: 'MATIC·POL',
    title: '토큰 마이그레이션',
    occurredAt: '2027-01-11T13:19:00+09:00',
    date: '01-11',
    detail: '프로토콜 전환 · 표시 전용',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '표시 전용',
    statusCode: 'display_only',
    statusTone: 'neutral',
    confirmed: false,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'token-migration',
      occurredAt: '2027-01-11T13:19:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21448820',
      sourceLocator: 'POL migration contract · tx 0x9bf0…33a8',
      normalizedDetail: 'token.migrate · MATIC 1,800 → POL 1,800',
      interpretationDetail: '공식 1:1 토큰 전환 · 경제적 처분 없음',
      postingDetail: 'MATIC −1,800 / POL +1,800',
      valuationDetail: '기존 Lot과 취득원가 이월',
      valuationStatus: '확정',
    }),
  },
  {
    id: 'nft-mint',
    asset: 'NFT',
    title: 'NFT 민팅',
    occurredAt: '2027-01-04T20:05:00+09:00',
    date: '01-04',
    detail: '민팅 원가 확정',
    impact: '영향 없음',
    impactTone: 'neutral',
    status: '확인됨',
    statusCode: 'confirmed',
    statusTone: 'positive',
    confirmed: true,
    source: { id: 'ethereum', name: 'Ethereum 지갑', type: 'wallet' },
    journey: createJourney({
      id: 'nft-mint',
      occurredAt: '2027-01-04T20:05:00+09:00',
      sourceArtifactId: 'artifact.ethereum.1.block-21397110',
      sourceLocator: 'ERC-721 mint receipt · tx 0x60e2…71fc',
      normalizedDetail: 'nft.mint · collection #381 · token 901',
      interpretationDetail: '직접 민팅 · 생성 자산 취득',
      postingDetail: 'NFT +1 / ETH −0.08 / gas −0.002',
      valuationDetail: '민팅가와 gas를 취득원가로 연결',
      valuationStatus: '확정',
    }),
  },
]

export const ledgerTransactionsResponse: LedgerTransactionsResponse = {
  data: {
    items: ledgerTransactionItems,
    page: 1,
    pageSize: 10,
    total: ledgerTransactionItems.length,
  },
  meta: {
    generatedAt: '2027-08-04T10:20:00+09:00',
    persistence: 'localStorage',
    schemaVersion: 'ledger-transactions.v5',
    source: 'mock',
  },
}

export const ledgerMockStorageKey = 'daejang.mock.ledger-transactions.v5'

function cloneTransactions(transactions: LedgerTransaction[]) {
  return transactions.map((transaction) => ({
    ...transaction,
    source: { ...transaction.source },
    journey: {
      ...transaction.journey,
      observationIds: [...transaction.journey.observationIds],
      postingIds: [...transaction.journey.postingIds],
      steps: transaction.journey.steps.map((step) => ({ ...step })),
    },
    reviewTask: transaction.reviewTask
      ? {
          ...transaction.reviewTask,
          options: transaction.reviewTask.options.map((option) => ({ ...option })),
        }
      : undefined,
  }))
}

function persistMockLedgerTransactions(transactions: LedgerTransaction[]) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      ledgerMockStorageKey,
      JSON.stringify({
        items: transactions,
        schemaVersion: ledgerTransactionsResponse.meta.schemaVersion,
      }),
    )
  } catch {
    // The in-memory state still works when browser storage is unavailable.
  }
}

export function readMockLedgerTransactions(): LedgerTransactionsResponse {
  let items = cloneTransactions(ledgerTransactionsResponse.data.items)

  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(ledgerMockStorageKey)
      const parsed = stored
        ? (JSON.parse(stored) as {
            items?: LedgerTransaction[]
            schemaVersion?: string
          })
        : null

      if (
        parsed?.schemaVersion === ledgerTransactionsResponse.meta.schemaVersion &&
        Array.isArray(parsed.items) &&
        parsed.items.length > 0
      ) {
        items = cloneTransactions(parsed.items)
      }
    } catch {
      window.localStorage.removeItem(ledgerMockStorageKey)
    }
  }

  return {
    data: {
      ...ledgerTransactionsResponse.data,
      items,
    },
    meta: { ...ledgerTransactionsResponse.meta },
  }
}

export function resetMockLedgerTransactions(): LedgerTransactionsResponse {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(ledgerMockStorageKey)
    window.localStorage.removeItem('daejang.mock.ledger-transactions.v1')
    window.localStorage.removeItem('daejang.mock.ledger-transactions.v2')
    window.localStorage.removeItem('daejang.mock.ledger-transactions.v3')
    window.localStorage.removeItem(ledgerPublicationStorageKey)
  }

  return readMockLedgerTransactions()
}

export function submitMockLedgerReview(
  transactions: LedgerTransaction[],
  transactionId: string,
  optionId: string,
): {
  result: LedgerReviewResult
  transactions: LedgerTransaction[]
} {
  const current = transactions.find((transaction) => transaction.id === transactionId)

  if (!current) {
    throw new Error(`Mock transaction not found: ${transactionId}`)
  }

  const selectedOption = current.reviewTask?.options.find(
    (option) => option.id === optionId,
  )

  if (!current.reviewTask || !selectedOption) {
    throw new Error(`Mock review option not found: ${transactionId}/${optionId}`)
  }

  const isConfirmed = selectedOption.outcome === 'confirmed'
  const previousResult = deriveMockLedgerResult(transactions)
  const nextRevisionNumber =
    Number(previousResult.revision.match(/\d+$/)?.[0] ?? ledgerBaseRevisionNumber) +
    (isConfirmed ? 1 : 0)
  const nextRevision = `rev.${nextRevisionNumber}`
  const nextRevisionId = `revision.${transactionId}.${nextRevision}`
  const reviewed: LedgerTransaction = {
    ...current,
    confirmed: isConfirmed,
    detail: selectedOption.label,
    status: isConfirmed ? '확인됨' : '보류',
    statusCode: isConfirmed ? 'confirmed' : 'on_hold',
    statusTone: isConfirmed ? 'positive' : 'warning',
    journey: {
      ...current.journey,
      currentRevisionId: nextRevisionId,
      steps: current.journey.steps.map((step) => {
        if (step.key === 'interpretation') {
          return {
            ...step,
            detail: `${selectedOption.resolutionCode} · 사용자 사실 ${isConfirmed ? '확인' : '미확정'}`,
            evidenceId: nextRevisionId,
            status: isConfirmed ? '확정' : '보류',
            tone: isConfirmed ? 'positive' : 'warning',
          }
        }
        if (step.key === 'valuation') {
          return {
            ...step,
            status: isConfirmed ? '확정' : '보류',
            tone: isConfirmed ? 'positive' : 'warning',
          }
        }
        return { ...step }
      }),
    },
    reviewTask: {
      ...current.reviewTask,
      selectedOptionId: selectedOption.id,
      status: isConfirmed ? 'RESOLVED' : 'ON_HOLD',
      heldAt: isConfirmed ? undefined : '2027-07-20T09:12:00+09:00',
      resolvedAt: isConfirmed ? '2027-07-20T09:12:00+09:00' : undefined,
      options: current.reviewTask.options.map((option) => ({ ...option })),
    },
  }

  const nextTransactions = transactions.map((transaction) =>
    transaction.id === transactionId ? reviewed : transaction,
  )
  const nextResult = deriveMockLedgerResult(nextTransactions)
  persistMockLedgerTransactions(nextTransactions)

  return {
    transactions: nextTransactions,
    result: {
      fact: selectedOption.label,
      impact: formatMockLedgerDelta(
        nextResult.profitWon - previousResult.profitWon,
      ),
      revision: nextResult.revision,
      transaction: reviewed,
    },
  }
}

export function holdMockLedgerReview(
  transactions: LedgerTransaction[],
  transactionId: string,
): LedgerTransaction[] {
  const nextTransactions = transactions.map((transaction) =>
    transaction.id === transactionId
      ? {
          ...transaction,
          confirmed: false,
          status: '보류',
          statusCode: 'on_hold' as const,
          statusTone: 'warning' as const,
          reviewTask: transaction.reviewTask
            ? {
                ...transaction.reviewTask,
                heldAt: '2027-07-20T09:12:00+09:00',
                status: 'ON_HOLD' as const,
                options: transaction.reviewTask.options.map((option) => ({
                  ...option,
                })),
              }
            : undefined,
        }
      : transaction,
  )
  persistMockLedgerTransactions(nextTransactions)

  return nextTransactions
}

export function resumeMockLedgerReview(
  transactions: LedgerTransaction[],
  transactionId: string,
): LedgerTransaction[] {
  const nextTransactions = transactions.map((transaction) =>
    transaction.id === transactionId && transaction.reviewTask
      ? {
          ...transaction,
          reviewTask: {
            ...transaction.reviewTask,
            options: transaction.reviewTask.options.map((option) => ({ ...option })),
          },
        }
      : transaction,
  )
  persistMockLedgerTransactions(nextTransactions)
  return nextTransactions
}

export function validateMockLedgerTransactions(
  transactions: LedgerTransaction[],
): string[] {
  const issues: string[] = []
  const transactionIds = new Set<string>()
  const evidenceIds = new Set<string>()

  for (const transaction of transactions) {
    if (transactionIds.has(transaction.id)) {
      issues.push(`duplicate transaction id: ${transaction.id}`)
    }
    transactionIds.add(transaction.id)

    if (transaction.journey.transactionId !== transaction.id) {
      issues.push(`journey transaction mismatch: ${transaction.id}`)
    }
    if (transaction.journey.occurredAt !== transaction.occurredAt) {
      issues.push(`journey occurredAt mismatch: ${transaction.id}`)
    }
    if (
      (transaction.statusCode === 'needs_review' ||
        transaction.statusCode === 'provisional' ||
        transaction.statusCode === 'on_hold') &&
      !transaction.reviewTask
    ) {
      issues.push(`missing review task: ${transaction.id}`)
    }

    for (const step of transaction.journey.steps) {
      if (evidenceIds.has(step.evidenceId)) {
        issues.push(`duplicate evidence id: ${step.evidenceId}`)
      }
      evidenceIds.add(step.evidenceId)
    }
  }

  return issues
}

export const ledgerStateOrder: LedgerFlowState[] = [
  'S0',
  'S1',
  'S2',
  'S3',
  'R',
  'A',
  'A+',
  'B',
  'C',
  'C0',
  'D',
  'E',
  'P',
  'F',
  'G',
  'G1',
  'OK',
  'J',
]

export const ledgerStateMocks: Record<LedgerFlowState, LedgerStateMock> = {
  S0: {
    stateLabel: 'S0 · 미연결',
    badge: '연결 필요',
    title: '데이터 소스를 먼저 연결해 주세요',
    description: '연결된 거래소·지갑이 없어 거래 목록과 계산 결과를 만들 수 없습니다.',
    noticeTitle: '원본 0건 · 계산 대기',
    noticeBody: '거래소 PDF 또는 지갑 주소 중 하나만 연결해도 최근 데이터부터 수집을 시작합니다.',
    rows: [
      { label: '거래소 파일', detail: 'Upbit · Bithumb PDF/CSV', status: '미연결' },
      { label: '온체인 지갑', detail: 'Ethereum · Base 주소', status: '미연결' },
    ],
    summaryValue: '0건',
    summary: [
      { label: '연결 소스', value: '0' },
      { label: '수집 거래', value: '0' },
      { label: '검토 항목', value: '—' },
    ],
    nextDescription: '첫 데이터 소스를 연결하고 장부 생성을 시작합니다.',
    actionLabel: '소스 연결 →',
    nextState: 'S1',
  },
  S1: {
    stateLabel: 'S1 · BACKFILLING',
    badge: '수집 중',
    title: '최근 거래부터 안전하게 수집하고 있습니다',
    description: '최근 90일을 먼저 처리한 뒤 과거 범위를 백필합니다.',
    noticeTitle: '최근 90일 · 8 / 12건 수집',
    noticeBody: '원본은 수정하지 않고 체크섬과 함께 보존합니다. 이 화면에서는 완료 상태를 mock으로 진행할 수 있습니다.',
    rows: [
      { label: 'Upbit PDF', detail: '2027 거래내역', status: '3 / 3', tone: 'positive' },
      { label: 'Ethereum', detail: '0x8f…3a2b', status: '동기화 중', tone: 'accent' },
      { label: 'Base', detail: '0x41…91ce', status: '대기' },
    ],
    summaryValue: '71%',
    summary: [
      { label: '연결 소스', value: '3' },
      { label: '수집 거래', value: '8 / 12' },
      { label: '검토 항목', value: '계산 중' },
    ],
    nextDescription: '수집 완료 후 거래 목록과 검토 항목을 생성합니다.',
    actionLabel: '수집 완료 보기 →',
    nextState: 'A',
  },
  S2: {
    stateLabel: 'S2 · STALE',
    badge: '갱신 필요',
    title: '마지막 동기화 이후 새 거래가 감지됐습니다',
    description: '기존 revision은 보존하고 새 원본 범위만 추가 수집합니다.',
    noticeTitle: 'Ethereum · 3일 전 동기화',
    noticeBody: '수동 갱신을 시작하면 BACKFILLING 상태로 돌아가 최신 블록부터 확인합니다.',
    rows: [
      { label: 'Ethereum', detail: '마지막 블록 21,394,102', status: 'STALE', tone: 'warning' },
      { label: 'Upbit PDF', detail: '변경 없음', status: '최신', tone: 'positive' },
    ],
    summaryValue: '1 소스',
    summary: [
      { label: '영향 가능 거래', value: '3' },
      { label: '현재 revision', value: 'rev.4' },
      { label: '보존 상태', value: '안전' },
    ],
    nextDescription: '새 범위를 수집하고 기존 결과와 다시 계산합니다.',
    actionLabel: '수동 갱신 →',
    nextState: 'S1',
  },
  S3: {
    stateLabel: 'S3 · SYNC_ERROR',
    badge: '동기화 오류',
    title: '지원하지 않는 거래 형식이 발견됐습니다',
    description: '오류 원본은 격리했고 정상 원본과 기존 revision에는 영향이 없습니다.',
    noticeTitle: 'UPBIT_2027.pdf · 18행',
    noticeBody: '필수 체결 통화 열이 비어 있습니다. 원본을 수정한 파일로 다시 업로드해 주세요.',
    rows: [
      { label: '오류 코드', detail: 'UNSUPPORTED_TRADE_ROW', status: '격리', tone: 'negative' },
      { label: '정상 처리', detail: '11 / 12행', status: '보존', tone: 'positive' },
    ],
    summaryValue: '1 오류',
    summary: [
      { label: '영향 원본', value: '1' },
      { label: '정상 원본', value: '18' },
      { label: '현재 revision', value: 'rev.4' },
    ],
    nextDescription: '수정 파일을 다시 올리면 격리 지점부터 재수집합니다.',
    actionLabel: '재업로드 →',
    nextState: 'S1',
  },
  R: {
    stateLabel: 'R · REORG',
    badge: '재계산 필요',
    title: '체인 재구성으로 일부 계산을 무효화했습니다',
    description: '무효 블록 이후의 파생 결과만 폐기하고 원본 이벤트를 다시 수집합니다.',
    noticeTitle: 'Base · 3개 이벤트 재검증',
    noticeBody: '사용자가 제출한 사실과 이전 revision은 유지됩니다.',
    rows: [
      { label: '무효 블록', detail: '#18,820,441', status: '제외', tone: 'negative' },
      { label: '안전 블록', detail: '#18,820,438', status: '고정', tone: 'positive' },
    ],
    summaryValue: '3건',
    summary: [
      { label: '재수집 대상', value: '3' },
      { label: '보존 사실', value: '2' },
      { label: '현재 revision', value: 'rev.5' },
    ],
    nextDescription: '안전 블록부터 다시 수집하고 손익을 재계산합니다.',
    actionLabel: '재수집 →',
    nextState: 'S1',
  },
  A: {
    stateLabel: 'A · 거래 목록',
    badge: '진행 중 · PARTIAL',
    title: '거래 목록',
    description: '행을 누르면 근거 체인이 펼쳐지고 확인 거래는 전체 여정을 보여줍니다.',
    noticeTitle: '7건 중 3건 검토 필요 · 2건 보류',
    noticeBody: '필터와 페이지는 화면 전환 후에도 유지됩니다.',
    rows: [],
    summaryValue: '+875,000원',
    summary: [],
    nextDescription: '검토 3건을 끝내면 보고서를 새로 생성할 수 있어요.',
    actionLabel: '검토 시작 →',
    nextState: 'B',
  },
  'A+': {
    stateLabel: 'A+ · 확인 거래 압축 여정',
    badge: '확인됨',
    title: '확인 거래의 핵심 근거를 먼저 펼쳤습니다',
    description: '거래 목록의 필터와 페이지를 유지한 채 원본부터 결과까지의 핵심 단계만 빠르게 확인합니다.',
    noticeTitle: 'ETH 매도 · 압축 여정',
    noticeBody: 'Upbit PDF p.2 · 8행 → trade.sell → Lot 확정 → +820,000원 · rev.4',
    rows: [
      { label: '원본', detail: 'Upbit PDF p.2 · 8행', status: '보존', tone: 'positive' },
      { label: '정규화·평가', detail: 'ETH 매도 · +820,000원', status: '확정', tone: 'positive' },
      { label: 'revision', detail: '사용자 판단 1건 · rev.4', status: '연결', tone: 'accent' },
    ],
    summaryValue: '3 핵심 단계',
    summary: [
      { label: '근거 노드', value: '8' },
      { label: 'Coverage', value: '12 / 12' },
      { label: '현재 revision', value: 'rev.4' },
    ],
    nextDescription: '전체 변환 단계와 GIWA 연결까지 상세 여정으로 확인합니다.',
    actionLabel: '전체 여정 보기 →',
    nextState: 'J',
  },
  B: {
    stateLabel: 'B · 근거 확장 / 사실 입력',
    badge: '진행 중 · PARTIAL',
    title: '거래 목록 · 근거 체인',
    description: '결과에서 원본까지 확인하고 필요한 사실만 선택합니다.',
    noticeTitle: '검토 1 / 3',
    noticeBody: '제출한 답변은 새 revision으로 기록됩니다.',
    rows: [],
    summaryValue: '+875,000원',
    summary: [],
    nextDescription: '사실을 제출하면 손익·근거·revision이 즉시 갱신됩니다.',
    actionLabel: '검토 계속 →',
    nextState: 'B',
  },
  C: {
    stateLabel: 'C · revision 갱신',
    badge: '진행 중 · PARTIAL',
    title: '거래 목록 · 1건 반영 완료',
    description: '선택한 사실이 새 계산과 revision에 반영되었습니다.',
    noticeTitle: 'rev.5 생성 · +180,000원',
    noticeBody: '원본과 이전 revision은 그대로 보존됩니다.',
    rows: [],
    summaryValue: '+1,055,000원',
    summary: [],
    nextDescription: '남은 검토 2건을 이어서 사실만 확인해 주세요.',
    actionLabel: '다음 검토 →',
    nextState: 'B',
  },
  C0: {
    stateLabel: 'C0 · 검토 0건',
    badge: '자동 완료',
    title: '추가로 확인할 거래가 없습니다',
    description: '자동 연결과 원화 평가의 근거 범위가 모두 충족됐습니다.',
    noticeTitle: 'Coverage 7 / 7',
    noticeBody: '사용자 판단 없이도 동일 입력으로 같은 결과를 재현할 수 있습니다.',
    rows: [
      { label: '자동 연결', detail: '7개 링크', status: '완료', tone: 'positive' },
      { label: '원화 평가', detail: '7개 거래', status: '완료', tone: 'positive' },
    ],
    summaryValue: '0건',
    summary: [
      { label: '검토 필요', value: '0' },
      { label: 'Coverage', value: '7 / 7' },
      { label: '현재 revision', value: 'rev.4' },
    ],
    nextDescription: '검토 단계를 건너뛰고 산출물 발행으로 이동합니다.',
    actionLabel: '발행 준비 →',
    nextState: 'G',
  },
  D: {
    stateLabel: 'D · 읽기 전용 원본',
    badge: '원본 보기',
    title: '원본 거래를 읽기 전용으로 확인합니다',
    description: '원본은 변경할 수 없으며 사용자 판단은 별도 revision에만 기록됩니다.',
    noticeTitle: 'UPBIT_2027.pdf · p.3 · 12행',
    noticeBody: '2027-03-14 09:12 · BTC 0.182 매도 · KRW 13,840,000',
    rows: [
      { label: '파일 checksum', detail: 'sha256: 78fe…41ac', status: '일치', tone: 'positive' },
      { label: '수집 시각', detail: '2027-03-14 09:20', status: '고정' },
    ],
    summaryValue: '원본 1',
    summary: [
      { label: '페이지', value: '3' },
      { label: '행', value: '12' },
      { label: '수정 가능', value: '아니요' },
    ],
    nextDescription: '원본 확인을 마치고 선택한 사실로 돌아갑니다.',
    actionLabel: '사실 확인으로 →',
    nextState: 'B',
  },
  E: {
    stateLabel: 'E · 검토 완료',
    badge: '검토 완료',
    title: '모든 검토 항목이 하나의 revision으로 수렴했습니다',
    description: '사용자 판단과 근거 체인이 rev.7에 고정되었습니다.',
    noticeTitle: '검토 3 / 3 · Coverage 7 / 7',
    noticeBody: '이제 산출물을 생성하고 GIWA commitment를 검증할 수 있습니다.',
    rows: [
      { label: 'BTC 매도', detail: '취득 출처 확인', status: '완료', tone: 'positive' },
      { label: 'ETH 전송', detail: '본인 지갑 확인', status: '완료', tone: 'positive' },
      { label: 'NFT 매도', detail: '원가 자료 없음', status: '완료', tone: 'positive' },
    ],
    summaryValue: '3 / 3',
    summary: [
      { label: '예상 손익', value: '+1,600,000원', tone: 'positive' },
      { label: 'Coverage', value: '7 / 7' },
      { label: '현재 revision', value: 'rev.7' },
    ],
    nextDescription: '검토 결과를 산출물 snapshot으로 고정합니다.',
    actionLabel: '발행 준비 →',
    nextState: 'G',
  },
  P: {
    stateLabel: 'P · 검토 보류함',
    badge: '보류 2건',
    title: '나중에 확인하기로 한 항목입니다',
    description: '보류해도 현재 revision과 필터 상태는 그대로 유지됩니다.',
    noticeTitle: '검토 보류 · 자동 만료 없음',
    noticeBody: '근거가 준비되면 언제든 같은 질문부터 다시 시작할 수 있습니다.',
    rows: [
      { label: 'BTC 매도', detail: '취득 출처', status: '보류', tone: 'warning' },
      { label: 'NFT 매도', detail: '취득 원가', status: '보류', tone: 'warning' },
    ],
    summaryValue: '2건',
    summary: [
      { label: '검토 필요', value: '3' },
      { label: '보류', value: '2' },
      { label: '현재 revision', value: 'rev.4' },
    ],
    nextDescription: '보류한 질문의 선택 상태를 복원해 검토를 재개합니다.',
    actionLabel: '검토 재개 →',
    nextState: 'B',
  },
  F: {
    stateLabel: 'F · revision 비교',
    badge: '비교',
    title: 'revision 변경 전후를 비교합니다',
    description: '사용자 판단으로 달라진 계산과 근거만 강조합니다.',
    noticeTitle: 'rev.4 → rev.5',
    noticeBody: 'BTC 매도 취득 출처가 Upbit 매수분으로 확정되었습니다.',
    rows: [
      { label: '예상 손익', detail: '+875,000원 → +1,055,000원', status: '+180,000', tone: 'positive' },
      { label: 'Coverage', detail: '11 / 12 → 12 / 12', status: '완료', tone: 'positive' },
      { label: 'Lot 상태', detail: '후보 → 확정', status: '변경', tone: 'accent' },
    ],
    summaryValue: '+180,000원',
    summary: [
      { label: '변경 필드', value: '3' },
      { label: '원본 변경', value: '0' },
      { label: '현재 revision', value: 'rev.5' },
    ],
    nextDescription: '생성된 revision 이력을 확인하고 검토 또는 결과 단계로 돌아갑니다.',
    actionLabel: '검토 계속 →',
    nextState: 'A',
  },
  G: {
    stateLabel: 'G · 발행·검증',
    badge: '발행 준비',
    title: '산출물을 발행하고 GIWA에서 검증합니다',
    description: 'PDF·CSV·JSON·Manifest·Evidence Pack의 거래 수와 합계를 맞춘 뒤 commitment를 기록합니다.',
    noticeTitle: '발행 snapshot · rev.7',
    noticeBody: '원본 범위, 정책 버전, 사용자 판단, 예외 목록을 하나의 Manifest로 고정합니다.',
    rows: [
      { label: 'PDF 요약', detail: '7개 거래 · 손익 +1,600,000원', status: '준비', tone: 'accent' },
      { label: 'CSV · JSON', detail: '행·합계 일치', status: '준비', tone: 'accent' },
      { label: 'Evidence Pack', detail: '원본·revision·checksum', status: '준비', tone: 'accent' },
    ],
    summaryValue: '5 산출물',
    summary: [
      { label: 'checksum', value: '계산 전' },
      { label: 'GIWA', value: '미기록' },
      { label: 'revision', value: 'rev.7' },
    ],
    nextDescription: '발행 후 commitment를 비교해 무결성을 검증합니다.',
    actionLabel: '발행 후 검증 →',
    nextState: 'OK',
  },
  G1: {
    stateLabel: 'G1 · GIWA 불일치',
    badge: '검증 실패',
    title: '산출물 합계와 GIWA commitment가 일치하지 않습니다',
    description: '실패한 산출물은 배포하지 않고 원인과 revision을 보존했습니다.',
    noticeTitle: 'CSV 합계 · 32,000원 차이',
    noticeBody: '토큰 스왑 가격 기준이 발행 snapshot과 다릅니다.',
    rows: [
      { label: 'Manifest', detail: 'rev.7 · policy v1.3', status: '일치', tone: 'positive' },
      { label: 'CSV 합계', detail: '+1,568,000원', status: '불일치', tone: 'negative' },
      { label: '기대 합계', detail: '+1,600,000원', status: '기준' },
    ],
    summaryValue: '1 불일치',
    summary: [
      { label: '영향 거래', value: '토큰 스왑' },
      { label: '차이', value: '−32,000원', tone: 'negative' },
      { label: '복귀 revision', value: 'rev.7' },
    ],
    nextDescription: '불일치 산출물은 발행하지 않고 정상 발행 준비 상태로 돌아갑니다.',
    actionLabel: '발행 준비로 돌아가기 →',
    nextState: 'G',
  },
  OK: {
    stateLabel: 'OK · GIWA 일치',
    badge: '검증 완료',
    title: 'GIWA commitment와 모든 산출물이 일치합니다',
    description: '재현 가능한 장부와 근거 묶음이 안전하게 고정되었습니다.',
    noticeTitle: 'commitment · 0x91ab…77e2',
    noticeBody: '7개 거래 · rev.7 · policy v1.3 · checksum 5/5 일치',
    rows: [
      { label: 'PDF 요약', detail: 'sha256: 31fa…80bc', status: '일치', tone: 'positive' },
      { label: 'CSV · JSON', detail: 'sha256: 97cd…20f1', status: '일치', tone: 'positive' },
      { label: 'Evidence Pack', detail: 'sha256: 52ae…91d4', status: '일치', tone: 'positive' },
    ],
    summaryValue: '5 / 5',
    summary: [
      { label: 'GIWA', value: '기록 완료', tone: 'positive' },
      { label: 'revision', value: 'rev.7' },
      { label: '검증 시각', value: '09:42' },
    ],
    nextDescription: '검증된 장부를 보고서와 다운로드 산출물에 사용할 수 있습니다.',
    actionLabel: '거래 목록으로 →',
    nextState: 'A',
  },
  J: {
    stateLabel: 'J · 확인 거래 여정',
    badge: '확인됨',
    title: '확인 거래가 만들어진 전체 여정입니다',
    description: '원본 이벤트부터 GIWA 결과까지 각 변환 단계와 근거를 추적합니다.',
    noticeTitle: 'ETH 매도 · 2027-03-12',
    noticeBody: '원본 → 정규화 → 자동 연결 → Lot 평가 → 사용자 확인 → rev.4',
    rows: [
      { label: '원본', detail: 'Upbit PDF p.2 · 8행', status: '보존', tone: 'positive' },
      { label: '정규화', detail: 'trade.sell · ETH', status: '완료', tone: 'positive' },
      { label: '원화 평가', detail: '+820,000원', status: '확정', tone: 'positive' },
      { label: 'GIWA', detail: 'commitment 대기', status: '연결', tone: 'accent' },
    ],
    summaryValue: '6 단계',
    summary: [
      { label: '근거 노드', value: '8' },
      { label: '사용자 판단', value: '1' },
      { label: '현재 revision', value: 'rev.4' },
    ],
    nextDescription: '여정 확인을 마치고 기존 필터와 페이지의 거래 목록으로 돌아갑니다.',
    actionLabel: '거래 목록으로 →',
    nextState: 'A',
  },
}
