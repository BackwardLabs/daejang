// dev-e2e lane의 taxd downstream profile을 운영과 같은 방식으로 재생성한다.
//
// 운영에서는 host supervisor(host-backend.mjs)가 장부 DB에서
// currentTaxProfileRowsQuery로 rows를 읽어 createTaxProfiles로 모든 웹
// subject의 연도별 프로필을 자동 생성한다. dev-e2e는 taxd fixture가 만든 정적
// 파일을 마운트하므로, 실지갑 lane이 새 계좌·자산을 장부에 올린 뒤에는 이
// 스크립트로 같은 생성기를 돌려 갈아끼운다. 수집이 끝난 뒤 한 번 실행한다:
//
//   make dev-e2e-refresh-tax
//
// taxd는 프로필·정책 파일을 기동 시에만 읽으므로 마지막에 tax-engine을
// 재시작한다. 기존 fixture 프로필의 바인딩(CEX 계좌의 VASP/이동평균,
// residentId)은 그대로 보존한다 — fixture CEX 계좌 id는 운영 명명 규칙
// (`cex-account:` 접두사)을 따르지 않아 생성기 기본값(OTHER/FIFO)이 기존
// 2025 CEX 리포트의 계산 방법을 바꿔버리기 때문이다.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  canonicalJSON,
  configureTaxUpbitQuoteRuntime,
  createTaxProfiles,
  currentTaxProfileRowsQuery,
  isCanonicalWebSubjectID,
} from './host-backend.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = process.env.DAEJANG_DEV_E2E_STATE_DIR ??
  join(repoRoot, '.runtime', 'dev-e2e')

const parseEnvFile = (path) => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)

const state = parseEnvFile(join(stateDirectory, 'state.env'))
const composeEnv = parseEnvFile(state.APP_ENV_FILE ?? join(stateDirectory, 'compose.env'))
const projectName = state.APP_PROJECT_NAME
if (!projectName) throw new Error('dev-e2e state.env has no APP_PROJECT_NAME')
const stateVolume = `${projectName}_pipeline_state`
const ledgerURL = (composeEnv.QUERY_DATABASE_URL ?? composeEnv.EVENT_DATABASE_URL ?? '')
  .replace('host.docker.internal', '127.0.0.1')
if (!ledgerURL) throw new Error('dev-e2e compose.env has no ledger database URL')

const docker = (args, input) => {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}
const readStateFile = (name) => JSON.parse(docker([
  'run', '--rm', '-v', `${stateVolume}:/e2e:ro`, 'alpine', 'cat', `/e2e/${name}`,
]))
const writeStateFile = (name, value) => {
  // taxd는 이 파일들을 RFC 8785 canonical JSON으로 검증한다.
  docker([
    'run', '--rm', '-i', '-v', `${stateVolume}:/e2e`, 'alpine', 'sh', '-ec',
    `cp /e2e/${name} /e2e/${name}.bak 2>/dev/null || true; cat > /e2e/${name}.new && mv /e2e/${name}.new /e2e/${name} && chmod 644 /e2e/${name}`,
  ], canonicalJSON(value))
}

const client = new pg.Client({ connectionString: ledgerURL })
await client.connect()
let rows
const walletAccountChains = new Map()
const walletBySubject = new Map()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const result = await client.query(currentTaxProfileRowsQuery)
  rows = result.rows.filter(({ subject_id: subjectID }) =>
    isCanonicalWebSubjectID(subjectID))
  const chains = await client.query(`
    SELECT DISTINCT subject_id, account_id,
      split_part(asset_id, ':', 2) || ':' || split_part(asset_id, ':', 3) AS chain
    FROM ledger.asset_posting
    WHERE account_id LIKE 'wallet-account-%' AND asset_id LIKE 'asset:eip155:%'`)
  for (const { subject_id: subjectID, account_id: accountID, chain } of chains.rows) {
    walletAccountChains.set(`${subjectID} ${accountID}`, chain)
  }
  const wallets = await client.query(`
    SELECT user_id, address FROM source_private.wallet_sources WHERE status = 'ACTIVE'`)
  for (const { user_id: subjectID, address } of wallets.rows) {
    walletBySubject.set(subjectID, address)
  }
  await client.query('COMMIT')
} finally {
  await client.end()
}
if (rows.length === 0) throw new Error('ledger has no tax profile rows yet')

const fixtureProfiles = readStateFile('downstream-profiles.json')

// 운영과 같은 live Upbit provider config를 tax repo에서 가져와 materialize
// 한다(운영 supervisor가 candidate 디렉터리에 쓰는 것과 동일). 지갑 체인
// 자산은 업비트 마켓과 자산 id 체계가 달라 config에 등가 매핑을 명시적으로
// 얹는다 — 양 체인 native ETH와 핀된 WETH(1:1 wrap)를 KRW-ETH로 평가한다.
const taxEngineDirectory = process.env.DAEJANG_TAX_ENGINE_DIR ??
  join(repoRoot, '..', 'daejang-tax-engine')
