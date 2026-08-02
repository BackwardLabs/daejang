import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertReportAttestationRuntimeInstalled,
  assertCleanGitCheckout,
  combinedJITConfigExpression,
  configureTaxUpbitQuoteRuntime,
  createRuntimeIndexerConfig,
  createRuntimeSubjectACL,
  createActionRuntimeIdentity,
  createTaxProfiles,
  collectRuntimeShareEntries,
  cronAutostartEntries,
  ensureRuntimeIndexerView,
  hostPostingWorkerArgs,
  hostPostingWorkerEnvironment,
  hostWebAPIRuntimePaths,
  hostEVMPostingWorkerArgs,
  hostEVMPostingWorkerEnvironment,
  hostActiveServiceOrder,
  isPrivateRuntimePath,
  hostWebAPIForwardedEnvironmentNames,
  hostWebAPIForwardedEnvironmentPrefixes,
  hostWebAPIEngineEnvironment,
  handoffSupervisorAfterSignal,
  loadTaxActionRegistryRuntime,
  loadVerifiedActionRuntimeRelease,
  launchdServiceDomains,
  normalizeMultichainSnapshotIds,
  pauseForSignalShutdown,
  privateObjectWriteEnvironment,
  finishSignalShutdown,
  finishSuperviseCommand,
  releaseProcessLock,
  resolvePostingRepository,
  resolveJITArtifactPaths,
  runRestartOperation,
  runSignalShutdown,
  resolveHostRuntimeGroup,
  resolveRuntimeGroupID,
  resolveRuntimeSubjectACLSource,
  resolveSupervisorScript,
  rewriteCrontabLines,
  sharedRuntimeFileMode,
  stableSupervisorPath,
  supervisorProcessSpec,
  taxBackfillArgs,
  tryAcquireProcessLock,
} from './host-backend.mjs'

test('keeps JIT artifacts outside immutable application releases by default', () => {
  assert.deepEqual(
    resolveJITArtifactPaths({ runtime: '/runtime' }),
    {
      root: '/runtime/artifacts/jit/root',
      temp: '/runtime/artifacts/jit/tmp',
    },
  )
  assert.deepEqual(
    resolveJITArtifactPaths({
      runtime: '/runtime',
      rootOverride: '/durable/jit/objects',
      tempOverride: '/durable/jit/tmp',
    }),
    {
      root: '/durable/jit/objects',
      temp: '/durable/jit/tmp',
    },
  )
})

test('writes JIT artifacts to the same durable paths consumed by posting', () => {
  const paths = resolveJITArtifactPaths({ runtime: '/runtime with spaces' })
  assert.equal(
    combinedJITConfigExpression({
      socket: '/private/tmp/giwa/jit.sock',
      artifactRoot: paths.root,
      artifactTemp: paths.temp,
    }),
    '. as $item ireduce ({}; . * $item) | ' +
      '.server.listen = "unix:///private/tmp/giwa/jit.sock" | ' +
      '.persistence.artifact.root = "/runtime with spaces/artifacts/jit/root" | ' +
      '.persistence.artifact.temp = "/runtime with spaces/artifacts/jit/tmp"',
  )
})

test('rejects an attestation-enabled restart before service shutdown when its runtime is missing', async () => {
  assert.doesNotThrow(() =>
    assertReportAttestationRuntimeInstalled({
      enabled: false,
      repository: '/release',
      fileExists: () => false,
    }),
  )
  assert.doesNotThrow(() =>
    assertReportAttestationRuntimeInstalled({
      enabled: true,
      repository: '/release',
      fileExists: (path) => path.endsWith('/giwaSepoliaV1.js'),
    }),
  )
  assert.throws(
    () =>
      assertReportAttestationRuntimeInstalled({
        enabled: true,
        repository: '/release',
        fileExists: () => false,
      }),
    /install the verified contracts tarball before restart/,
  )

  const events = []
  await assert.rejects(
    runRestartOperation({
      prepare: async () => {
        events.push('prepare')
        throw new Error('preflight failed')
      },
      pause: () => events.push('pause'),
      stop: async () => events.push('stop'),
      start: async () => events.push('start'),
    }),
    /preflight failed/,
  )
  assert.deepEqual(events, ['prepare'])
})

test('rejects mutable semantic runtime checkouts before a production build', () => {
  assert.doesNotThrow(() =>
    assertCleanGitCheckout('/runtime', 'runtime', () => ({
      status: 0,
      stdout: '',
    })),
  )
  assert.throws(
    () =>
      assertCleanGitCheckout('/runtime', 'runtime', () => ({
        status: 0,
        stdout: ' M scripts/transaction_adapter.py\n',
      })),
    /deploy a pinned clean checkout/,
  )
})

