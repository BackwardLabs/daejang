export type DashboardAllocation = {
  amount: string
  color: string
  percent: number
  symbol: string
}

export type DashboardSource = {
  assets: Array<{
    amount: string
    color: string
    name: string
  }>
  change: string
  changeTone: 'negative' | 'positive'
  detail: string
  name: string
  share: string
  value: string
}

export type DashboardHolding = {
  change: string
  changeTone: 'negative' | 'positive'
  name: string
  price: string
  quantity: string
  source: string
  symbol: string
  value: string
}

export type DashboardSnapshot = {
  allocations: DashboardAllocation[]
  bars: number[]
  dailyChange: string
  holdings: DashboardHolding[]
  lastSynced: string
  sources: DashboardSource[]
  totalAssets: string
  year: '2026' | '2027'
}

export const dashboardCurrentYear = '2027' as const
export const dashboardSyncStorageKey = 'daejang.mock.dashboard-sync.v2'

const sources2027: DashboardSource[] = [
  {
    name: 'Upbit',
    detail: '거래소 · PDF 연결',
    share: '전체 39%',
    value: '₩25,800,000',
    change: '+₩1,120,000',
    changeTone: 'positive',
    assets: [
      { name: 'BTC', amount: '0.214 BTC', color: '#f7931a' },
      { name: 'ETH', amount: '1.72 ETH', color: '#627eea' },
      { name: 'XRP', amount: '1,200 XRP', color: '#23292f' },
    ],
  },
  {
    name: 'Ethereum 지갑',
    detail: '0x8f…3a2b',
    share: '전체 34%',
    value: '₩22,600,000',
    change: '+₩680,000',
    changeTone: 'positive',
    assets: [
      { name: 'ETH', amount: '2.86 ETH', color: '#627eea' },
      { name: 'EIGEN', amount: '350 EIGEN', color: '#6b5cff' },
      { name: 'USDC', amount: '3,120 USDC', color: '#2775ca' },
    ],
  },
  {
    name: 'Base 지갑',
    detail: '0x8f…3a2b',
    share: '전체 17%',
    value: '₩11,300,000',
    change: '−₩310,000',
    changeTone: 'negative',
    assets: [
      { name: 'WETH', amount: '1.12 WETH', color: '#627eea' },
      { name: 'USDC', amount: '2,850 USDC', color: '#2775ca' },
      { name: 'cbBTC', amount: '0.018 cbBTC', color: '#f7931a' },
    ],
  },
  {
    name: 'Bithumb',
    detail: '거래소 · CSV 연결',
    share: '전체 10%',
    value: '₩6,650,000',
    change: '+₩240,000',
    changeTone: 'positive',
    assets: [
      { name: 'SOL', amount: '18.2 SOL', color: '#14f195' },
      { name: 'XRP', amount: '2,300 XRP', color: '#23292f' },
      { name: 'USDT', amount: '1,150 USDT', color: '#26a17b' },
    ],
  },
]

const holdings2027: DashboardHolding[] = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    quantity: '4.58 ETH',
    price: '₩4,350,000',
    value: '₩19,923,000',
    change: '+₩680,000',
    changeTone: 'positive',
    source: 'Upbit · 지갑',
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    quantity: '0.232 BTC',
    price: '₩91,200,000',
    value: '₩21,158,000',
    change: '+₩1,360,000',
    changeTone: 'positive',
    source: 'Upbit',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    quantity: '5,970 USDC',
    price: '₩1,440',
    value: '₩8,597,000',
    change: '−₩24,000',
    changeTone: 'negative',
    source: '지갑 2개',
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    quantity: '18.2 SOL',
    price: '₩225,000',
    value: '₩4,095,000',
    change: '+₩240,000',
    changeTone: 'positive',
    source: 'Bithumb',
  },
  {
    symbol: 'EIGEN',
    name: 'EigenLayer',
    quantity: '350 EIGEN',
    price: '₩8,500',
    value: '₩2,975,000',
    change: '+₩128,000',
    changeTone: 'positive',
    source: 'Ethereum 지갑',
  },
]