const upbitConfig = configureTaxUpbitQuoteRuntime(JSON.parse(readFileSync(
  join(taxEngineDirectory, 'config', 'upbit-quote-provider.v1.json'),
  'utf8',
)))
const nativeAtomicUnits = '1000000000000000000'
const walletQuoteAssets = [
  { assetId: 'asset:eip155:1:native', baseAtomicUnits: nativeAtomicUnits, market: 'KRW-ETH' },
  { assetId: 'asset:eip155:10:native', baseAtomicUnits: nativeAtomicUnits, market: 'KRW-ETH' },
  { assetId: 'asset:eip155:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', baseAtomicUnits: nativeAtomicUnits, market: 'KRW-ETH' },
  { assetId: 'asset:eip155:10:0x4200000000000000000000000000000000000006', baseAtomicUnits: nativeAtomicUnits, market: 'KRW-ETH' },
]
const ledgerAssetIDs = new Set(rows.map(({ asset_id: assetID }) => assetID))
upbitConfig.assets = [
  ...upbitConfig.assets,
  ...walletQuoteAssets.filter(({ assetId }) => ledgerAssetIDs.has(assetId)),
].sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0)
const quoteAssetIDs = new Set(upbitConfig.assets.map(({ assetId }) => assetId))
// 생성기의 configured-vs-observed 소수 자릿수 검증에는 CEX 자산만 노출한다.
// 지갑 자산의 자릿수는 장부 관측값이 이미 정확하고, 업비트 config의
// baseAtomicUnits는 시세 스케일 용도라 관측값과 단위 체계가 다르다.
const profileSet = createTaxProfiles(rows, {
  denomination: upbitConfig.denomination,
  assets: [],
})

const fixtureBySubject = new Map(
  (fixtureProfiles.profiles ?? []).map((profile) => [profile.subjectId, profile]),
)
for (const profile of profileSet.profiles) {
  const fixture = fixtureBySubject.get(profile.subjectId)
  if (fixture !== undefined) {
    profile.residentId = fixture.residentId
    const accountOverrides = new Map(
      fixture.accountBindings.map((binding) => [binding.accountId, binding]),
    )
    profile.accountBindings = profile.accountBindings.map((binding) =>
      accountOverrides.get(binding.accountId) ?? binding)
    const assetOverrides = new Map(
      fixture.assetBindings.map((binding) => [binding.ledgerAssetId, binding]),
    )
    profile.assetBindings = profile.assetBindings.map((binding) =>
      assetOverrides.get(binding.ledgerAssetId) ?? binding)
  }
  if (profile.valuationDirectOnlyAssetIds !== undefined) {
    profile.valuationDirectOnlyAssetIds = profile.valuationDirectOnlyAssetIds
      .filter((assetId) => !quoteAssetIDs.has(assetId))
    if (profile.valuationDirectOnlyAssetIds.length === 0) {
      delete profile.valuationDirectOnlyAssetIds
    }
  }
}

// [dev 가정] 2027 의제취득가액 opening inventory — GIWA-96의 dev 시뮬레이션.
// 시행 전 보유분 취득가액 = max(실제 취득가액, 2026-12-31 시가)인데 그 시가는
// 연말 마감 후에만 실존하므로, dev에서는 "현재 온체인 잔고 = 연말 보유,
// 현재 업비트 KRW-ETH = 연말 시가"로 가정해 2027 프로필에만 생성한다
// (엔진이 2025·2026 시뮬레이션에는 의제 사용을 거부한다). 실제 취득가액은
// 미상(0)으로 두므로 max는 항상 가정 시가를 선택한다. 네트워크 실패 시
// 경고만 남기고 건너뛴다.
if (process.env.DAEJANG_DEV_E2E_DEEMED_2027_OPENING !== '0') {
  try {
    const priceOverride = process.env.DAEJANG_DEV_E2E_DEEMED_ETH_PRICE_KRW
    const ethPriceKRW = priceOverride !== undefined
      ? BigInt(priceOverride)
      : BigInt(Math.round((await (await fetch(
          'https://api.upbit.com/v1/ticker?markets=KRW-ETH')).json())[0].trade_price))
    const rpcHosts = {
      'eip155:1': 'https://ethereum-rpc.publicnode.com',
      'eip155:10': 'https://optimism-rpc.publicnode.com',
    }
    const nativeBalance = async (chain, address) => {
      const response = await fetch(rpcHosts[chain], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
      })
      return BigInt((await response.json()).result)
    }
    let openingCount = 0
    for (const profile of profileSet.profiles) {
      if (profile.taxYear !== 2027) continue
      const walletAddress = walletBySubject.get(profile.subjectId)
      if (walletAddress === undefined) continue
      // 프로필에 자산 바인딩이 없는 opening은 Collapse 검증이 거부한다 —
      // 바인딩은 해당 연도까지 장부에 등장한 자산에만 생성되므로 그 범위로
      // 제한한다 (전 자산 바인딩은 GIWA-96 실배선의 설계 논점).
      const boundTaxAssets = new Set(profile.assetBindings.map(({ taxAssetId }) => taxAssetId))
      const openings = []
      for (const binding of profile.accountBindings) {
        const chain = walletAccountChains.get(`${profile.subjectId} ${binding.accountId}`)
        if (chain === undefined || rpcHosts[chain] === undefined) continue
        if (!boundTaxAssets.has(`asset:${chain}:native`)) continue
        const quantity = await nativeBalance(chain, walletAddress)
        if (quantity <= 0n) continue
        const marketValue = (quantity * ethPriceKRW * 100000000n / 10n ** 18n).toString()
        openings.push({
          taxAddressId: binding.taxAddressId,
          taxAssetId: `asset:${chain}:native`,
          quantity: quantity.toString(),
          basisStatus: 'KNOWN',
          basisAmount: marketValue,
          basisRule: 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET',
          actualAcquisitionAmount: '0',
          marketValueAt2026End: marketValue,
        })
      }
      if (openings.length > 0) {
        profile.openingBalances = openings
        openingCount += openings.length
      }
    }
    console.log(`deemed 2027 openings: ${openingCount} (assumed KRW-ETH ${ethPriceKRW})`)
  } catch (error) {
    console.warn(`deemed 2027 opening skipped: ${error.message}`)
  }
}