test('changes the action runtime identity when evaluation or evidence runtime bytes change', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-action-runtime-test-'))
  try {
    for (const [path, value] of [
      ['releases/action-registry-v1.json', '{}'],
      ['scripts/registry.py', 'registry'],
      ['scripts/transaction_adapter.py', 'adapter'],
      ['scripts/action_evaluator.py', 'evaluator'],
    ]) {
      mkdirSync(dirname(join(parent, path)), { recursive: true })
      writeFileSync(join(parent, path), value)
    }
    const jitExecutable = join(parent, 'jitd')
    const postingExecutable = join(parent, 'evm-posting-worker')
    writeFileSync(jitExecutable, 'jit-v1')
    writeFileSync(postingExecutable, 'posting-v1')
    const first = createActionRuntimeIdentity(parent, jitExecutable, postingExecutable)
    const second = createActionRuntimeIdentity(parent, jitExecutable, postingExecutable)
    writeFileSync(join(parent, 'scripts', 'transaction_adapter.py'), 'adapter-v2')
    const changed = createActionRuntimeIdentity(parent, jitExecutable, postingExecutable)
    writeFileSync(jitExecutable, 'jit-v2')
    const jitChanged = createActionRuntimeIdentity(parent, jitExecutable, postingExecutable)
    writeFileSync(postingExecutable, 'posting-v2')
    const postingChanged = createActionRuntimeIdentity(parent, jitExecutable, postingExecutable)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(first, second)
    assert.notEqual(first, changed)
    assert.notEqual(changed, jitChanged)
    assert.notEqual(jitChanged, postingChanged)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('derives the canonical Posting trust coordinate from one verified signed release', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-action-release-test-'))
  try {
    const releaseRoot = join(parent, 'releases')
    mkdirSync(join(parent, 'scripts'), { recursive: true })
    mkdirSync(releaseRoot, { recursive: true })
    const commit = '1'.repeat(40)
    const bundle = JSON.stringify({
      schemaVersion: 'defi-label.action-registry.v1',
      registrySourceRepository: 'BackwardLabs/DeFi-Label',
      registrySourceCommit: commit,
    })
    const bundleSha256 = createHash('sha256').update(bundle).digest('hex')
    writeFileSync(join(releaseRoot, 'action-registry-v1.json'), bundle)
    writeFileSync(join(releaseRoot, 'action-registry-v1.json.sha256'), `${bundleSha256}\n`)
    writeFileSync(join(releaseRoot, 'action-registry-v1.json.receipt.json'), JSON.stringify({
      bundleSha256,
      registrySourceRepository: 'BackwardLabs/DeFi-Label',
      registrySourceCommit: commit,
    }))

    const calls = []
    const runtime = loadVerifiedActionRuntimeRelease(parent, (command, args) => {
      calls.push([command, args])
      return command === 'git'
        ? { status: 0, stdout: '' }
        : { status: 0, stdout: '{"valid": true}\n' }
    })

    assert.deepEqual(runtime, {
      repository: 'BackwardLabs/DeFi-Label',
      commit,
      bundleSha256,
    })
    assert.equal(calls[0][1][1], 'verify-runtime-release')
    assert.deepEqual(calls[1], ['git', ['merge-base', '--is-ancestor', commit, 'HEAD']])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed when the Action runtime signed release is not valid', () => {
  assert.throws(
    () => loadVerifiedActionRuntimeRelease('/runtime', () => ({
      status: 0,
      stdout: '{"valid": false}\n',
    })),
    /signed release verification failed/,
  )
})

test('stages PDF assets where the flattened host Web API runtime resolves them', () => {
  const runtime = hostWebAPIRuntimePaths('/srv/giwa-runtime')

  assert.deepEqual(runtime, {
    code: '/srv/giwa-runtime/app/web-api',
    assets: '/srv/giwa-runtime/app/assets',
    nodeModules: '/srv/giwa-runtime/app/node_modules',
  })
  assert.equal(
    join(
      runtime.code,
      'tax-report',
      'pdf',
      '../../../assets/fonts/Pretendard-Regular.ttf',
    ),
    join(runtime.assets, 'fonts', 'Pretendard-Regular.ttf'),
  )
})

test('bounds archived Upbit quote staleness at ten minutes', () => {
  const configured = configureTaxUpbitQuoteRuntime({
    schemaVersion: 'daejang.upbit-quote-provider.v1',
    policyVersion: 'upbit-closed-minute-v1',
    maxCandleAgeSeconds: 300,
  })

  assert.equal(configured.maxCandleAgeSeconds, 600)
  assert.equal(configured.firstTradeAfterMaxSeconds, 604800)
  assert.equal(
    configured.policyVersion,
    'upbit-closed-minute-10m-or-inbound-first-trade-v4',
  )
})

test('derives the Tax Action Registry runtime from one verified release', () => {
  const bundle = JSON.stringify({
    schemaVersion: 'defi-label.action-registry.v1',
    registrySourceRepository: 'BackwardLabs/DeFi-Label',
    registrySourceCommit: '1'.repeat(40),
    exporterContractRepository: 'BackwardLabs/DeFi-Label',
    exporterContractCommit: '2'.repeat(40),
    profileCount: 3,
    profiles: [
      {
        id: 'weth9.wrap',
        profileVersion: '1.0.0',
        maturity: 'CANARY',
        compiledAction: { actionKind: 'WRAP' },
      },
      {
        id: 'aave-v3.supply',
        profileVersion: '1.0.0',
        maturity: 'DRAFT',
        compiledAction: null,
      },
      {
        id: 'weth9.unwrap',
        profileVersion: '1.0.0',
        maturity: 'CANARY',
        compiledAction: { actionKind: 'UNWRAP' },
      },
    ],
  })
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex')
  const files = new Map([
    ['action-registry-v1.json', bundle],
    ['action-registry-v1.json.receipt.json', JSON.stringify({
      bundleSha256,
      registrySourceRepository: 'BackwardLabs/DeFi-Label',
      registrySourceCommit: '1'.repeat(40),
      exporterContractRepository: 'BackwardLabs/DeFi-Label',
      exporterContractCommit: '2'.repeat(40),
    })],
    ['action-registry-v1.signature.json', JSON.stringify({
      bundleSha256,
      keyId: 'release-key',
      publicKeySha256: '3'.repeat(64),
    })],
  ])

  const runtime = loadTaxActionRegistryRuntime('/tax', (path) => {
    const contents = files.get(path.split('/').at(-1))
    if (contents === undefined) throw new Error(`unexpected release path ${path}`)
    return contents
  })

  assert.deepEqual(runtime, {
    registryPin: {
      bundleSchemaVersion: 'defi-label.action-registry.v1',
      registrySourceRepository: 'BackwardLabs/DeFi-Label',
      registrySourceCommit: '1'.repeat(40),
      exporterContractRepository: 'BackwardLabs/DeFi-Label',
      exporterContractCommit: '2'.repeat(40),
      bundleSha256,
      signatureKeyId: 'release-key',
      signaturePublicKeySha256: '3'.repeat(64),
    },
    actionProfiles: [
      { profileId: 'weth9.unwrap', profileVersion: '1.0.0' },
      { profileId: 'weth9.wrap', profileVersion: '1.0.0' },
    ],
  })
})

test('builds tax profiles only for subjects with canonical ledger assets', () => {
  const profiles = createTaxProfiles([
    {
      subject_id: 'subject-canonical',
      account_id: 'cex-account:upbit:1',
      asset_id: 'asset-zbt-upbit',
    },
    {
      subject_id: 'subject-canonical',
      account_id: 'cex-account:upbit:1',
      asset_id: 'asset-krw-upbit',
    },
    {
      subject_id: 'subject-document',
      account_id: 'cex-account:upbit:2',
      asset_id: 'cex-document-asset:upbit:decimal8:btc',
    },
    {
      subject_id: 'subject-mixed',
      account_id: 'cex-account:upbit:3',
      asset_id: 'cex-document-asset:upbit:decimal8:eth',
    },
    {
      subject_id: 'subject-mixed',
      account_id: 'wallet-account:optimism:1',
      asset_id: 'asset:eip155:10:native',
    },
  ])

  assert.equal(profiles.schemaVersion, 'tax.downstream-profile-set.v1')
  assert.equal(profiles.profiles.length, 6)
  assert.deepEqual(
    profiles.profiles.map(({ subjectId, taxYear }) => ({ subjectId, taxYear })),
    [
      { subjectId: 'subject-canonical', taxYear: 2025 },
      { subjectId: 'subject-canonical', taxYear: 2026 },
      { subjectId: 'subject-canonical', taxYear: 2027 },
      { subjectId: 'subject-mixed', taxYear: 2025 },
      { subjectId: 'subject-mixed', taxYear: 2026 },
      { subjectId: 'subject-mixed', taxYear: 2027 },
    ],
  )
  assert.deepEqual(
    profiles.profiles[0].assetBindings.map((binding) => binding.ledgerAssetId),
    ['asset-krw-upbit', 'asset-zbt-upbit'],
  )
  assert.equal(profiles.profiles[0].accountBindings[0].kind, 'VASP')
  assert.equal(profiles.profiles[0].accountBindings[0].method, 'MOVING_AVERAGE')
  assert.equal(profiles.profiles[3].subjectId, 'subject-mixed')
  assert.deepEqual(profiles.profiles[3].assetBindings, [{
    ledgerAssetId: 'asset:eip155:10:native',
    taxAssetId: 'tax-asset:eip155:10:native',
  }])
})

test('builds 2025 through 2027 profiles for every canonical subject', () => {
  const profiles = createTaxProfiles([
    { subject_id: 'subject-b', account_id: 'account-b', asset_id: 'asset-b' },
    { subject_id: 'subject-a', account_id: 'account-a', asset_id: 'asset-a' },
  ])

  assert.deepEqual(
    profiles.profiles.map(({ subjectId, taxYear }) => `${subjectId}:${taxYear}`),
    [
      'subject-a:2025',
      'subject-a:2026',
      'subject-a:2027',
      'subject-b:2025',
      'subject-b:2026',
      'subject-b:2027',
    ],
  )
})

test('keeps the core JIT and Posting pipeline active without tax profiles', () => {
  const profiles = createTaxProfiles([])
  assert.deepEqual(profiles, {
    schemaVersion: 'tax.downstream-profile-set.v1',
    profiles: [],
  })
  assert.deepEqual(
    hostActiveServiceOrder({ evmPosting: false, taxd: false }),
    ['pdf-parser', 'jit', 'engine', 'worker', 'posting', 'web-api'],
  )
  assert.deepEqual(
    hostActiveServiceOrder({ evmPosting: true, taxd: true }),
    [
      'pdf-parser', 'jit', 'engine', 'worker', 'posting',
      'evm-posting', 'taxd', 'web-api',
    ],
  )
})

test('passes an explicit 2025+ year to tax-backfill and defaults old calls to 2027', () => {
  assert.deepEqual(
    taxBackfillArgs('subject-1', 'event-1', '2025'),
    [
      '-subject', 'subject-1',
      '-event', 'event-1',
      '-tax-year', '2025',
      '-apply',
    ],
  )
  assert.deepEqual(
    taxBackfillArgs('subject-1', 'event-1'),
    [
      '-subject', 'subject-1',
      '-event', 'event-1',
      '-tax-year', '2027',
      '-apply',
    ],
  )
})

test('rejects unsupported or malformed tax-backfill years', () => {
  for (const taxYear of ['2024', '2025.0', 'not-a-year']) {
    assert.throws(
      () => taxBackfillArgs('subject-1', 'event-1', taxYear),
      /integer from 2025 through 9999/,
    )
  }
})

test('pins same-period multichain coverage to one deterministic snapshot', () => {
  const input = {
    chains: [
      {
        chainId: 'eip155:10',
        chainStore: 'optimism-mainnet',
        genesisHash: '0xoptimism',
        profileHash: 'profile-op',
        coverage: [{
          coverageStart: '2026-07-28',
          coverageEnd: '2026-07-28',
          indexSnapshotId: 'op-source-snapshot',
          fromBlock: 154799012,
          toBlock: 154842211,
        }],
      },
      {
        chainId: 'eip155:1',
        chainStore: 'ethereum-mainnet',
        genesisHash: '0xethereum',
        profileHash: 'profile-eth',
        coverage: [{
          coverageStart: '2026-07-28',
          coverageEnd: '2026-07-28',
          indexSnapshotId: 'eth-source-snapshot',
          fromBlock: 25627591,
          toBlock: 25634763,
        }],
      },
    ],
  }

  const normalized = normalizeMultichainSnapshotIds(structuredClone(input))
  const snapshotIds = normalized.chains.map(
    (chain) => chain.coverage[0].indexSnapshotId,
  )

  assert.match(snapshotIds[0], /^[0-9a-f]{64}$/)
  assert.equal(snapshotIds[0], snapshotIds[1])
  assert.equal(
    normalizeMultichainSnapshotIds(structuredClone(input)).chains[0]
      .coverage[0].indexSnapshotId,
    snapshotIds[0],
  )
})

test('preserves a single-chain snapshot identity', () => {
  const input = {
    chains: [{
      chainId: 'eip155:1',
      chainStore: 'ethereum-mainnet',
      coverage: [{
        coverageStart: '2026-07-28',
        coverageEnd: '2026-07-28',
        indexSnapshotId: 'eth-source-snapshot',
        fromBlock: 25627591,
        toBlock: 25634763,
      }],
    }],
  }

  assert.equal(
    normalizeMultichainSnapshotIds(structuredClone(input)).chains[0]
      .coverage[0].indexSnapshotId,
    'eth-source-snapshot',
  )
})

test('prefers the canonical Posting repository and supports the historical checkout name', () => {
  const root = '/srv/giwa'
  assert.equal(
    resolvePostingRepository(root, undefined, (path) =>
      path === join(root, 'daejang-posting-service')),
    join(root, 'daejang-posting-service'),
  )
  assert.equal(
    resolvePostingRepository(root, undefined, (path) =>
      path === join(root, 'evm-posting-service')),
    join(root, 'evm-posting-service'),
  )
  assert.equal(
    resolvePostingRepository(root, '/opt/giwa/posting', () => false),
    '/opt/giwa/posting',
  )
})

test('limits the runtime indexer config to the JIT chain stores', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-test-'))
  const localSource = join(parent, 'local-indexer.json')
  const bulkSource = join(parent, 'bulk-indexer.json')
  const output = join(parent, 'indexer.runtime.json')
  try {
    writeFileSync(localSource, JSON.stringify({
      dataDir: '${EVM_INDEXER_DATA_DIR}',
      chains: [
        {
          name: 'ethereum-mainnet', sourceKind: 'verified-local', startBlock: 0,
          liveSource: 'geth-hook', livePath: '/geth',
        },
      ],
    }))
    writeFileSync(bulkSource, JSON.stringify({
      chains: [{
        name: 'optimism-mainnet-bulk-bedrock', sourceKind: 'sqd-portal',
        startBlock: 105235063, supplementalRpcUrl: '${SECRET_PROXY_URL}/rpc',
      }],
    }))
    createRuntimeIndexerConfig(localSource, bulkSource, output, join(parent, 'view'))
    const runtime = JSON.parse(readFileSync(output, 'utf8'))
    assert.deepEqual(
      runtime.chains.map((chain) => chain.name),
      ['ethereum-mainnet-tail', 'optimism-mainnet-bulk-bedrock-tail'],
    )
    assert.equal(runtime.dataDir, join(parent, 'view'))
    assert.equal(runtime.chains[0].sourceKind, 'remote-finalized-single-source')
    assert.equal(runtime.chains[0].startBlock, 25559129)
    assert.equal(runtime.chains[0].liveSource, undefined)
    assert.equal(runtime.chains[1].startBlock, 154465211)
    assert.equal(runtime.chains[1].supplementalRpcUrl, 'http://127.0.0.1:1')
    // Readable by the service account and at most its operator group, never
    // group writable and never exposed to other accounts.
    assert.equal(statSync(output).mode & 0o022, 0)
    assert.equal(statSync(output).mode & 0o007, 0)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed when a required JIT indexer chain is missing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-test-'))
  const localSource = join(parent, 'local-indexer.json')
  const bulkSource = join(parent, 'bulk-indexer.json')
  const output = join(parent, 'indexer.runtime.json')
  try {
    writeFileSync(localSource, JSON.stringify({
      chains: [{ name: 'ethereum-mainnet' }],
    }))
    writeFileSync(bulkSource, JSON.stringify({ chains: [] }))
    assert.throws(
      () => createRuntimeIndexerConfig(localSource, bulkSource, output, join(parent, 'view')),
      /missing a required JIT chain/,
    )
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('creates a fail-closed read-only indexer view from exact stores', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-view-test-'))
  const root = join(parent, 'view')
  const ethereum = join(parent, 'ethereum')
  const optimism = join(parent, 'optimism')
  try {
    mkdirSync(ethereum)
    mkdirSync(optimism)
    ensureRuntimeIndexerView(root, {
      'ethereum-mainnet-tail': ethereum,
      'optimism-mainnet-bulk-bedrock-tail': optimism,
    })
    assert.equal(readlinkSync(join(root, 'ethereum-mainnet-tail')), ethereum)
    assert.equal(readlinkSync(join(root, 'optimism-mainnet-bulk-bedrock-tail')), optimism)
    assert.throws(
      () => ensureRuntimeIndexerView(root, { 'ethereum-mainnet-tail': optimism }),
      /changed unexpectedly/,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('rewrites only the local JIT ACL identity to the current service UID', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-test-'))
  const source = join(parent, 'subject-acl.json')
  const output = join(parent, 'subject-acl.runtime.json')
  try {
    writeFileSync(source, JSON.stringify({
      version: 1,
      grants: [
        { identity: 'uid:505', subjects: ['audit-public'] },
        { identity: 'spiffe://daejang/remote', subjects: ['subject-1'] },
      ],
    }))
    createRuntimeSubjectACL(source, output, 502)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      version: 1,
      grants: [
        { identity: 'uid:502', subjects: [], allowAnySubject: true },
        { identity: 'spiffe://daejang/remote', subjects: ['subject-1'] },
      ],
    })
    // Readable by the service account and at most its operator group, never
    // group writable and never exposed to other accounts.
    assert.equal(statSync(output).mode & 0o022, 0)
    assert.equal(statSync(output).mode & 0o007, 0)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed when the JIT ACL local identity is ambiguous', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-test-'))
  const source = join(parent, 'subject-acl.json')
  const output = join(parent, 'subject-acl.runtime.json')
  try {
    writeFileSync(source, JSON.stringify({
      version: 1,
      grants: [
        { identity: 'uid:501', subjects: ['subject-1'] },
        { identity: 'uid:502', subjects: ['subject-2'] },
      ],
    }))
    assert.throws(
      () => createRuntimeSubjectACL(source, output, 502),
      /exactly one local UID grant/,
    )
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('prefers the operator-owned JIT ACL override when it exists', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-source-test-'))
  const defaultSource = join(parent, 'default-subject-acl.json')
  const overrideSource = join(parent, 'subject-acl.source.json')
  const output = join(parent, 'subject-acl.runtime.json')
  try {
    writeFileSync(defaultSource, JSON.stringify({
      version: 1,
      grants: [{ identity: 'uid:505', subjects: ['audit-public'] }],
    }))
    writeFileSync(overrideSource, JSON.stringify({
      version: 1,
      grants: [{ identity: 'uid:505', subjects: ['audit-public', 'subject-1'] }],
    }))

    const source = resolveRuntimeSubjectACLSource(defaultSource, overrideSource)
    createRuntimeSubjectACL(source, output, 502)

    assert.equal(source, overrideSource)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      version: 1,
      grants: [{ identity: 'uid:502', subjects: [], allowAnySubject: true }],
    })
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('falls back to the repository JIT ACL when no override exists', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-source-test-'))
  try {
    const defaultSource = join(parent, 'default-subject-acl.json')
    const overrideSource = join(parent, 'subject-acl.source.json')
    writeFileSync(defaultSource, '{}')

    assert.equal(
      resolveRuntimeSubjectACLSource(defaultSource, overrideSource),
      defaultSource,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('rejects relative JIT ACL source paths', () => {
  assert.throws(
    () => resolveRuntimeSubjectACLSource('subject-acl.json', '/tmp/override.json'),
    /paths must be absolute/,
  )
})

test('omits the private object key ID when PDF encryption is disabled', () => {
  assert.deepEqual(privateObjectWriteEnvironment({}), {})
})

test('passes the private object key and its ID as one unit', () => {
  assert.deepEqual(privateObjectWriteEnvironment({
    PRIVATE_OBJECT_ENCRYPTION_KEY: 'base64-key',
  }), {
    PRIVATE_OBJECT_ENCRYPTION_KEY: 'base64-key',
    PRIVATE_OBJECT_ENCRYPTION_KEY_ID: 'primary',
  })
})

test('pins both host Web API Engine targets to the runtime Unix socket', () => {
  assert.deepEqual(
    hostWebAPIEngineEnvironment('/private/tmp/giwa/engine.sock'),
    {
      ENGINE_GRPC_INSECURE_TARGET: 'unix:/private/tmp/giwa/engine.sock',
      GIWA_HOST_ENGINE_TARGET: 'unix:/private/tmp/giwa/engine.sock',
    },
  )
})

test('requires a signed SOURCE claim policy for the host Posting worker', () => {
  assert.deepEqual(
    hostPostingWorkerArgs('/runtime/artifacts', '/srv/posting', '/runtime/policy.json'),
    [
      '--artifact-root', '/runtime/artifacts/source/root',
      '--artifact-temp', '/runtime/artifacts/source/tmp',
      '--service-root', '/srv/posting',
      '--claim-policy', '/runtime/policy.json',
    ],
  )
  assert.deepEqual(
    hostPostingWorkerEnvironment('public-key', 'event-url', 'source-url'),
    {
      DAEJANG_PUBLICATION_POLICY_TRUST_KEY: 'public-key',
      DAEJANG_POSTING_DATABASE_URL: 'event-url',
      DAEJANG_POSTING_ARTIFACT_DATABASE_URL: 'source-url',
    },
  )
  assert.throws(
    () => hostPostingWorkerEnvironment('', 'event-url', 'source-url'),
    /TRUST_KEY is missing/,
  )
})

test('requires a distinct signed JIT claim policy for the canonical EVM worker', () => {
  assert.deepEqual(
    hostEVMPostingWorkerArgs(
      '/runtime/jit-artifacts',
      '/runtime/jit-temp',
      '/runtime/evm-policy.json',
      {
        repository: 'BackwardLabs/DeFi-Label',
        commit: 'b6b9ce8cfdb411f10e44fa74378c6eababd3eee4',
        bundleSha256: 'a'.repeat(64),
      },
    ),
    [
      '--mode', 'canonical',
      '--artifact-root', '/runtime/jit-artifacts',
      '--artifact-temp', '/runtime/jit-temp',
      '--claim-policy', '/runtime/evm-policy.json',
      '--trusted-action-runtime-repository', 'BackwardLabs/DeFi-Label',
      '--trusted-action-runtime-commit', 'b6b9ce8cfdb411f10e44fa74378c6eababd3eee4',
      '--trusted-action-runtime-bundle-sha256', 'a'.repeat(64),
    ],
  )
  assert.throws(
    () => hostEVMPostingWorkerArgs(
      '/runtime/jit-artifacts',
      '/runtime/jit-temp',
      '/runtime/evm-policy.json',
      {
        repository: 'BackwardLabs/DeFi-Label',
        commit: 'not-a-commit',
        bundleSha256: 'a'.repeat(64),
      },
    ),
    /verified DeFi Action runtime release coordinate is required/,
  )
  assert.deepEqual(
    hostEVMPostingWorkerEnvironment('public-key', 'event-url'),
    {
      DAEJANG_PUBLICATION_POLICY_TRUST_KEY: 'public-key',
      DAEJANG_POSTING_DATABASE_URL: 'event-url',
    },
  )
  assert.throws(
    () => hostEVMPostingWorkerEnvironment('', 'event-url'),
    /TRUST_KEY is missing/,
  )
})

test('forwards GIWA report deployment settings only to the Web API boundary', () => {
  assert.deepEqual(hostWebAPIForwardedEnvironmentNames, [
    'ENV_RPC_URL_ETHEREUM_MAINNET',
    'ENV_RPC_URL_OPTIMISM_MAINNET',
    'GIWA_REPORT_ATTESTATIONS_ENABLED',
    'GIWA_REPORT_RPC_URL',
    'GIWA_REPORT_EAS_ADDRESS',
    'GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS',
    'GIWA_REPORT_REGISTRY_PROXY_ADDRESS',
  'GIWA_REPORT_CONSUMER_ADDRESS',
  'GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS',
    'GIWA_REPORT_SCHEMA_UID',
    'GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST',
    'GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED',
    'GIWA_REPORT_IDENTITY_HMAC_KEY',
    'GIWA_REPORT_ISSUER_ADDRESS',
    'GIWA_REPORT_ISSUER_KEYSTORE_PATH',
    'GIWA_REPORT_ISSUER_PASSWORD_FILE',
    'GIWA_REPORT_REVIEWER_ADDRESS',
    'GIWA_REPORT_REVIEWER_KEYSTORE_PATH',
    'GIWA_REPORT_REVIEWER_PASSWORD_FILE',
    'GIWA_REPORT_MIN_CONFIRMATIONS',
    'GIWA_REPORT_DAILY_USER_WRITE_LIMIT',
    'GIWA_REPORT_DAILY_IP_WRITE_LIMIT',
    'GIWA_REPORT_DAILY_GLOBAL_WRITE_LIMIT',
  ])
  assert.equal(hostWebAPIForwardedEnvironmentPrefixes.includes('GIWA_REPORT_'), false)
})

test('creates the runtime root before taking the first operation lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-test-'))
  const runtimeRoot = join(parent, 'fresh-runtime')
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./host-backend.mjs', import.meta.url)), 'stop'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIWA_HOST_RUNTIME_ROOT: runtimeRoot,
        },
      },
    )
    assert.equal(existsSync(join(runtimeRoot, 'supervisor')), true, result.stderr)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed on a malformed process lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-lock-test-'))
  const lock = join(parent, 'operation.lock')
  try {
    writeFileSync(lock, '')
    assert.throws(
      () => tryAcquireProcessLock(lock, () => ({
        status: 0,
        stdout: 'test command',
      })),
      /Malformed backend lock requires manual removal/,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('only the lock owner can release a process lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-owner-test-'))
  const lock = join(parent, 'operation.lock')
  try {
    const lockContent = tryAcquireProcessLock(lock, () => ({
      status: 0,
      stdout: 'test command',
    }))
    assert.throws(
      () => releaseProcessLock(lock, 'different owner'),
      /lock ownership changed unexpectedly/,
    )
    releaseProcessLock(lock, lockContent)
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('restart establishes pause before stopping or starting services', async () => {
  const events = []
  await runRestartOperation({
    prepare: () => events.push('prepare'),
    pause: () => events.push('pause'),
    stop: async () => events.push('stop'),
    start: async () => events.push('start'),
  })
  assert.deepEqual(events, ['prepare', 'pause', 'stop', 'start'])
})

test('signal shutdown waits for the active operation before serialized stop', async () => {
  const events = []
  let finishOperation
  const activeOperation = new Promise((resolve) => {
    finishOperation = resolve
  })
  const shutdown = runSignalShutdown({
    pause: () => events.push('pause'),
    activeOperation,
    stop: async () => events.push('stop'),
  })
  await Promise.resolve()
  assert.deepEqual(events, ['pause'])
  finishOperation()
  await shutdown
  assert.deepEqual(events, ['pause', 'stop'])
})

test('supervisor signal shutdown preserves healthy resident services', async () => {
  const events = []
  await runSignalShutdown({
    preserveServices: true,
    pause: () => events.push('pause'),
    activeOperation: undefined,
    stop: async () => events.push('stop'),
  })
  assert.deepEqual(events, ['pause'])
})

test('supervisor signal shutdown returns through its lock-release finally', () => {
  const exitCodes = []
  finishSignalShutdown({
    supervising: true,
    exitCode: 143,
    exit: (code) => exitCodes.push(code),
  })
  assert.deepEqual(exitCodes, [])
  assert.equal(process.exitCode, 143)
  process.exitCode = undefined
})

test('supervisor command exits after its lock-release finally completes', () => {
  const exitCodes = []
  finishSuperviseCommand({
    shutdown: true,
    exitCode: 143,
    exit: (code) => exitCodes.push(code),
  })
  assert.deepEqual(exitCodes, [143])
})

test('supervisor signal performs a detached monitor handoff', () => {
  const events = []
  handoffSupervisorAfterSignal({
    shutdown: true,
    start: () => events.push('start'),
  })
  handoffSupervisorAfterSignal({
    shutdown: false,
    start: () => events.push('unexpected-start'),
  })
  assert.deepEqual(events, ['start'])
})

test('cron fallback installs a PATH-aware reboot entry and watchdog', () => {
  const entries = cronAutostartEntries({
    repository: '/srv/giwa app',
    node: '/opt/homebrew/bin/node',
    script: '/srv/runtime/host-backend.mjs',
    log: '/srv/runtime/supervisor.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    marker: '# GIWA_HOST_BACKEND',
  })
  assert.equal(entries.length, 2)
  assert.match(entries[0], /^@reboot /)
  assert.match(entries[0], /PATH='\/opt\/homebrew\/bin:\/usr\/bin:\/bin'/)
  assert.match(entries[1], /^\* \* \* \* \* cd /)
  assert.match(entries[1], /host-backend\.mjs' watchdog >>/)
  assert.doesNotMatch(entries[1], /pgrep/)
  assert.ok(entries.every((entry) => entry.endsWith('# GIWA_HOST_BACKEND')))
})

test('cron fallback omits the runtime group when the tree stays private', () => {
  const entries = cronAutostartEntries({
    repository: '/srv/giwa app',
    node: '/opt/homebrew/bin/node',
    script: '/srv/runtime/host-backend.mjs',
    log: '/srv/runtime/supervisor.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    marker: '# GIWA_HOST_BACKEND',
    group: -1,
  })
  assert.ok(entries.every((entry) => !entry.includes('GIWA_HOST_RUNTIME_GROUP')))
})

test('cron fallback carries the shared runtime group into the reboot entry', () => {
  const entries = cronAutostartEntries({
    repository: '/srv/giwa app',
    node: '/opt/homebrew/bin/node',
    script: '/srv/runtime/host-backend.mjs',
    log: '/srv/runtime/supervisor.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    marker: '# GIWA_HOST_BACKEND',
    group: 501,
  })
  assert.ok(entries.every((entry) => entry.includes("GIWA_HOST_RUNTIME_GROUP='501'")))
})

test('resolves a numeric host runtime group without a directory lookup', () => {
  assert.equal(
    resolveRuntimeGroupID('501', () => {
      throw new Error('lookup must not run for a numeric group')
    }),
    501,
  )
})

test('resolves a named host runtime group through the directory service', () => {
  const looked = []
  const gid = resolveRuntimeGroupID(' daejang ', (name) => {
    looked.push(name)
    return { status: 0, stdout: 'PrimaryGroupID: 501\n' }
  })
  assert.equal(gid, 501)
  assert.deepEqual(looked, ['daejang'])
})

test('treats an unset host runtime group as private', () => {
  for (const value of [undefined, '', '   ']) {
    assert.equal(resolveRuntimeGroupID(value), -1)
  }
})

test('shares the runtime with the default group when nothing is configured', () => {
  assert.equal(
    resolveHostRuntimeGroup({
      configured: undefined,
      fallback: 'daejang',
      resolveGroup: (group) => (group === 'daejang' ? 501 : -1),
    }),
    501,
  )
})

test('keeps the runtime private when the default group is absent', () => {
  assert.equal(
    resolveHostRuntimeGroup({
      configured: undefined,
      resolveGroup: () => {
        throw new Error('Unable to resolve host runtime group: daejang')
      },
    }),
    -1,
  )
})

test('lets an explicit empty host runtime group opt out of sharing', () => {
  assert.equal(
    resolveHostRuntimeGroup({
      configured: '',
      resolveGroup: resolveRuntimeGroupID,
    }),
    -1,
  )
})

test('fails loudly when an explicitly configured group cannot be resolved', () => {
  assert.throws(
    () =>
      resolveHostRuntimeGroup({
        configured: 'typo-group',
        resolveGroup: () => {
          throw new Error('Unable to resolve host runtime group: typo-group')
        },
      }),
    /Unable to resolve host runtime group: typo-group/,
  )
})

test('rejects an unresolvable or malformed host runtime group', () => {
  assert.throws(
    () => resolveRuntimeGroupID('missing', () => ({ status: 1, stdout: '' })),
    /Unable to resolve host runtime group: missing/,
  )
  assert.throws(
    () => resolveRuntimeGroupID('bad group; rm -rf /'),
    /Invalid host runtime group name/,
  )
})

test('shares owner read and execute bits with the group but never write', () => {
  assert.equal(sharedRuntimeFileMode(0o600), 0o640)
  assert.equal(sharedRuntimeFileMode(0o700), 0o750)
  // Executable bits survive, but existing other access is dropped.
  assert.equal(sharedRuntimeFileMode(0o755), 0o750)
  // An owner-writable file must not become group writable.
  assert.equal(sharedRuntimeFileMode(0o600) & 0o020, 0)
  assert.equal(sharedRuntimeFileMode(0o700) & 0o022, 0)
  // Existing other-readable bits are dropped rather than widened.
  assert.equal(sharedRuntimeFileMode(0o644) & 0o007, 0)
})

test('keeps fail-closed taxd paths private inside a shared runtime', () => {
  const privatePaths = ['/rt/config/trust.pub', '/rt/supervisor/tax-claim-receipts']
  assert.ok(isPrivateRuntimePath('/rt/config/trust.pub', privatePaths))
  assert.ok(isPrivateRuntimePath('/rt/supervisor/tax-claim-receipts', privatePaths))
  assert.ok(
    isPrivateRuntimePath('/rt/supervisor/tax-claim-receipts/2027.jsonl', privatePaths),
  )
  assert.ok(!isPrivateRuntimePath('/rt/config/trust.pub.bak', privatePaths))
  assert.ok(!isPrivateRuntimePath('/rt/supervisor/logs/taxd.log', privatePaths))
})

test('excludes fail-closed paths from the shared runtime entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'giwa-share-private-'))
  try {
    mkdirSync(join(root, 'receipts'))
    writeFileSync(join(root, 'receipts', '2027.jsonl'), '{}\n', { mode: 0o600 })
    writeFileSync(join(root, 'shared.log'), 'log\n', { mode: 0o600 })

    const shared = collectRuntimeShareEntries(root, {
      isPrivate: (path) => path === join(root, 'receipts'),
    })

    assert.deepEqual(shared.map((entry) => entry.path), [join(root, 'shared.log')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collects runtime entries to share without following symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'giwa-share-'))
  try {
    mkdirSync(join(root, 'logs'))
    writeFileSync(join(root, 'logs', 'engine.log'), 'log\n', { mode: 0o600 })
    writeFileSync(join(root, 'jitd'), '', { mode: 0o755 })
    symlinkSync('/etc', join(root, 'escape'), 'dir')

    const shared = collectRuntimeShareEntries(root)
    const byPath = new Map(shared.map(({ path, mode }) => [path, mode]))

    assert.equal(byPath.get(join(root, 'logs')), 0o2750)
    assert.equal(byPath.get(join(root, 'logs', 'engine.log')), 0o640)
    assert.equal(byPath.get(join(root, 'jitd')), 0o750)
    assert.ok(!byPath.has(join(root, 'escape')))
    assert.ok(![...byPath.keys()].some((path) => path.startsWith('/etc')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('autostart runs the supervisor from the checkout that owns its dependencies', () => {
  const repository = '/srv/giwa app'
  assert.equal(
    resolveSupervisorScript(repository, () => true),
    join(repository, 'scripts', 'host-backend.mjs'),
  )
})

test('autostart refuses a checkout whose supervisor dependencies are missing', () => {
  const repository = '/srv/giwa app'
  assert.throws(
    () =>
      resolveSupervisorScript(
        repository,
        (path) => path === join(repository, 'scripts', 'host-backend.mjs'),
      ),
    /Supervisor dependencies are missing; run npm install in \/srv\/giwa app/,
  )
  assert.throws(
    () => resolveSupervisorScript(repository, () => false),
    /Supervisor script is missing/,
  )
})

test('switching to launchd drops the marked entries and keeps the rest', () => {
  const existing = [
    '0 3 * * * /usr/bin/backup',
    "@reboot cd '/srv' && node '/old/host-backend.mjs' supervise # GIWA_HOST_BACKEND",
    "* * * * * cd '/srv' && node '/old/host-backend.mjs' watchdog # GIWA_HOST_BACKEND",
  ].join('\n')

  assert.deepEqual(rewriteCrontabLines(existing, []), ['0 3 * * * /usr/bin/backup'])
  assert.deepEqual(rewriteCrontabLines(existing, ['@reboot new # GIWA_HOST_BACKEND']), [
    '0 3 * * * /usr/bin/backup',
    '@reboot new # GIWA_HOST_BACKEND',
  ])
  assert.deepEqual(rewriteCrontabLines('', []), [])
})

test('autostart tries the background user launchd domain after GUI', () => {
  assert.deepEqual(launchdServiceDomains(502), ['gui/502', 'user/502'])
})

test('autostart uses a bounded host PATH without session tool directories', () => {
  const path = stableSupervisorPath({
    node: '/opt/homebrew/Cellar/node/26.5.0/bin/node',
    home: '/Users/operator',
  })
  assert.equal(
    path,
    '/opt/homebrew/Cellar/node/26.5.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/operator/.orbstack/bin',
  )
  assert.doesNotMatch(path, /codex|node_modules/)
})

test('detached supervisor uses the stable runtime script and repository', () => {
  const spec = supervisorProcessSpec({
    repository: '/srv/giwa app',
    node: '/opt/homebrew/bin/node',
    script: '/srv/runtime/host-backend.mjs',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
  })
  assert.equal(spec.command, '/opt/homebrew/bin/node')
  assert.deepEqual(spec.args, ['/srv/runtime/host-backend.mjs', 'supervise'])
  assert.equal(spec.options.cwd, '/srv/giwa app')
  assert.equal(spec.options.detached, true)
  assert.equal(spec.options.env.PATH, '/opt/homebrew/bin:/usr/bin:/bin')
  assert.equal(spec.options.env.GIWA_APP_REPOSITORY, '/srv/giwa app')
})

test('only explicit service commands persist pause during signal shutdown', () => {
  const events = []
  pauseForSignalShutdown({
    supervising: true,
    pause: () => events.push('supervisor-pause'),
  })
  pauseForSignalShutdown({
    supervising: false,
    pause: () => events.push('command-pause'),
  })
  assert.deepEqual(events, ['command-pause'])
})