export const dashboardSnapshots: Record<'2026' | '2027', DashboardSnapshot> = {
  '2027': {
    year: '2027',
    totalAssets: '₩66,350,000',
    dailyChange: '⌃ +4.6% · ₩2,910,000',
    lastSynced: '2027-08-04 10:20',
    bars: [24, 29, 27, 38, 35, 46, 58],
    allocations: [
      { symbol: 'BTC', percent: 32, amount: '₩21,158,000', color: '#f7931a' },
      { symbol: 'ETH', percent: 30, amount: '₩19,923,000', color: '#627eea' },
      { symbol: 'USDC', percent: 13, amount: '₩8,597,000', color: '#2775ca' },
      { symbol: 'SOL', percent: 6, amount: '₩4,095,000', color: '#14f195' },
      { symbol: '기타 5종', percent: 19, amount: '₩12,577,000', color: '#9ca3af' },
    ],
    sources: sources2027,
    holdings: holdings2027,
  },
  '2026': {
    year: '2026',
    totalAssets: '₩52,780,000',
    dailyChange: '⌃ +1.9% · ₩982,000',
    lastSynced: '2026-12-31 18:20',
    bars: [18, 20, 19, 24, 27, 29, 32],
    allocations: [
      { symbol: 'BTC', percent: 34, amount: '₩17,945,000', color: '#f7931a' },
      { symbol: 'ETH', percent: 31, amount: '₩16,362,000', color: '#627eea' },
      { symbol: 'USDC', percent: 15, amount: '₩7,917,000', color: '#2775ca' },
      { symbol: 'SOL', percent: 7, amount: '₩3,695,000', color: '#14f195' },
      { symbol: '기타 4종', percent: 13, amount: '₩6,861,000', color: '#9ca3af' },
    ],
    sources: sources2027.map((source, index) => {
      const shares = ['전체 42%', '전체 31%', '전체 17%', '전체 10%'] as const
      const values = [
        '₩22,168,000',
        '₩16,362,000',
        '₩8,973,000',
        '₩5,277,000',
      ] as const
      return {
        ...source,
        share: shares[index] ?? source.share,
        value: values[index] ?? source.value,
      }
    }),
    holdings: holdings2027.map((holding, index) => {
      const values = [
        '₩16,362,000',
        '₩17,945,000',
        '₩7,917,000',
        '₩3,695,000',
        '₩2,861,000',
      ] as const
      return {
        ...holding,
        value: values[index] ?? holding.value,
      }
    }),
  },
}

export const dashboardSyncResult: DashboardSnapshot = {
  ...dashboardSnapshots['2027'],
  totalAssets: '₩66,670,000',
  dailyChange: '⌃ +5.1% · ₩3,230,000',
  lastSynced: dashboardSnapshots['2027'].lastSynced,
  bars: [24, 29, 27, 38, 35, 46, 62],
}

function cloneDashboardSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return {
    ...snapshot,
    allocations: snapshot.allocations.map((allocation) => ({ ...allocation })),
    bars: [...snapshot.bars],
    holdings: snapshot.holdings.map((holding) => ({ ...holding })),
    sources: snapshot.sources.map((source) => ({
      ...source,
      assets: source.assets.map((asset) => ({ ...asset })),
    })),
  }
}

export function formatDashboardSyncTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

export function readDashboardSnapshot(
  year: DashboardSnapshot['year'],
): DashboardSnapshot {
  const fallback = cloneDashboardSnapshot(dashboardSnapshots[year])

  if (typeof window === 'undefined' || year !== dashboardCurrentYear) {
    return fallback
  }

  try {
    const stored = window.localStorage.getItem(dashboardSyncStorageKey)
    const parsed = stored
      ? (JSON.parse(stored) as {
          schemaVersion?: string
          snapshot?: DashboardSnapshot
        })
      : null

    if (
      parsed?.schemaVersion === 'dashboard-sync.v2' &&
      parsed.snapshot?.year === year &&
      typeof parsed.snapshot.lastSynced === 'string'
    ) {
      return cloneDashboardSnapshot(parsed.snapshot)
    }
  } catch {
    window.localStorage.removeItem(dashboardSyncStorageKey)
  }

  return fallback
}

export function createDashboardSyncSnapshot(date = new Date()) {
  const snapshot: DashboardSnapshot = {
    ...cloneDashboardSnapshot(dashboardSyncResult),
    lastSynced: formatDashboardSyncTimestamp(date),
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        dashboardSyncStorageKey,
        JSON.stringify({
          schemaVersion: 'dashboard-sync.v2',
          snapshot,
        }),
      )
    } catch {
      // The updated in-memory snapshot still works if browser storage is unavailable.
    }
  }

  return snapshot
}