// 프로필이 요구하는 모든 과세연도에 정책 항목이 있어야 taxd가 기동한다.
// fixture는 기준 연도 하나만 심으므로 빠진 연도는 기준 항목을 복제한다.
const policySet = readStateFile('tax-policy.json')
const policyYears = new Set(policySet.policies.map(({ taxYear }) => taxYear))
const baseYear = Math.min(...policyYears)
const basePolicy = policySet.policies.find(({ taxYear }) => taxYear === baseYear)
const kstOffsetMs = 9 * 60 * 60 * 1000
for (const { taxYear } of profileSet.profiles) {
  if (policyYears.has(taxYear)) continue
  policyYears.add(taxYear)
  const from = new Date(Date.UTC(taxYear, 0, 1) - kstOffsetMs)
  const through = new Date(Date.UTC(taxYear + 1, 0, 1) - kstOffsetMs - 1)
  policySet.policies.push({
    ...structuredClone(basePolicy),
    taxYear,
    version: `fixture-${taxYear}`,
    effectiveFrom: from.toISOString().replace('.000Z', 'Z'),
    effectiveThrough: through.toISOString().replace('.999Z', '.999999999Z'),
  })
}
policySet.policies.sort((left, right) => left.taxYear - right.taxYear)

writeStateFile('downstream-profiles.json', profileSet)
writeStateFile('tax-policy.json', policySet)
writeStateFile('upbit-quote-config.json', upbitConfig)

// taxd를 운영과 같은 live Upbit provider 모드로 전환한다. taxd는 스냅샷과
// provider config 중 정확히 하나만 허용하므로 스냅샷 변수는 빈 값으로 심는다.
const envOverrides = {
  DAEJANG_DEV_E2E_TAXD_QUOTE_SNAPSHOT_FILE: '',
  DAEJANG_DEV_E2E_TAXD_UPBIT_QUOTE_CONFIG_FILE: '/e2e/upbit-quote-config.json',
  DAEJANG_DEV_E2E_TAXD_QUOTE_ARCHIVE_ROOT: '/var/lib/daejang/quote-archive/upbit',
}
const envPath = state.APP_ENV_FILE ?? join(stateDirectory, 'compose.env')
const envLines = readFileSync(envPath, 'utf8').split('\n')
  .filter((line) => line !== '' && !Object.keys(envOverrides).some((key) => line.startsWith(key + '=')))
for (const [key, value] of Object.entries(envOverrides)) envLines.push(`${key}=${value}`)
const { writeFileSync } = await import('node:fs')
writeFileSync(envPath, envLines.join('\n') + '\n')
console.log(`profiles: ${profileSet.profiles.length} (subjects ${new Set(profileSet.profiles.map((p) => p.subjectId)).size}, years ${[...new Set(profileSet.profiles.map((p) => p.taxYear))].join('/')})`)
console.log(`policy years: ${[...policyYears].sort().join('/')}`)

const composeArgs = [
  'compose', '--env-file', state.APP_ENV_FILE, '--project-directory', repoRoot,
  '--file', join(repoRoot, 'deploy', 'compose.dev-e2e.yaml'), '--project-name', projectName,
]
const composeBinary = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0
  ? ['docker', ...composeArgs]
  : ['/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose', ...composeArgs.slice(1)]
const restart = spawnSync(composeBinary[0], [...composeBinary.slice(1), 'up', '--detach', '--force-recreate', '--wait', 'tax-engine'], {
  encoding: 'utf8', stdio: 'inherit',
})
if (restart.status !== 0) throw new Error('tax-engine restart failed')
console.log('tax-engine restarted with refreshed profiles')
