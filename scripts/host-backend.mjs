import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  linkSync,
  openSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Client } = pg

const scriptRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(
  process.env.GIWA_APP_REPOSITORY ?? scriptRepositoryRoot,
)
const repositoryParent = resolve(repositoryRoot, '..')
const projectRoot =
  basename(repositoryParent) === '.worktrees'
    ? resolve(repositoryParent, '..')
    : repositoryParent
const canonicalRepositoryRoot = resolve(
  process.env.GIWA_CANONICAL_APP_REPOSITORY ?? join(projectRoot, 'daejang'),
)
const databaseRepository = resolve(
  process.env.GIWA_DATABASE_REPOSITORY ?? join(projectRoot, 'daejang-db'),
)
export const resolvePostingRepository = (
  root,
  override,
  fileExists = existsSync,
) => {
  if (override) return resolve(override)
  const canonical = join(root, 'daejang-posting-service')
  const legacy = join(root, 'evm-posting-service')
  return fileExists(canonical) ? canonical : fileExists(legacy) ? legacy : canonical
}
const postingRepository = resolvePostingRepository(
  projectRoot,
  process.env.GIWA_POSTING_REPOSITORY,
)
const taxRepository = resolve(
  process.env.GIWA_TAX_REPOSITORY ?? join(projectRoot, 'daejang-tax-engine'),
)
const deFiLabelRepository = resolve(
  process.env.GIWA_DEFI_LABEL_REPOSITORY ?? join(projectRoot, 'DeFi-Label'),
)
const jitRepository = resolve(
  process.env.GIWA_JIT_REPOSITORY ?? join(projectRoot, 'daejang-jit-engine'),
)
const schemaRepository = resolve(
  process.env.GIWA_SCHEMA_REPOSITORY ?? join(projectRoot, 'schema'),
)
const jitRuntime = resolve(
  process.env.GIWA_JIT_RUNTIME ?? join(projectRoot, 'daejang-jit-runtime'),
)
const runtimeRoot = resolve(
  process.env.GIWA_HOST_RUNTIME_ROOT ??
    join(homedir(), 'Library', 'Application Support', 'GIWA', 'production'),
)
const stateRoot = join(runtimeRoot, 'supervisor')
const logRoot = join(stateRoot, 'logs')
const pidRoot = join(stateRoot, 'pids')
const socketRoot = resolve(
  process.env.GIWA_HOST_SOCKET_ROOT ??
    join(
      '/private/tmp',
      `giwa-host-backend-${process.getuid?.() ?? 'service'}`,
      'sockets',
    ),
)
const configRoot = join(stateRoot, 'config')
const taxCandidateRoot = join(configRoot, 'tax-candidates')
const upbitCandleCollectorQuoteConfigFile = join(
  configRoot,
  'upbit-candle-sync-quotes.v1.json',
)
const taxBinaryReleaseManifestFile = join(
  stateRoot,
  'tax-binary-release.json',
)
const sourcePublicationClaimPolicy = join(
  configRoot,
  'source-publication-claim-policy.json',
)
const evmPublicationClaimPolicy = join(
  configRoot,
  'evm-publication-claim-policy.json',
)
// Kept only so the first run after upgrading can clean up the legacy marker.
// taxd.profile-state.json is the sole runtime source of truth from then on.
const taxdLegacyNoProfilesMarker = join(stateRoot, 'taxd.disabled-no-profiles')
const taxdProfileStateFile = join(stateRoot, 'taxd.profile-state.json')
const upbitCandleCollectorStateFile = join(
  runtimeRoot,
  'quote-archive',
  'upbit',
  'bulk-v1',
  'state.json',
)
export const resolveJITArtifactPaths = ({
  runtime,
  rootOverride,
  tempOverride,
}) => ({
  root: resolve(
    rootOverride ?? join(runtime, 'artifacts', 'jit', 'root'),
  ),
  temp: resolve(
    tempOverride ?? join(runtime, 'artifacts', 'jit', 'tmp'),
  ),
})
const {
  root: jitArtifactRoot,
  temp: jitArtifactTemp,
} = resolveJITArtifactPaths({
  runtime: runtimeRoot,
  rootOverride: process.env.GIWA_JIT_ARTIFACT_ROOT,
  tempOverride: process.env.GIWA_JIT_ARTIFACT_TEMP,
})
const binaryRoot = join(runtimeRoot, 'bin')
const artifactRoot = join(runtimeRoot, 'artifacts')
export const hostWebAPIRuntimePaths = (root) => ({
  code: join(root, 'app', 'web-api'),
  assets: join(root, 'app', 'assets'),
  nodeModules: join(root, 'app', 'node_modules'),
})
const managedJITBinary = join(binaryRoot, 'jitd')
const jitBinary = resolve(
  process.env.GIWA_JIT_BINARY ?? managedJITBinary,
)
const pauseFile = join(stateRoot, 'paused')
const supervisorLockFile = join(stateRoot, 'supervisor.lock')
const operationLockFile = join(stateRoot, 'operation.lock')

// The runtime tree is owned by the service account and shared with the
// operator group so other accounts on the same host can read logs, PIDs and
// the generated runtime config. Group write is never granted: jitd refuses to
// listen when its socket parent is writable by group or others.
// GIWA_HOST_RUNTIME_GROUP overrides the group; setting it empty keeps the
// tree private to the service account.
const defaultRuntimeGroup = 'daejang'

export const resolveRuntimeGroupID = (
  value,
  lookup = (name) =>
    spawnSync('dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], {
      encoding: 'utf8',
    }),
) => {
  const group = (value ?? '').trim()
  if (!group) return -1
  if (/^[0-9]+$/.test(group)) {
    const id = Number.parseInt(group, 10)
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(`Invalid host runtime group id: ${value}`)
    }
    return id
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(group)) {
    throw new Error(`Invalid host runtime group name: ${value}`)
  }
  const result = lookup(group)
  const match =
    result.status === 0 && typeof result.stdout === 'string'
      ? result.stdout.match(/PrimaryGroupID:\s*([0-9]+)/)
      : null
  if (!match) throw new Error(`Unable to resolve host runtime group: ${group}`)
  return Number.parseInt(match[1], 10)
}

// An explicit setting is strict so a typo fails loudly, while the built-in
// default degrades to a private tree on hosts that have no such group.
export const resolveHostRuntimeGroup = ({
  configured,
  fallback = defaultRuntimeGroup,
  resolveGroup = resolveRuntimeGroupID,
} = {}) => {
  if (configured !== undefined) return resolveGroup(configured)
  try {
    return resolveGroup(fallback)
  } catch {
    return -1
  }
}

const runtimeGroupID = resolveHostRuntimeGroup({
  configured: process.env.GIWA_HOST_RUNTIME_GROUP,
})
const runtimeShared = runtimeGroupID >= 0
// setgid keeps the group on entries created later by the services themselves.
const directoryMode = runtimeShared ? 0o2750 : 0o700
const fileMode = runtimeShared ? 0o640 : 0o600

export const upbitCandleCollectorArgs = ({
  archiveRoot,
  quoteConfig,
} = {}) => [
  '--archive-root', archiveRoot,
  '--quote-config', quoteConfig,
  '--start-month', '2017-09',
  '--priority-year', '2025',
  '--request-interval', '750ms',
  '--rate-limit-retries', '3',
  '--http-timeout', '10s',
  '--max-archive-bytes', '68719476736',
  '--min-free-bytes', '34359738368',
  '--max-tasks-per-run', '32',
  '--poll-interval', '24h',
]

const writeRuntimeFileAtomically = (path, contents, mode = fileMode) => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, contents, { mode, flag: 'wx' })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

// Mirrors the owner read and execute bits into the group without ever adding
// group write, so prebuilt binaries stay executable for the shared group.
export const sharedRuntimeFileMode = (mode) =>
  (mode & 0o7700) | ((mode & 0o500) >> 3)

// Downstream services fail closed on any group or other access to these, so
// they stay private even when the rest of the tree is shared: taxd rejects a
// group-readable trust key and a group-accessible claim receipt directory
// (daejang-tax-engine/internal/daemon/{config,claim_control}.go).
const privateRuntimePaths = [
  join(configRoot, 'tax-publication-policy-trust-key.pub'),
  taxCandidateRoot,
  join(stateRoot, 'tax-claim-receipts'),
]

export const isPrivateRuntimePath = (path, privatePaths = privateRuntimePaths) =>
  privatePaths.some((privatePath) => pathIsWithin(privatePath, path))

const applyRuntimeGroup = (path) => {
  if (runtimeShared && !isPrivateRuntimePath(path)) {
    chownSync(path, -1, runtimeGroupID)
  }
}

// Creation modes are masked by umask, and the services inherit it from this
// process, so pin it instead of depending on the launchd or login default.
// 0o027 keeps group read and execute while denying group write and all other
// access, which is what jitd requires of its socket parent.
if (runtimeShared) process.umask(0o027)

const pathIsWithin = (parent, candidate) =>
  candidate === parent || candidate.startsWith(`${parent}/`)

const assertExternalRuntimeRoot = () => {
  for (const checkout of [
    repositoryRoot,
    databaseRepository,
    postingRepository,
    taxRepository,
    deFiLabelRepository,
    jitRepository,
    schemaRepository,
    jitRuntime,
  ]) {
    if (pathIsWithin(checkout, runtimeRoot)) {
      throw new Error(
        `GIWA_HOST_RUNTIME_ROOT must be outside Git checkouts: ${runtimeRoot}`,
      )
    }
  }
}

const ensureRuntimeDirectories = () => {
  for (const directory of [
    runtimeRoot,
    stateRoot,
    artifactRoot,
    logRoot,
    pidRoot,
    socketRoot,
    configRoot,
    taxCandidateRoot,
    binaryRoot,
    join(artifactRoot, 'source', 'root'),
    join(artifactRoot, 'source', 'tmp'),
    join(artifactRoot, 'review', 'root'),
    join(artifactRoot, 'review', 'tmp'),
    join(artifactRoot, 'tax', 'root'),
    join(artifactRoot, 'tax', 'tmp'),
    jitArtifactRoot,
    jitArtifactTemp,
    join(runtimeRoot, 'quote-archive', 'upbit'),
    join(stateRoot, 'tax-claim-control'),
    join(stateRoot, 'tax-claim-control-state'),
    join(stateRoot, 'tax-claim-receipts'),
    join(runtimeRoot, 'private-objects'),
    join(stateRoot, 'selections'),
  ]) {
    mkdirSync(directory, { recursive: true, mode: directoryMode })
    const linkMetadata = lstatSync(directory)
    if (linkMetadata.isSymbolicLink()) {
      throw new Error(`Runtime directory must not be a symbolic link: ${directory}`)
    }
    const metadata = statSync(directory)
    if (!metadata.isDirectory() || metadata.uid !== process.getuid()) {
      throw new Error(`Runtime directory is not owned by this service account: ${directory}`)
    }
    // chown clears setgid on macOS, so take the group before the mode.
    applyRuntimeGroup(directory)
    chmodSync(directory, isPrivateRuntimePath(directory) ? 0o700 : directoryMode)
  }
}

// Entries created before GIWA_HOST_RUNTIME_GROUP was configured keep their
// private modes, so share them in one pass instead of walking the whole tree
// on every start.
export const collectRuntimeShareEntries = (
  root,
  {
    readEntries = readdirSync,
    describe = lstatSync,
    sharedDirectoryMode = 0o2750,
    isPrivate = isPrivateRuntimePath,
  } = {},
) => {
  const shared = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readEntries(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = describe(path)
      if (metadata.isSymbolicLink() || isPrivate(path)) continue
      if (metadata.isDirectory()) {
        shared.push({ path, mode: sharedDirectoryMode })
        pending.push(path)
      } else if (metadata.isFile()) {
        shared.push({ path, mode: sharedRuntimeFileMode(metadata.mode & 0o7777) })
      }
    }
  }
  return shared
}

const shareRuntime = () => {
  if (!runtimeShared) {
    throw new Error(
      `No host runtime group is active; set GIWA_HOST_RUNTIME_GROUP or create the ${defaultRuntimeGroup} group`,
    )
  }
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  let count = 0
  for (const root of [runtimeRoot, socketRoot]) {
    for (const { path, mode } of collectRuntimeShareEntries(root)) {
      if (statSync(path).uid !== process.getuid()) {
        throw new Error(`Runtime entry is not owned by this service account: ${path}`)
      }
      applyRuntimeGroup(path)
      chmodSync(path, mode)
      count += 1
    }
  }
  // Skipping is not enough once a path has already been widened, so put the
  // fail-closed paths back to owner-only.
  for (const path of privateRuntimePaths) {
    if (!existsSync(path)) continue
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) continue
    if (!metadata.isDirectory()) {
      chmodSync(path, 0o600)
      continue
    }
    chmodSync(path, 0o700)
    for (const nested of collectRuntimeShareEntries(path, {
      sharedDirectoryMode: 0o700,
      isPrivate: () => false,
    })) {
      chmodSync(nested.path, nested.mode & 0o700)
    }
  }
  console.log(`Shared ${count} runtime entries with group ${runtimeGroupID}`)
}

const databaseEnvFile = resolve(
  process.env.GIWA_DATABASE_ENV_FILE ?? join(databaseRepository, '.env'),
)
const canonicalProductionEnvFile = join(
  projectRoot,
  'daejang',
  'deploy',
  'production.env',
)
const productionEnvFile = resolve(
  process.env.GIWA_PRODUCTION_ENV_FILE ??
    (existsSync(canonicalProductionEnvFile)
      ? canonicalProductionEnvFile
      : join(repositoryRoot, 'deploy', 'production.env')),
)
const jitEnvrc = resolve(
  process.env.GIWA_JIT_ENVRC ?? join(jitRepository, '.envrc'),
)
const indexerEnvFile = resolve(
  process.env.GIWA_EVM_INDEXER_ENV_FILE ??
    '/Users/Shared/Projects/00_Backlight/evm-indexer/configs/local-nodes.env',
)

const loadRuntimeEnvironment = () => {
  for (const file of [
    databaseEnvFile,
    productionEnvFile,
    jitEnvrc,
    indexerEnvFile,
  ]) {
    if (!existsSync(file))
      throw new Error(`Required environment file is missing: ${file}`)
  }
  loadEnvFile(databaseEnvFile)
  loadEnvFile(productionEnvFile)
  loadEnvFile(indexerEnvFile)

  for (const line of readFileSync(jitEnvrc, 'utf8').split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)='([^']*)'$/)
    if (match && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2]
  }
}

const allServiceOrder = [
  'pdf-parser',
  'jit',
  'engine',
  'worker',
  'posting',
  'evm-posting',
  'taxd',
  'web-api',
]
const evmPostingEnabled = () => existsSync(evmPublicationClaimPolicy)
const taxdEnabled = () => {
  const state = readTaxdProfileState()
  if (state !== null) return state.status === 'ACTIVE'
  return !existsSync(taxdLegacyNoProfilesMarker)
}
export const hostActiveServiceOrder = ({
  evmPosting = true,
  taxd = true,
} = {}) => allServiceOrder.filter((name) =>
  (name !== 'evm-posting' || evmPosting) &&
  (name !== 'taxd' || taxd))
const pidFile = (name) => join(pidRoot, `${name}.pid`)
const logFile = (name) => join(logRoot, `${name}.log`)

const readProcessState = (name) => {
  try {
    const state = JSON.parse(readFileSync(pidFile(name), 'utf8'))
    if (
      Number.isSafeInteger(state.pid) &&
      state.pid > 1 &&
      typeof state.commandLine === 'string' &&
      state.commandLine.length > 0
    ) return state
    return undefined
  } catch {
    return undefined
  }
}

const isRunning = (name) => {
  const state = readProcessState(name)
  if (!state) return false
  try {
    process.kill(state.pid, 0)
    const result = spawnSync('ps', ['-ww', '-p', String(state.pid), '-o', 'command='], {
      encoding: 'utf8',
    })
    if (result.status !== 0) return false
    const observed = result.stdout.trim()
    if (observed === state.commandLine) return true
    const firstArgument = state.commandLine.indexOf(' ')
    return firstArgument > 0 && observed.endsWith(state.commandLine.slice(firstArgument))
  } catch {
    return false
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0)
    throw new Error(`${command} failed with status ${result.status}`)
}

const runBestEffort = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status === 0) return true
  const reason = result.error?.message ??
    (result.signal ? `signal ${result.signal}` : `status ${result.status}`)
  console.warn(`${command} failed with ${reason}; continuing with resident service`)
  return false
}

const spawnService = (name, command, args, environment, options = {}) => {
  if (isRunning(name)) throw new Error(`${name} is already running`)
  if (command.includes('/') && !existsSync(command)) {
    throw new Error(`${name} executable is missing: ${command}`)
  }
  rmSync(pidFile(name), { force: true })
  const descriptor = openSync(logFile(name), 'a', fileMode)
  const child = spawn(command, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', descriptor, descriptor],
    ...options,
  })
  child.unref()
  closeSync(descriptor)
  writeFileSync(
    pidFile(name),
    `${JSON.stringify({ pid: child.pid, commandLine: [command, ...args].join(' ') })}\n`,
    { mode: fileMode },
  )
}

const upbitCandleCollectorRuntime = () => {
  const binary = join(binaryRoot, 'upbit-candle-sync')
  const quoteConfig = upbitCandleCollectorQuoteConfigFile
  if (!existsSync(binary) || !existsSync(quoteConfig)) {
    throw new Error(
      'Upbit candle collector binary or quote config is missing; run backend:upbit-collector-start or backend:start to build the runtime',
    )
  }
  return {
    binary,
    args: upbitCandleCollectorArgs({
      archiveRoot: join(runtimeRoot, 'quote-archive', 'upbit'),
      quoteConfig,
    }),
  }
}

const ensureUpbitCandleCollectorRunning = () => {
  if (isRunning('upbit-candle-sync')) return false
  // This also verifies the collector digest and every semantic checkout
  // coordinate before a prebuilt collector is brought back after a crash.
  loadTaxBinaryReleaseManifest()
  const runtime = upbitCandleCollectorRuntime()
  spawnService(
    'upbit-candle-sync',
    runtime.binary,
    runtime.args,
    baseEnvironment(),
    { cwd: taxRepository },
  )
  return true
}

export const assertUpbitCollectorStarted = (running) => {
  if (running !== true) {
    throw new Error(
      'Upbit candle collector exited during startup; inspect backend:logs before retrying',
    )
  }
}

const restartUpbitCandleCollector = async () => {
  if (isRunning('upbit-candle-sync')) {
    await stopService('upbit-candle-sync')
  }
  ensureUpbitCandleCollectorRunning()
  await sleep(1_000)
  assertUpbitCollectorStarted(isRunning('upbit-candle-sync'))
}

export const assertUpbitCollectorReleaseReplaceable = (
  runningCoreServices,
) => {
  if (!Array.isArray(runningCoreServices)) {
    throw new Error('Running backend service list is invalid')
  }
  if (runningCoreServices.length > 0) {
    throw new Error(
      `Upbit collector-only release cannot replace Tax binaries while core services are running: ${runningCoreServices.join(', ')}`,
    )
  }
}

export const runUpbitCollectorStartOperation = async ({
  prepare,
  restart,
}) => {
  await prepare()
  await restart()
}

const baseEnvironment = () => Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME'].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
)

const serviceEnvironment = (exactNames, prefixes, overrides = {}) => ({
  ...baseEnvironment(),
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      value !== undefined &&
      (exactNames.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))),
    ),
  ),
  ...overrides,
})

export const hostWebAPIForwardedEnvironmentPrefixes = Object.freeze([
  'OAUTH_',
  'GOOGLE_',
  'KAKAO_',
  'NAVER_',
  'EMAIL_',
  'RESEND_',
  'X402_',
])

export const hostWebAPIForwardedEnvironmentNames = Object.freeze([
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

export const privateObjectWriteEnvironment = (environment) =>
  environment.PRIVATE_OBJECT_ENCRYPTION_KEY
    ? {
        PRIVATE_OBJECT_ENCRYPTION_KEY:
          environment.PRIVATE_OBJECT_ENCRYPTION_KEY,
        PRIVATE_OBJECT_ENCRYPTION_KEY_ID:
          environment.PRIVATE_OBJECT_ENCRYPTION_KEY_ID ?? 'primary',
      }
    : {}

export const hostWebAPIEngineEnvironment = (engineSocket) => {
  const target = `unix:${engineSocket}`
  return {
    ENGINE_GRPC_INSECURE_TARGET: target,
    GIWA_HOST_ENGINE_TARGET: target,
  }
}

export const hostPostingWorkerArgs = (
  artifacts,
  repository,
  claimPolicy,
) => [
  '--artifact-root',
  join(artifacts, 'source', 'root'),
  '--artifact-temp',
  join(artifacts, 'source', 'tmp'),
  '--service-root',
  repository,
  '--claim-policy',
  claimPolicy,
]

export const hostPostingWorkerEnvironment = (
  trustKey,
  eventURL,
  sourceURL,
) => {
  if (!trustKey) {
    throw new Error('DAEJANG_PUBLICATION_POLICY_TRUST_KEY is missing')
  }
  return {
    DAEJANG_PUBLICATION_POLICY_TRUST_KEY: trustKey,
    DAEJANG_POSTING_DATABASE_URL: eventURL,
    DAEJANG_POSTING_ARTIFACT_DATABASE_URL: sourceURL,
  }
}

export const hostEVMPostingWorkerArgs = (
  artifacts,
  temporaryArtifacts,
  claimPolicy,
  actionRuntimeRelease,
) => {
  if (
    actionRuntimeRelease?.repository !== 'BackwardLabs/DeFi-Label' ||
    !/^[0-9a-f]{40}$/.test(actionRuntimeRelease?.commit) ||
    !/^[0-9a-f]{64}$/.test(actionRuntimeRelease?.bundleSha256)
  ) {
    throw new Error('A verified DeFi Action runtime release coordinate is required')
  }
  return [
    '--mode',
    'canonical',
    '--artifact-root',
    artifacts,
    '--artifact-temp',
    temporaryArtifacts,
    '--claim-policy',
    claimPolicy,
    '--trusted-action-runtime-repository',
    actionRuntimeRelease.repository,
    '--trusted-action-runtime-commit',
    actionRuntimeRelease.commit,
    '--trusted-action-runtime-bundle-sha256',
    actionRuntimeRelease.bundleSha256,
  ]
}

export const hostEVMPostingWorkerEnvironment = (trustKey, eventURL) => {
  if (!trustKey) {
    throw new Error('DAEJANG_PUBLICATION_POLICY_TRUST_KEY is missing')
  }
  return {
    DAEJANG_PUBLICATION_POLICY_TRUST_KEY: trustKey,
    DAEJANG_POSTING_DATABASE_URL: eventURL,
  }
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const waitFor = async (label, probe, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await probe()) return
    await sleep(200)
  }
  throw new Error(`${label} did not become ready within ${timeout}ms`)
}

const observedCommandLine = (pid) => spawnSync(
  'ps',
  ['-ww', '-p', String(pid), '-o', 'command='],
  { encoding: 'utf8' },
)

export const tryAcquireProcessLock = (
  path,
  observe = observedCommandLine,
) => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const observation = observe(process.pid)
  if (observation.status !== 0 || typeof observation.stdout !== 'string') {
    throw new Error(`Unable to inspect process identity for lock: ${path}`)
  }
  const lockContent = `${JSON.stringify({
    pid: process.pid,
    commandLine: observation.stdout.trim(),
    token: randomUUID(),
  })}\n`
  try {
    const descriptor = openSync(temporaryPath, 'wx', fileMode)
    try {
      writeFileSync(descriptor, lockContent)
    } catch (error) {
      throw error
    } finally {
      closeSync(descriptor)
    }
    linkSync(temporaryPath, path)
    return lockContent
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let existing
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error(`Malformed backend lock requires manual removal: ${path}`)
    }
    const observed = observe(existing.pid)
    if (
      observed.status === 0 &&
      observed.stdout.trim() === existing.commandLine
    ) return null
    throw new Error(`Stale backend lock requires manual removal: ${path}`)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export const releaseProcessLock = (path, lockContent) => {
  if (readFileSync(path, 'utf8') !== lockContent) {
    throw new Error(`Backend lock ownership changed unexpectedly: ${path}`)
  }
  rmSync(path)
}

let shutdownRequested = false
let activeOperationPromise = null

const withOperationLock = async (
  operation,
  { allowDuringShutdown = false } = {},
) => {
  ensureRuntimeDirectories()
  const deadline = Date.now() + 60_000
  let lockContent
  while (!(lockContent = tryAcquireProcessLock(operationLockFile))) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for backend operation lock')
    }
    await sleep(200)
  }
  const execution = Promise.resolve().then(() => {
    if (shutdownRequested && !allowDuringShutdown) {
      throw new Error('Backend shutdown was requested')
    }
    return operation()
  })
  activeOperationPromise = execution
  try {
    return await execution
  } finally {
    if (activeOperationPromise === execution) activeOperationPromise = null
    releaseProcessLock(operationLockFile, lockContent)
  }
}

const tcpReady = (port) =>
  new Promise((resolveReady) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolveReady(true)
    })
    const fail = () => {
      socket.destroy()
      resolveReady(false)
    }
    socket.once('error', fail)
    socket.once('timeout', fail)
  })

const unixReady = (socketPath) => new Promise((resolveReady) => {
  const socket = net.createConnection(socketPath)
  socket.setTimeout(500)
  socket.once('connect', () => {
    socket.destroy()
    resolveReady(true)
  })
  const fail = () => {
    socket.destroy()
    resolveReady(false)
  }
  socket.once('error', fail)
  socket.once('timeout', fail)
})

const parserReady = () => {
  const socketPath = join(socketRoot, 'pdf-parser.sock')
  if (!existsSync(socketPath)) return Promise.resolve(false)
  return new Promise((resolveReady) => {
    const socket = net.createConnection(socketPath)
    const chunks = []
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.write(Buffer.from('DJPING01'))
      socket.end()
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('close', () =>
      resolveReady(Buffer.concat(chunks).toString() === 'DJPONG01'),
    )
    const fail = () => {
      socket.destroy()
      resolveReady(false)
    }
    socket.once('error', fail)
    socket.once('timeout', fail)
  })
}

const engineReady = () => {
  const engineSocket = join(socketRoot, 'engine.sock')
  const healthcheck = join(binaryRoot, 'engine-healthcheck')
  if (!existsSync(engineSocket) || !existsSync(healthcheck)) return false
  const result = spawnSync(healthcheck, [], {
    env: serviceEnvironment([], [], {
      ENGINE_HEALTH_TARGET: `unix://${engineSocket}`,
    }),
    stdio: 'ignore',
  })
  return result.status === 0
}

const webReady = async () => {
  try {
    return (
      await fetch(
        `http://127.0.0.1:${process.env.GIWA_HOST_API_PORT ?? '3001'}/readyz`,
      )
    ).ok
  } catch {
    return false
  }
}

export const taxRuntimeIdentityMatches = (identity, candidateDigest) => {
  if (!/^[0-9a-f]{64}$/.test(candidateDigest ?? '')) return false
  let parsed
  try {
    parsed = typeof identity === 'string' ? JSON.parse(identity) : identity
  } catch {
    return false
  }
  return parsed?.schemaVersion === 'tax.runtime-identity.v1' &&
    parsed.candidateDigest === candidateDigest &&
    parsed.ready === true
}

export const taxRuntimeIdentityResponseReady = (
  { status, contentType, body },
  candidateDigest,
) => status === 200 &&
  /^application\/json(?:\s*;|$)/i.test(contentType ?? '') &&
  taxRuntimeIdentityMatches(body, candidateDigest)

const taxRuntimeReady = async (candidateDigest) => {
  try {
    const response = await fetch('http://127.0.0.1:8981/identityz', {
      signal: AbortSignal.timeout(1_000),
    })
    return taxRuntimeIdentityResponseReady({
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.text(),
    }, candidateDigest)
  } catch {
    return false
  }
}

const coreRuntimeHealthy = async () => {
  const coreServices = hostActiveServiceOrder({
    evmPosting: evmPostingEnabled(),
    taxd: false,
  })
  if (!coreServices.every(isRunning)) return false
  const jitSocket = join(socketRoot, 'jit.sock')
  return (
    await parserReady() &&
    existsSync(jitSocket) &&
    await unixReady(jitSocket) &&
    engineReady() &&
    existsSync(join(stateRoot, 'worker.ready')) &&
    await webReady()
  )
}

const runtimeHealthy = async () => {
  if (!await coreRuntimeHealthy()) return false
  if (!taxdEnabled()) return true
  const state = readTaxdProfileState()
  return state?.status === 'ACTIVE' &&
    isRunning('taxd') &&
    await taxRuntimeReady(state.candidateDigest)
}

const databaseURL = (role, password) => {
  if (!password) throw new Error(`Database password for ${role} is missing`)
  const url = new URL('postgresql://127.0.0.1:55432/daejang')
  url.username = role
  url.password = password
  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

export const assertCleanGitCheckout = (
  repository,
  label,
  inspect = (command, args, options) => spawnSync(command, args, options),
) => {
  const result = inspect(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: repository, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${label} checkout: ${repository}`)
  }
  if (result.stdout.trim()) {
    throw new Error(
      `${label} checkout has uncommitted or untracked changes; deploy a pinned clean checkout: ${repository}`,
    )
  }
}

const assertCleanRuntimeCheckouts = () => {
  for (const [repository, label] of [
    [repositoryRoot, 'Host application'],
    [databaseRepository, 'Database contract'],
    [postingRepository, 'Posting Service'],
    [taxRepository, 'Tax Engine'],
    [schemaRepository, 'Schema'],
    [jitRepository, 'JIT engine'],
    [deFiLabelRepository, 'DeFi Action runtime'],
  ]) {
    assertCleanGitCheckout(repository, label)
  }
}

const buildTaxBinaries = () => {
  for (const [command, output] of [
    ['./cmd/taxd', join(binaryRoot, 'taxd')],
    ['./cmd/tax-backfill', join(binaryRoot, 'tax-backfill')],
    ['./cmd/upbit-candle-sync', join(binaryRoot, 'upbit-candle-sync')],
  ]) {
    run('go', ['build', '-o', output, command], {
      cwd: taxRepository,
      env: {
        ...baseEnvironment(),
        GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
        GOWORK: 'off',
        GOPRIVATE: 'github.com/BackwardLabs',
        GONOSUMDB: 'github.com/BackwardLabs',
        GOPROXY: 'direct',
      },
    })
  }
}

const stageUpbitCandleCollectorRelease = () => {
  writeRuntimeFileAtomically(
    upbitCandleCollectorQuoteConfigFile,
    readFileSync(
      join(taxRepository, 'config', 'upbit-quote-provider.v1.json'),
    ),
  )
  writeTaxBinaryReleaseManifest()
}

const build = () => {
  assertCleanRuntimeCheckouts()
  run('npm', ['run', 'build', '--workspace', '@daejang/web-api'], {
    cwd: repositoryRoot,
    env: baseEnvironment(),
  })
  run('go', [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-o',
    managedJITBinary,
    './cmd/jitd',
  ], {
    cwd: jitRepository,
    env: {
      ...baseEnvironment(),
      GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
    },
  })
  for (const [command, output] of [
    ['./cmd/engine-api', join(binaryRoot, 'engine-api')],
    ['./cmd/engine-healthcheck', join(binaryRoot, 'engine-healthcheck')],
    ['./cmd/sync-worker', join(binaryRoot, 'sync-worker')],
    [
      './cmd/action-runtime-reclassify',
      join(binaryRoot, 'action-runtime-reclassify'),
    ],
  ]) {
    run('go', ['build', '-o', output, command], {
      cwd: join(repositoryRoot, 'services', 'engine'),
      env: {
        ...baseEnvironment(),
        GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
      },
    })
  }
  run('go', ['build', '-o', join(binaryRoot, 'posting-worker'), './cmd/posting-worker'], {
    cwd: postingRepository,
    env: {
      ...baseEnvironment(),
      GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
      GOWORK: 'off',
      GOPRIVATE: 'github.com/BackwardLabs',
      GONOSUMDB: 'github.com/BackwardLabs',
      GOPROXY: 'direct',
    },
  })
  buildTaxBinaries()
  run('go', [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-o',
    join(binaryRoot, 'evm-posting-worker'),
    './cmd/evm-posting-worker',
  ], {
    cwd: postingRepository,
    env: {
      ...baseEnvironment(),
      GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
      GOWORK: 'off',
      GOPRIVATE: 'github.com/BackwardLabs',
      GONOSUMDB: 'github.com/BackwardLabs',
      GOPROXY: 'direct',
    },
  })
  const {
    code: webAPIRuntime,
    assets: webAPIAssetsRuntime,
    nodeModules: runtimeNodeModules,
  } = hostWebAPIRuntimePaths(runtimeRoot)
  rmSync(webAPIRuntime, { recursive: true, force: true })
  mkdirSync(dirname(webAPIRuntime), { recursive: true, mode: directoryMode })
  cpSync(join(repositoryRoot, 'apps', 'web-api', 'dist'), webAPIRuntime, {
    recursive: true,
  })
  rmSync(webAPIAssetsRuntime, { recursive: true, force: true })
  cpSync(
    join(repositoryRoot, 'apps', 'web-api', 'assets'),
    webAPIAssetsRuntime,
    { recursive: true },
  )
  const runtimeProto = join(runtimeRoot, 'proto')
  rmSync(runtimeProto, { recursive: true, force: true })
  cpSync(join(repositoryRoot, 'proto'), runtimeProto, { recursive: true })
  rmSync(runtimeNodeModules, { recursive: true, force: true })
  symlinkSync(join(repositoryRoot, 'node_modules'), runtimeNodeModules, 'dir')
  stageUpbitCandleCollectorRelease()
}

const startUpbitCandleCollectorOnly = () => withOperationLock(async () => {
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  assertUpbitCollectorReleaseReplaceable(
    allServiceOrder.filter(isRunning),
  )
  await runUpbitCollectorStartOperation({
    prepare: async () => {
      assertCleanRuntimeCheckouts()
      buildTaxBinaries()
      stageUpbitCandleCollectorRelease()
    },
    restart: restartUpbitCandleCollector,
  })
  console.log(
    'Upbit candle collector is running without changing the backend pause state or starting taxd',
  )
})

export const combinedJITConfigExpression = ({
  socket,
  artifactRoot,
  artifactTemp,
}) =>
  [
    '. as $item ireduce ({}; . * $item)',
    `.server.listen = ${JSON.stringify(`unix://${socket}`)}`,
    `.persistence.artifact.root = ${JSON.stringify(artifactRoot)}`,
    `.persistence.artifact.temp = ${JSON.stringify(artifactTemp)}`,
  ].join(' | ')

const createCombinedJITConfig = () => {
  const output = join(configRoot, 'ethereum-optimism-mainnet.yaml')
  const result = spawnSync(
    process.env.YQ_BINARY ?? '/opt/homebrew/bin/yq',
    [
      'ea',
      combinedJITConfigExpression({
        socket: join(socketRoot, 'jit.sock'),
        artifactRoot: jitArtifactRoot,
        artifactTemp: jitArtifactTemp,
      }),
      join(jitRepository, 'configs', 'ethereum-mainnet.yaml'),
      join(jitRepository, 'configs', 'optimism-mainnet.yaml'),
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0)
    throw new Error('Unable to create combined JIT config')
  writeFileSync(output, result.stdout, { mode: fileMode })
  return output
}

export const normalizeMultichainSnapshotIds = (config) => {
  const coverageGroups = new Map()
  for (const chain of config.chains ?? []) {
    for (const coverage of chain.coverage ?? []) {
      const key = `${coverage.coverageStart}\u0000${coverage.coverageEnd}`
      const group = coverageGroups.get(key) ?? []
      group.push({ chain, coverage })
      coverageGroups.set(key, group)
    }
  }

  for (const group of coverageGroups.values()) {
    if (new Set(group.map(({ chain }) => chain.chainId)).size < 2) continue
    const manifest = group
      .map(({ chain, coverage }) => ({
        chainId: chain.chainId,
        chainStore: chain.chainStore,
        coverageEnd: coverage.coverageEnd,
        coverageStart: coverage.coverageStart,
        fromBlock: coverage.fromBlock,
        genesisHash: chain.genesisHash,
        profileHash: chain.profileHash,
        sourceSnapshotId: coverage.indexSnapshotId,
        toBlock: coverage.toBlock,
      }))
      .sort((left, right) => left.chainId.localeCompare(right.chainId))
    const snapshotId = createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex')
    for (const { coverage } of group) coverage.indexSnapshotId = snapshotId
  }
  return config
}

const createRuntimeBridgeConfig = (source) => {
  const output = join(configRoot, 'jit-bridge.runtime.json')
  const config = normalizeMultichainSnapshotIds(
    JSON.parse(readFileSync(source, 'utf8')),
  )
  config.endpoint = `unix://${join(socketRoot, 'jit.sock')}`
  const chainStores = new Map([
    ['eip155:1', 'ethereum-mainnet-tail'],
    ['eip155:10', 'optimism-mainnet-bulk-bedrock-tail'],
  ])
  for (const chain of config.chains ?? []) {
    if (chainStores.has(chain.chainId)) {
      chain.chainStore = chainStores.get(chain.chainId)
    }
  }
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
    mode: fileMode,
  })
  return output
}

export const createRuntimeSubjectACL = (
  source,
  output,
  uid = process.getuid?.(),
) => {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Current service UID is unavailable')
  }
  const document = JSON.parse(readFileSync(source, 'utf8'))
  if (document?.version !== 1 || !Array.isArray(document.grants)) {
    throw new Error('JIT subject ACL must be a version 1 grants document')
  }
  const localGrants = document.grants.filter(
    (grant) => typeof grant?.identity === 'string' && /^uid:\d+$/.test(grant.identity),
  )
  if (localGrants.length !== 1) {
    throw new Error('JIT subject ACL must contain exactly one local UID grant')
  }
  localGrants[0].identity = `uid:${uid}`
  // The authenticated local sync worker is the subject broker. Dashboard
  // subjects are created dynamically, so a static per-user allowlist cannot
  // represent the production trust boundary. Remote mTLS identities retain
  // their explicit subject lists in the same document.
  localGrants[0].subjects = []
  localGrants[0].allowAnySubject = true
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: fileMode })
  chmodSync(output, fileMode)
  return output
}

export const resolveRuntimeSubjectACLSource = (
  defaultSource,
  overrideSource,
  fileExists = existsSync,
) => {
  if (!isAbsolute(defaultSource) || !isAbsolute(overrideSource)) {
    throw new Error('JIT subject ACL source paths must be absolute')
  }
  return fileExists(overrideSource) ? overrideSource : defaultSource
}

export const createRuntimeIndexerConfig = (
  localSource,
  bulkSource,
  output,
  dataDir,
) => {
  const local = JSON.parse(readFileSync(localSource, 'utf8'))
  const bulk = JSON.parse(readFileSync(bulkSource, 'utf8'))
  const ethereum = local.chains?.find((chain) => chain?.name === 'ethereum-mainnet')
  const optimism = bulk.chains?.find((chain) => chain?.name === 'optimism-mainnet-bulk-bedrock')
  if (!ethereum || !optimism || !isAbsolute(dataDir)) {
    throw new Error('EVM indexer config is missing a required JIT chain or absolute dataDir')
  }
  const ethereumTail = structuredClone(ethereum)
  ethereumTail.name = 'ethereum-mainnet-tail'
  ethereumTail.sourceKind = 'remote-finalized-single-source'
  ethereumTail.startBlock = 25559129
  delete ethereumTail.liveSource
  delete ethereumTail.livePath
  const optimismTail = structuredClone(optimism)
  optimismTail.name = 'optimism-mainnet-bulk-bedrock-tail'
  optimismTail.startBlock = 154465211
  // Candidate queries are offline reads. Keep required supplemental-RPC syntax
  // closed on loopback instead of forwarding an unrelated production secret.
  optimismTail.supplementalRpcUrl = 'http://127.0.0.1:1'
  const document = {
    ...local,
    dataDir,
    sharedRead: true,
    chains: [ethereumTail, optimismTail],
  }
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: fileMode })
  chmodSync(output, fileMode)
  return output
}

export const ensureRuntimeIndexerView = (root, stores) => {
  if (!isAbsolute(root)) throw new Error('EVM indexer view root must be absolute')
  mkdirSync(root, { recursive: true, mode: directoryMode })
  chmodSync(root, directoryMode)
  for (const [name, source] of Object.entries(stores)) {
    if (!/^[a-z0-9-]+$/.test(name) || !isAbsolute(source) || !statSync(source).isDirectory()) {
      throw new Error(`Invalid EVM indexer view store ${name}`)
    }
    const destination = join(root, name)
    if (!existsSync(destination)) {
      symlinkSync(source, destination, 'dir')
      continue
    }
    if (!lstatSync(destination).isSymbolicLink() || resolve(dirname(destination), readlinkSync(destination)) !== resolve(source)) {
      throw new Error(`EVM indexer view store ${name} changed unexpectedly`)
    }
  }
  return root
}

const canonicalJSON = (value) => {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, normalize(item[key])]),
      )
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const createActionRuntimeIdentity = (
  repository,
  jitExecutable,
  postingExecutable,
) => {
  if (!jitExecutable || !postingExecutable) {
    throw new Error('The pinned JIT and EVM Posting executables are required for runtime identity')
  }
  const files = [
    'releases/action-registry-v1.json',
    'scripts/registry.py',
    'scripts/transaction_adapter.py',
    'scripts/action_evaluator.py',
  ].map((path) => ({ path, sha256: sha256(readFileSync(join(repository, path))) }))
  return sha256(canonicalJSON({
    schemaVersion: 'giwa.action-runtime-identity.v3',
    files,
    // Action evaluation consumes evidence emitted by this exact executable.
    // Rotating either side must enqueue a new immutable wallet generation.
    jitExecutableSha256: sha256(readFileSync(jitExecutable)),
    // Canonical Event identity and revision convergence are writer behavior.
    // A writer upgrade must replay existing wallet sources even when the
    // registry and JIT evidence bytes themselves did not change.
    postingExecutableSha256: sha256(readFileSync(postingExecutable)),
  }))
}

export const loadVerifiedActionRuntimeRelease = (
  repository,
  inspect = (command, args, options) => spawnSync(command, args, options),
  read = readFileSync,
) => {
  const releaseRoot = join(repository, 'releases')
  const files = {
    bundle: join(releaseRoot, 'action-registry-v1.json'),
    checksum: join(releaseRoot, 'action-registry-v1.json.sha256'),
    receipt: join(releaseRoot, 'action-registry-v1.json.receipt.json'),
    signature: join(releaseRoot, 'action-registry-v1.signature.json'),
    publicKey: join(releaseRoot, 'action-registry-v1.public-key.pem'),
  }
  const verification = inspect(
    process.env.GIWA_DEFI_LABEL_PYTHON ?? 'python3',
    [
      join(repository, 'scripts', 'registry.py'),
      'verify-runtime-release',
      '--bundle', files.bundle,
      '--checksum', files.checksum,
      '--receipt', files.receipt,
      '--signature', files.signature,
      '--public-key', files.publicKey,
    ],
    { cwd: repository, encoding: 'utf8' },
  )
  let verified
  try {
    verified = JSON.parse(verification.stdout ?? '')
  } catch {
    verified = null
  }
  if (verification.status !== 0 || verified?.valid !== true) {
    throw new Error('DeFi Action runtime signed release verification failed')
  }

  const bundleContents = read(files.bundle)
  const bundleDigest = sha256(bundleContents)
  const bundle = JSON.parse(bundleContents.toString())
  const receipt = JSON.parse(read(files.receipt, 'utf8'))
  const checksum = read(files.checksum, 'utf8')
  if (
    bundle.schemaVersion !== 'defi-label.action-registry.v1' ||
    bundle.registrySourceRepository !== 'BackwardLabs/DeFi-Label' ||
    !/^[0-9a-f]{40}$/.test(bundle.registrySourceCommit) ||
    receipt.registrySourceRepository !== bundle.registrySourceRepository ||
    receipt.registrySourceCommit !== bundle.registrySourceCommit ||
    receipt.bundleSha256 !== bundleDigest ||
    checksum !== `${bundleDigest}\n`
  ) {
    throw new Error('DeFi Action runtime release coordinates are inconsistent')
  }
  const ancestry = inspect(
    'git',
    ['merge-base', '--is-ancestor', bundle.registrySourceCommit, 'HEAD'],
    { cwd: repository, encoding: 'utf8' },
  )
  if (ancestry.status !== 0) {
    throw new Error('DeFi Action runtime release source is not in the deployed checkout')
  }
  return {
    repository: bundle.registrySourceRepository,
    commit: bundle.registrySourceCommit,
    bundleSha256: bundleDigest,
  }
}

const decodePublicationTrustKey = (value) => {
  if (!value) throw new Error('DAEJANG_PUBLICATION_POLICY_TRUST_KEY is missing')
  const direct = Buffer.from(value, 'latin1')
  if (direct.length === 32) return direct
  if (/^[0-9a-f]{64}$/.test(value)) return Buffer.from(value, 'hex')
  for (const encoding of ['base64', 'base64url']) {
    const decoded = Buffer.from(value, encoding)
    if (decoded.length === 32) return decoded
  }
  throw new Error('Publication policy trust key is not a 32-byte Ed25519 key')
}

const gitCommit = (repository) => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  })
  const commit = result.stdout?.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Unable to resolve Git commit for ${repository}`)
  }
  return commit
}

export const pinnedGoModuleCommitPrefix = (goMod, modulePath) => {
  const fields = goMod.split(/\r?\n/).map((value) =>
    value.trim().split(/\s+/)).find((value) =>
    value[0] === modulePath ||
    value[0] === 'require' && value[1] === modulePath)
  const version = fields?.[0] === 'require'
    ? fields[2] ?? ''
    : fields?.[1] ?? ''
  const match = version.match(/-([0-9a-f]{12,40})(?:\+incompatible)?$/)
  if (!match) {
    throw new Error(`Go module ${modulePath} is not pinned to a Git revision`)
  }
  return match[1]
}

const currentTaxBinaryRelease = () => {
  const dbCommit = gitCommit(databaseRepository)
  const embeddedDBCommitPrefix = pinnedGoModuleCommitPrefix(
    readFileSync(join(taxRepository, 'go.mod'), 'utf8'),
    'github.com/BackwardLabs/daejang-db',
  )
  if (!dbCommit.startsWith(embeddedDBCommitPrefix)) {
    throw new Error(
      `Tax binary embeds daejang-db ${embeddedDBCommitPrefix}, but the runtime DB checkout is ${dbCommit}`,
    )
  }
  return {
    schemaVersion: 'giwa.tax-binary-release.v1',
    dbCommit,
    jitCommit: gitCommit(jitRepository),
    postingCommit: gitCommit(postingRepository),
    schemaCommit: gitCommit(schemaRepository),
    taxBackfillBinarySha256: sha256(
      readFileSync(join(binaryRoot, 'tax-backfill')),
    ),
    taxCommit: gitCommit(taxRepository),
    taxdBinarySha256: sha256(readFileSync(join(binaryRoot, 'taxd'))),
    upbitCandleSyncBinarySha256: sha256(
      readFileSync(join(binaryRoot, 'upbit-candle-sync')),
    ),
    upbitCandleSyncQuoteConfigSha256: sha256(
      readFileSync(upbitCandleCollectorQuoteConfigFile),
    ),
  }
}

const writeTaxBinaryReleaseManifest = () => {
  const release = currentTaxBinaryRelease()
  writeRuntimeFileAtomically(
    taxBinaryReleaseManifestFile,
    `${canonicalJSON(release)}\n`,
  )
  return release
}

const loadTaxBinaryReleaseManifest = () => {
  let release
  try {
    release = JSON.parse(
      readFileSync(taxBinaryReleaseManifestFile, 'utf8'),
    )
  } catch (error) {
    throw new Error(`Read Tax binary release manifest: ${error.message}`)
  }
  const commit = (value) => typeof value === 'string' &&
    /^[0-9a-f]{40}$/.test(value)
  const digest = (value) => typeof value === 'string' &&
    /^[0-9a-f]{64}$/.test(value)
  if (
    release?.schemaVersion !== 'giwa.tax-binary-release.v1' ||
    !commit(release.dbCommit) ||
    !commit(release.jitCommit) ||
    !commit(release.postingCommit) ||
    !commit(release.schemaCommit) ||
    !commit(release.taxCommit) ||
    !digest(release.taxBackfillBinarySha256) ||
    !digest(release.taxdBinarySha256) ||
    !digest(release.upbitCandleSyncBinarySha256) ||
    !digest(release.upbitCandleSyncQuoteConfigSha256)
  ) {
    throw new Error('Tax binary release manifest failed its runtime contract')
  }
  const current = currentTaxBinaryRelease()
  if (canonicalJSON(release) !== canonicalJSON(current)) {
    throw new Error(
      'Tax binaries or semantic checkout commits differ from the built release manifest',
    )
  }
  return release
}

const taxDenominationAssetId = 'asset-krw-upbit'
const taxDenominationTaxAssetId = 'tax-asset-krw'

export const createTaxProfiles = (rows, upbitConfig) => {
  if (upbitConfig?.denomination?.assetId !== taxDenominationAssetId) {
    throw new Error(
      `Tax quote denomination must be ${taxDenominationAssetId}`,
    )
  }
  const quoteAssetIds = new Set(
    (upbitConfig.assets ?? []).map(({ assetId }) => assetId),
  )
  const subjects = new Map()
  for (const row of rows) {
    const subject = subjects.get(row.subject_id) ?? {
      accounts: new Set(),
      assets: new Set(),
      taxAssetIds: new Map(),
      identityMissingAssetIds: new Set(),
    }
    subject.accounts.add(row.account_id)
    subject.assets.add(row.asset_id)
    if (typeof row.tax_asset_id === 'string' && row.tax_asset_id.length > 0) {
      const taxAssetIds = subject.taxAssetIds.get(row.asset_id) ?? new Set()
      taxAssetIds.add(row.tax_asset_id)
      subject.taxAssetIds.set(row.asset_id, taxAssetIds)
    } else {
      subject.identityMissingAssetIds.add(row.asset_id)
    }
    subjects.set(row.subject_id, subject)
  }
  const profiles = []
  for (const [subjectId, subject] of [...subjects].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const accountBindings = [...subject.accounts].sort().map((accountId) => ({
      accountId,
      taxAddressId: accountId,
      kind: accountId.startsWith('cex-account:') ? 'VASP' : 'OTHER',
      method: accountId.startsWith('cex-account:')
        ? 'MOVING_AVERAGE'
        : 'FIFO',
    }))
    const taxAssetByLedgerAsset = new Map()
    for (const assetId of [...subject.assets].sort()) {
      const taxAssetIds = [...(subject.taxAssetIds.get(assetId) ?? [])].sort()
      if (taxAssetIds.length > 1) {
        throw new Error(
          `Conflicting tax asset identities for ${subjectId}/${assetId}: ${taxAssetIds.join(', ')}`,
        )
      }
      if (
        taxAssetIds.length === 1 &&
        !subject.identityMissingAssetIds.has(assetId)
      ) {
        taxAssetByLedgerAsset.set(assetId, taxAssetIds[0])
      }
    }
    const observedDenominationTaxAssetIds = [
      ...(subject.taxAssetIds.get(taxDenominationAssetId) ?? []),
    ].sort()
    const conflictingDenominationTaxAssetId =
      observedDenominationTaxAssetIds.find(
        (taxAssetId) => taxAssetId !== taxDenominationTaxAssetId,
      )
    if (conflictingDenominationTaxAssetId !== undefined) {
      throw new Error(
        `Conflicting tax asset identity for ${subjectId}/${taxDenominationAssetId}: expected ${taxDenominationTaxAssetId}, got ${conflictingDenominationTaxAssetId}`,
      )
    }
    const assetBindings = [{
      ledgerAssetId: taxDenominationAssetId,
      taxAssetId: taxDenominationTaxAssetId,
    }]
    // Preserve an exact economic identity for Lot/Tax even when Upbit has no
    // candle mapping. Those assets are direct-consideration-only below.
    for (const assetId of [...subject.assets].sort()) {
      const taxAssetId = taxAssetByLedgerAsset.get(assetId)
      if (
        assetId !== taxDenominationAssetId &&
        !assetId.startsWith('cex-document-asset:') &&
        taxAssetId !== undefined
      ) {
        assetBindings.push({ ledgerAssetId: assetId, taxAssetId })
      }
    }
    const boundAssetIds = new Set(
      assetBindings.map(({ ledgerAssetId }) => ledgerAssetId),
    )
    const valuationExcludedAssetIds = [...subject.assets]
      .filter((assetId) =>
        assetId !== taxDenominationAssetId &&
        !boundAssetIds.has(assetId))
      .sort()
    const valuationDirectOnlyAssetIds = [...boundAssetIds]
      .filter((assetId) =>
        assetId !== taxDenominationAssetId &&
        !quoteAssetIds.has(assetId))
      .sort()
    for (const taxYear of [2025, 2026, 2027]) {
      profiles.push({
        subjectId,
        residentId: subjectId,
        taxYear,
        denominationAssetId: taxDenominationAssetId,
        accountBindings,
        assetBindings,
        valuationExcludedAssetIds,
        valuationDirectOnlyAssetIds,
      })
    }
  }
  return { schemaVersion: 'tax.downstream-profile-set.v1', profiles }
}

export const configureTaxUpbitQuoteRuntime = (config) => ({
  ...config,
  firstTradeAfterMaxSeconds: 604800,
  maxCandleAgeSeconds: 600,
  policyVersion: 'upbit-closed-minute-10m-or-inbound-first-trade-v4',
})

export const loadTaxActionRegistryRuntime = (
  repository,
  read = readFileSync,
) => {
  const releaseRoot = join(repository, 'internal', 'registry', 'release')
  const readRelease = (name) => read(join(releaseRoot, name), 'utf8')
  const bundleContents = readRelease('action-registry-v1.json')
  const bundle = JSON.parse(bundleContents)
  const receipt = JSON.parse(readRelease('action-registry-v1.json.receipt.json'))
  const signature = JSON.parse(readRelease('action-registry-v1.signature.json'))
  const bundleDigest = sha256(bundleContents)

  if (
    bundleDigest !== receipt.bundleSha256 ||
    bundleDigest !== signature.bundleSha256 ||
    bundle.registrySourceRepository !== receipt.registrySourceRepository ||
    bundle.registrySourceCommit !== receipt.registrySourceCommit ||
    bundle.exporterContractRepository !== receipt.exporterContractRepository ||
    bundle.exporterContractCommit !== receipt.exporterContractCommit ||
    bundle.profileCount !== bundle.profiles?.length
  ) {
    throw new Error('Tax Action Registry release artifacts are inconsistent')
  }

  const actionProfiles = bundle.profiles
    .filter(({ maturity }) => maturity === 'CANARY')
    .map(({ id, profileVersion, compiledAction }) => {
      if (!id || !profileVersion || !compiledAction) {
        throw new Error('Tax Action Registry CANARY profile is not executable')
      }
      return { profileId: id, profileVersion }
    })
    .sort((left, right) => left.profileId.localeCompare(right.profileId))
  if (actionProfiles.length === 0) {
    throw new Error('Tax Action Registry has no executable CANARY profiles')
  }

  return {
    registryPin: {
      bundleSchemaVersion: bundle.schemaVersion,
      registrySourceRepository: bundle.registrySourceRepository,
      registrySourceCommit: bundle.registrySourceCommit,
      exporterContractRepository: bundle.exporterContractRepository,
      exporterContractCommit: bundle.exporterContractCommit,
      bundleSha256: bundleDigest,
      signatureKeyId: signature.keyId,
      signaturePublicKeySha256: signature.publicKeySha256,
    },
    actionProfiles,
  }
}

export const currentTaxProfileRowsQuery = `
  SELECT DISTINCT
    event.subject_id,
    posting.account_id,
    posting.asset_id,
    tax_identity.tax_asset_id
  FROM ledger.interpreted_event AS event
  JOIN ledger.event_revision AS revision
    ON revision.subject_id = event.subject_id
   AND revision.event_id = event.event_id
   AND revision.revision_id = event.current_revision_id
  JOIN ledger.asset_posting AS posting
    ON posting.subject_id = revision.subject_id
   AND posting.event_id = revision.event_id
   AND posting.revision_id = revision.revision_id
  LEFT JOIN LATERAL (
    SELECT DISTINCT economic.value AS tax_asset_id
    FROM ledger.leg_evidence AS evidence
    JOIN ledger.assertion AS assertion
      ON assertion.subject_id = evidence.subject_id
     AND assertion.assertion_id = evidence.assertion_id
     AND assertion.ledger_revision_id = revision.ledger_revision_id
     AND assertion.kind = 'ASSET_IDENTITY'
     AND assertion.state = 'ACCEPTED'
     AND assertion.operation = 'ASSERT'
     AND assertion.effective_from IS NOT NULL
     AND assertion.effective_from <= posting.occurred_at
     AND (
       assertion.effective_to IS NULL
       OR posting.occurred_at <= assertion.effective_to
     )
    JOIN ledger.assertion_attribute AS ledger_asset
      ON ledger_asset.subject_id = assertion.subject_id
     AND ledger_asset.assertion_id = assertion.assertion_id
     AND ledger_asset.name = 'assetId'
     AND ledger_asset.value = posting.asset_id
    JOIN ledger.assertion_attribute AS economic
      ON economic.subject_id = assertion.subject_id
     AND economic.assertion_id = assertion.assertion_id
     AND economic.name = 'economicAssetId'
    JOIN ledger.assertion_target AS target
      ON target.subject_id = assertion.subject_id
     AND target.assertion_id = assertion.assertion_id
     AND target.kind = 'ASSET'
     AND target.target_id = posting.asset_id
    WHERE evidence.subject_id = posting.subject_id
      AND evidence.event_id = posting.event_id
      AND evidence.revision_id = posting.revision_id
      AND evidence.leg_id = posting.leg_id
      AND evidence.kind = 'ASSERTION'
  ) AS tax_identity ON TRUE
  WHERE event.current_revision_id IS NOT NULL
  ORDER BY
    event.subject_id,
    posting.account_id,
    posting.asset_id,
    tax_identity.tax_asset_id
`

const createTaxRuntime = async (queryURL) => {
  assertCleanRuntimeCheckouts()
  const upbitConfig = configureTaxUpbitQuoteRuntime(JSON.parse(readFileSync(
    join(taxRepository, 'config', 'upbit-quote-provider.v1.json'),
    'utf8',
  )))
  const client = new Client({ connectionString: queryURL })
  await client.connect()
  let rows
  let subjectEpochs
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await client.query(currentTaxProfileRowsQuery)
    rows = result.rows
    const epochResult = await client.query(currentTaxProfileEpochRowsQuery)
    subjectEpochs = normalizeTaxSubjectEpochs(epochResult.rows)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end()
  }

  const { registryPin, actionProfiles } = loadTaxActionRegistryRuntime(
    taxRepository,
  )
  const policy = canonicalJSON({
    name: 'production-ledger-consumer-policy',
    version: 'v1',
    schemaDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    protocols: [{
      id: 'ledger-only-placeholder',
      chainId: 'eip155:1',
      addresses: ['0x2222222222222222222222222222222222222222'],
      selectors: ['0x12345678'],
    }],
    v2ActionRegistry: {
      schemaVersion: 'tax.action-registry-declaration.v1',
      registryPin,
      profileDeclarations: actionProfiles.map(({ profileId }) => ({ profileId })),
    },
  })
  const activation = canonicalJSON({
    schemaVersion: 'tax.activation-set.v1',
    bundleSha256: registryPin.bundleSha256,
    rawPolicySha256: sha256(policy),
    registryPin,
    emergencyDenyProfileIds: [],
    profiles: actionProfiles.map(({ profileId, profileVersion }) => ({
      schemaVersion: 'tax.profile-activation.v1',
      profileId,
      profileVersion,
      runtimeState: 'DISABLED',
      activationIntentPath: null,
      activationIntentSha256: null,
      activationReceiptPath: null,
      activationReceiptSha256: null,
    })),
  })
  const profileSet = createTaxProfiles(rows, upbitConfig)
  if (profileSet.profiles.length === 0) {
    return {
      noProfiles: true,
      subjectIDs: [],
      subjectEpochs,
    }
  }
  const profiles = canonicalJSON(profileSet)

  const ownership = canonicalJSON({ assertions: [] })
  const quotes = canonicalJSON(upbitConfig)
  const trustKey = decodePublicationTrustKey(
    process.env.DAEJANG_PUBLICATION_POLICY_TRUST_KEY,
  )
  const {
    dbCommit,
    jitCommit,
    postingCommit,
    schemaCommit,
    taxBackfillBinarySha256,
    taxCommit,
    taxdBinarySha256,
  } = loadTaxBinaryReleaseManifest()
  const catalog = readFileSync(
    join(taxRepository, 'internal', 'registry', 'release', 'action-registry-v1.json'),
  )
  const activationDigest = sha256(activation)
  const catalogDigest = sha256(catalog)
  const candidateCoordinates = {
    schemaVersion: 'giwa.tax-runtime-candidate-coordinates.v1',
    activationDigest,
    catalogDigest,
    dbCommit,
    jitCommit,
    postingCommit,
    schemaCommit,
    taxBackfillBinarySha256,
    taxCommit,
    taxdBinarySha256,
    files: {
      activation: sha256(activation),
      ownership: sha256(ownership),
      policy: sha256(policy),
      profiles: sha256(profiles),
      quotes: sha256(quotes),
      trustKey: sha256(trustKey),
    },
  }
  const candidateDigest = sha256(canonicalJSON(candidateCoordinates))
  const candidateDirectory = join(taxCandidateRoot, candidateDigest)
  const files = {
    policy: join(candidateDirectory, 'policy.json'),
    ownership: join(candidateDirectory, 'ownership.json'),
    activation: join(candidateDirectory, 'activation.json'),
    profiles: join(candidateDirectory, 'profiles.json'),
    quotes: join(candidateDirectory, 'quotes.json'),
    trustKey: join(candidateDirectory, 'trust-key.pub'),
  }
  const subjectIDs = profileSet.profiles
    .filter(({ taxYear }) => taxYear === 2027)
    .map(({ subjectId }) => subjectId)
  const manifestPath = join(candidateDirectory, 'runtime.json')
  const manifest = canonicalJSON({
    schemaVersion: 'giwa.tax-runtime-candidate.v1',
    candidateDigest,
    activationDigest,
    catalogDigest,
    dbCommit,
    fileDigests: candidateCoordinates.files,
    files,
    jitCommit,
    postingCommit,
    schemaCommit,
    subjectIDs,
    taxBackfillBinarySha256,
    taxCommit,
    taxdBinarySha256,
  })
  const candidateFiles = [
    [files.policy, policy, fileMode],
    [files.ownership, ownership, fileMode],
    [files.activation, activation, fileMode],
    [files.profiles, profiles, fileMode],
    [files.quotes, quotes, fileMode],
    [files.trustKey, trustKey, 0o600],
    [manifestPath, `${manifest}\n`, fileMode],
  ]
  if (existsSync(candidateDirectory)) {
    const metadata = lstatSync(candidateDirectory)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid()
    ) {
      throw new Error('Existing Tax candidate is not an owned directory')
    }
    for (const [path, contents] of candidateFiles) {
      const fileMetadata = lstatSync(path)
      if (
        fileMetadata.isSymbolicLink() ||
        !fileMetadata.isFile() ||
        fileMetadata.uid !== process.getuid()
      ) {
        throw new Error(`Existing Tax candidate file is not owned: ${path}`)
      }
      const expected = Buffer.isBuffer(contents)
        ? contents
        : Buffer.from(contents)
      const actual = readFileSync(path)
      if (!actual.equals(expected)) {
        throw new Error(
          `Existing Tax candidate differs from its digest coordinate: ${path}`,
        )
      }
    }
  } else {
    const temporaryDirectory = join(
      taxCandidateRoot,
      `.${candidateDigest}.${process.pid}.${randomUUID()}.tmp`,
    )
    mkdirSync(temporaryDirectory, { mode: 0o700 })
    try {
      for (const [path, contents, mode] of candidateFiles) {
        const temporaryPath = join(temporaryDirectory, basename(path))
        writeRuntimeFileAtomically(temporaryPath, contents, mode)
      }
      renameSync(temporaryDirectory, candidateDirectory)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  return {
    files,
    subjectIDs,
    subjectEpochs,
    activationDigest,
    candidateDigest,
    manifestPath,
    schemaCommit,
    jitCommit,
    dbCommit,
    postingCommit,
    taxCommit,
    catalogDigest,
    taxBackfillBinarySha256,
    taxdBinarySha256,
  }
}

const taxRuntimeHasProfiles = (runtime) =>
  runtime?.noProfiles !== true &&
  Array.isArray(runtime?.subjectIDs) &&
  runtime.subjectIDs.length > 0

const taxCandidateFileNames = [
  'activation.json',
  'ownership.json',
  'policy.json',
  'profiles.json',
  'quotes.json',
  'runtime.json',
  'trust-key.pub',
]

export const pruneTaxCandidateDirectories = ({
  root,
  activeDigest,
  retainCount = 3,
  uid = process.getuid(),
}) => {
  if (!/^[0-9a-f]{64}$/.test(activeDigest ?? '') ||
      !Number.isSafeInteger(retainCount) || retainCount < 1) {
    throw new Error('Tax candidate pruning requires an active digest and positive retention count')
  }
  const rootMetadata = lstatSync(root)
  if (rootMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() || rootMetadata.uid !== uid) {
    throw new Error('Tax candidate root is not an owned directory')
  }
  const candidates = []
  for (const name of readdirSync(root)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue
    const directory = join(root, name)
    const metadata = lstatSync(directory)
    if (metadata.isSymbolicLink() ||
        !metadata.isDirectory() || metadata.uid !== uid) {
      throw new Error(`Tax candidate is not an owned directory: ${name}`)
    }
    const fileNames = readdirSync(directory).sort()
    if (canonicalJSON(fileNames) !== canonicalJSON(taxCandidateFileNames)) {
      throw new Error(`Tax candidate has unexpected files: ${name}`)
    }
    for (const fileName of fileNames) {
      const fileMetadata = lstatSync(join(directory, fileName))
      if (fileMetadata.isSymbolicLink() ||
          !fileMetadata.isFile() || fileMetadata.uid !== uid) {
        throw new Error(`Tax candidate file is not owned: ${name}/${fileName}`)
      }
    }
    const manifest = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    if (manifest?.schemaVersion !== 'giwa.tax-runtime-candidate.v1' ||
        manifest.candidateDigest !== name) {
      throw new Error(`Tax candidate manifest identity is invalid: ${name}`)
    }
    candidates.push({ name, directory, mtimeMs: metadata.mtimeMs })
  }
  if (!candidates.some(({ name }) => name === activeDigest)) {
    throw new Error('Active Tax candidate directory is missing')
  }
  candidates.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
  const retained = new Set([activeDigest])
  for (const candidate of candidates) {
    if (retained.size >= retainCount) break
    retained.add(candidate.name)
  }
  const removed = []
  for (const candidate of candidates) {
    if (retained.has(candidate.name)) continue
    rmSync(candidate.directory, { recursive: true })
    removed.push(candidate.name)
  }
  return removed.sort()
}

const loadActiveTaxRuntime = (state) => {
  if (
    state?.status !== 'ACTIVE' ||
    !/^[0-9a-f]{64}$/.test(state.candidateDigest ?? '') ||
    typeof state.runtimeManifestPath !== 'string' ||
    resolve(state.runtimeManifestPath) !== state.runtimeManifestPath ||
    !pathIsWithin(taxCandidateRoot, state.runtimeManifestPath)
  ) {
    throw new Error('Active Tax runtime state has no valid candidate manifest')
  }
  const candidateDirectory = dirname(state.runtimeManifestPath)
  const directoryMetadata = lstatSync(candidateDirectory)
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    directoryMetadata.uid !== process.getuid()
  ) {
    throw new Error('Active Tax candidate directory is not a private owned directory')
  }
  const manifest = JSON.parse(readFileSync(state.runtimeManifestPath, 'utf8'))
  const digest = (value) => typeof value === 'string' &&
    /^[0-9a-f]{64}$/.test(value)
  const commit = (value) => typeof value === 'string' &&
    /^[0-9a-f]{40}$/.test(value)
  const fileKeys = [
    'activation',
    'ownership',
    'policy',
    'profiles',
    'quotes',
    'trustKey',
  ]
  if (
    manifest?.schemaVersion !== 'giwa.tax-runtime-candidate.v1' ||
    manifest.candidateDigest !== state.candidateDigest ||
    !digest(manifest.activationDigest) ||
    !digest(manifest.catalogDigest) ||
    !digest(manifest.taxBackfillBinarySha256) ||
    !digest(manifest.taxdBinarySha256) ||
    !commit(manifest.dbCommit) ||
    !commit(manifest.jitCommit) ||
    !commit(manifest.postingCommit) ||
    !commit(manifest.schemaCommit) ||
    !commit(manifest.taxCommit) ||
    !Array.isArray(manifest.subjectIDs) ||
    manifest.subjectIDs.length === 0 ||
    manifest.subjectIDs.some((subjectID, index) =>
      typeof subjectID !== 'string' ||
      subjectID.length === 0 ||
      (index > 0 && manifest.subjectIDs[index - 1] >= subjectID)) ||
    fileKeys.some((key) =>
      typeof manifest.files?.[key] !== 'string' ||
      resolve(manifest.files[key]) !== manifest.files[key] ||
      dirname(manifest.files[key]) !== candidateDirectory ||
      !digest(manifest.fileDigests?.[key]))
  ) {
    throw new Error('Active Tax candidate manifest failed its runtime contract')
  }
  const reconstructedCandidateDigest = sha256(canonicalJSON({
    schemaVersion: 'giwa.tax-runtime-candidate-coordinates.v1',
    activationDigest: manifest.activationDigest,
    catalogDigest: manifest.catalogDigest,
    dbCommit: manifest.dbCommit,
    jitCommit: manifest.jitCommit,
    postingCommit: manifest.postingCommit,
    schemaCommit: manifest.schemaCommit,
    taxBackfillBinarySha256: manifest.taxBackfillBinarySha256,
    taxCommit: manifest.taxCommit,
    taxdBinarySha256: manifest.taxdBinarySha256,
    files: manifest.fileDigests,
  }))
  if (reconstructedCandidateDigest !== manifest.candidateDigest) {
    throw new Error('Active Tax candidate manifest digest does not match coordinates')
  }
  for (const key of fileKeys) {
    const metadata = lstatSync(manifest.files[key])
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== process.getuid()
    ) {
      throw new Error(`Active Tax candidate file is not owned: ${key}`)
    }
    const contents = readFileSync(manifest.files[key])
    if (sha256(contents) !== manifest.fileDigests[key]) {
      throw new Error(`Active Tax candidate file digest mismatch: ${key}`)
    }
  }
  if ((statSync(manifest.files.trustKey).mode & 0o777) !== 0o600) {
    throw new Error('Active Tax candidate trust key is not mode 0600')
  }
  if (
    sha256(readFileSync(join(binaryRoot, 'taxd'))) !==
      manifest.taxdBinarySha256 ||
    sha256(readFileSync(join(binaryRoot, 'tax-backfill'))) !==
      manifest.taxBackfillBinarySha256
  ) {
    throw new Error('Active Tax candidate binary digest does not match runtime')
  }
  return {
    files: manifest.files,
    subjectIDs: manifest.subjectIDs,
    subjectEpochs: state.subjectEpochs,
    activationDigest: manifest.activationDigest,
    candidateDigest: manifest.candidateDigest,
    manifestPath: state.runtimeManifestPath,
    schemaCommit: manifest.schemaCommit,
    jitCommit: manifest.jitCommit,
    dbCommit: manifest.dbCommit,
    postingCommit: manifest.postingCommit,
    taxCommit: manifest.taxCommit,
    catalogDigest: manifest.catalogDigest,
    taxBackfillBinarySha256: manifest.taxBackfillBinarySha256,
    taxdBinarySha256: manifest.taxdBinarySha256,
  }
}

export const hostTaxDBMigrationVersion = '73'

export const hostTaxQuoteRuntimeControls = (archiveOnly) => {
  if (typeof archiveOnly !== 'boolean') {
    throw new Error('Tax quote archive mode must be explicitly selected')
  }
  return {
    DAEJANG_TAXD_UPBIT_ARCHIVE_ONLY: String(archiveOnly),
    DAEJANG_TAXD_UPBIT_REQUEST_INTERVAL: '150ms',
    DAEJANG_TAXD_UPBIT_RATE_LIMIT_RETRIES: '3',
  }
}

const taxEnvironment = (
  taxURL,
  runtime,
  { archiveOnly },
) => serviceEnvironment([], [], {
  DAEJANG_DATABASE_URL: taxURL,
  DAEJANG_ARTIFACT_ROOT: join(artifactRoot, 'tax', 'root'),
  DAEJANG_ARTIFACT_TEMP: join(artifactRoot, 'tax', 'tmp'),
  DAEJANG_TAXD_INPUT_MODE: 'LEDGER_PUBLICATION',
  DAEJANG_TAXD_POLICY_FILE: runtime.files.policy,
  DAEJANG_TAXD_OWNERSHIP_FILE: runtime.files.ownership,
  DAEJANG_TAXD_ACTIVATION_SET_FILE: runtime.files.activation,
  DAEJANG_TAXD_ACTIVATION_SET_SHA256: runtime.activationDigest,
  DAEJANG_TAXD_DOWNSTREAM_PROFILE_FILE: runtime.files.profiles,
  DAEJANG_TAXD_UPBIT_QUOTE_CONFIG_FILE: runtime.files.quotes,
  DAEJANG_TAXD_QUOTE_ARCHIVE_ROOT: join(runtimeRoot, 'quote-archive', 'upbit'),
  ...hostTaxQuoteRuntimeControls(archiveOnly),
  DAEJANG_TAXD_PUBLICATION_POLICY_TRUST_KEY_FILE: runtime.files.trustKey,
  DAEJANG_TAXD_CANDIDATE_DIGEST: runtime.candidateDigest,
  DAEJANG_TAXD_CLAIM_CONTROL_DIR: join(stateRoot, 'tax-claim-control'),
  DAEJANG_TAXD_CLAIM_CONTROL_STATE_DIR:
    join(stateRoot, 'tax-claim-control-state'),
  DAEJANG_TAXD_CLAIM_RECEIPT_DIR: join(stateRoot, 'tax-claim-receipts'),
  DAEJANG_TAXD_PRODUCER_VERSION: runtime.taxCommit,
  DAEJANG_TAXD_SCHEMA_COMMIT: runtime.schemaCommit,
  DAEJANG_TAXD_JIT_COMMIT: runtime.jitCommit,
  DAEJANG_TAXD_DB_COMMIT: runtime.dbCommit,
  DAEJANG_TAXD_POSTING_COMMIT: runtime.postingCommit,
  DAEJANG_TAXD_DB_MIGRATION_VERSION: hostTaxDBMigrationVersion,
  DAEJANG_TAXD_TAX_COMMIT: runtime.taxCommit,
  DAEJANG_TAXD_CATALOG_SHA256: runtime.catalogDigest,
  DAEJANG_TAXD_HEALTH_ADDRESS: '127.0.0.1:8981',
  DAEJANG_TAXD_LOG_JSON: 'true',
})

export const hostTaxSimulationYears = Object.freeze([2025, 2026, 2027])

const normalizeTaxRuntimeYear = (taxYearInput, operation) => {
  const taxYear = String(taxYearInput)
  if (!/^[0-9]{4}$/.test(taxYear) || Number(taxYear) < 2025) {
    throw new Error(`${operation} tax year must be an integer from 2025 through 9999`)
  }
  return taxYear
}

export const taxQuotePrefetchArgs = (subjectID, taxYearInput = 2027) => {
  if (!subjectID) throw new Error('tax quote prefetch requires a subject ID')
  const taxYear = normalizeTaxRuntimeYear(taxYearInput, 'tax quote prefetch')
  return [
    '-subject', subjectID,
    '-tax-year', taxYear,
    '-apply',
    '-skip-rebuild',
  ]
}

export const taxSubjectRebuildArgs = (subjectID, taxYearInput) => {
  if (!subjectID) throw new Error('tax subject rebuild requires a subject ID')
  const taxYear = normalizeTaxRuntimeYear(taxYearInput, 'tax subject rebuild')
  return [
    '-subject', subjectID,
    '-tax-year', taxYear,
    '-apply',
  ]
}

export const validateTaxQuotePrefetchResult = (
  raw,
  subjectID,
  taxYear = 2027,
) => {
  let result
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error('Tax quote prefetch returned invalid JSON')
  }
  const nonnegativeInteger = (value) =>
    Number.isSafeInteger(value) && value >= 0
  if (
    result.schemaVersion !== 'tax.valuation-backfill-result.v1' ||
    result.subjectId !== subjectID ||
    result.taxYear !== taxYear ||
    result.dryRun !== false ||
    result.rebuiltLot !== false ||
    result.rebuiltTax !== false ||
    result.rebuiltReport !== false ||
    !nonnegativeInteger(result.archiveCoverageEvents) ||
    !nonnegativeInteger(result.archiveCoverageLegs) ||
    !nonnegativeInteger(result.persistedValuations)
  ) {
    throw new Error('Tax quote prefetch result failed its runtime contract')
  }
  return {
    archiveCoverageEvents: result.archiveCoverageEvents,
    archiveCoverageLegs: result.archiveCoverageLegs,
    persistedValuations: result.persistedValuations,
  }
}

export const validateTaxSubjectRebuildResult = (
  raw,
  subjectID,
  taxYear,
) => {
  let result
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error('Tax subject rebuild returned invalid JSON')
  }
  const nonnegativeInteger = (value) =>
    Number.isSafeInteger(value) && value >= 0
  const hasExactReport = result.rebuiltReport === true &&
    typeof result.reportId === 'string' && result.reportId.trim().length > 0 &&
    Number.isSafeInteger(result.reportPointerVersion) &&
    result.reportPointerVersion > 0
  const hasNoReportIdentity = result.rebuiltReport === false &&
    result.reportId === undefined &&
    result.reportPointerVersion === undefined
  if (
    result.schemaVersion !== 'tax.valuation-backfill-result.v1' ||
    result.subjectId !== subjectID ||
    result.taxYear !== taxYear ||
    result.dryRun !== false ||
    result.rebuiltLot !== true ||
    typeof result.rebuiltTax !== 'boolean' ||
    typeof result.rebuiltReport !== 'boolean' ||
    result.rebuiltTax !== result.rebuiltReport ||
    !(hasExactReport || hasNoReportIdentity) ||
    !nonnegativeInteger(result.persistedValuations)
  ) {
    throw new Error('Tax subject rebuild result failed its runtime contract')
  }
  return {
    persistedValuations: result.persistedValuations,
    rebuiltLot: result.rebuiltLot,
    rebuiltTax: result.rebuiltTax,
    rebuiltReport: result.rebuiltReport,
    report: hasExactReport
      ? { reportId: result.reportId, pointerVersion: result.reportPointerVersion }
      : null,
  }
}

export const hostTaxProfileStabilityPasses = 3
export const hostTaxProfileRefreshIntervalMs = 30_000
export const hostTaxProfileRefreshRetryMs = 60_000

export const currentTaxProfileEpochRowsQuery = `
  SELECT
    subject_id,
    encode(
      sha256(
        convert_to(
          jsonb_agg(
            jsonb_build_array(event_id, current_revision_id, pointer_version)
            ORDER BY event_id
          )::text,
          'UTF8'
        )
      ),
      'hex'
    ) AS ledger_epoch
  FROM ledger.interpreted_event
  WHERE current_revision_id IS NOT NULL
  GROUP BY subject_id
  ORDER BY subject_id
`

export const currentTaxReportGenerationRowsQuery = `
  SELECT
    current.subject_id,
    current.generation_id,
    generation.candidate_digest,
    generation.ledger_fingerprint,
    generation.state,
    current.pointer_version::text,
    (
      SELECT count(*) = 3 AND bool_and(
        annual.outcome = 'NO_TAX_EVENTS'
        OR annual.outcome = 'REPORT' AND EXISTS (
          SELECT 1
          FROM reporting.current_tax_report AS report_pointer
          WHERE report_pointer.subject_id = annual.subject_id
            AND report_pointer.tax_year = annual.tax_year
            AND report_pointer.finality = annual.finality
            AND report_pointer.report_id = annual.report_id
            AND report_pointer.pointer_version = annual.report_pointer_version
        )
      )
      FROM reporting.tax_report_generation_year AS annual
      WHERE annual.subject_id = current.subject_id
        AND annual.generation_id = current.generation_id
        AND annual.tax_year IN (2025, 2026, 2027)
        AND annual.finality = 'FINAL'
    ) AS annual_results_current
  FROM reporting.current_tax_report_generation AS current
  JOIN reporting.tax_report_generation AS generation
    ON generation.subject_id = current.subject_id
   AND generation.generation_id = current.generation_id
  ORDER BY current.subject_id
`

export const currentTaxReportGenerationEligibilityRowsQuery = `
  SELECT
    subject_id,
    eligibility_status
  FROM reporting.tax_report_generation_eligibility_read_v1
  ORDER BY subject_id
`

export const normalizeTaxSubjectEpochs = (rows) => rows.map((row, index) => {
  if (
    typeof row.subject_id !== 'string' ||
    row.subject_id.length === 0 ||
    typeof row.ledger_epoch !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.ledger_epoch) ||
    (index > 0 && rows[index - 1].subject_id >= row.subject_id)
  ) {
    throw new Error('Tax profile subject epochs are incomplete or unsorted')
  }
  return { subjectId: row.subject_id, ledgerEpoch: row.ledger_epoch }
})

export const normalizeTaxReportGenerationPointers = (rows) =>
  rows.map((row, index) => {
    if (
      typeof row.subject_id !== 'string' || row.subject_id.length === 0 ||
      typeof row.generation_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.generation_id) ||
      typeof row.candidate_digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.candidate_digest) ||
      typeof row.ledger_fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.ledger_fingerprint) ||
      !['BUILDING', 'ACTIVE', 'RETIRED', 'SUPERSEDED'].includes(row.state) ||
      typeof row.pointer_version !== 'string' ||
      !/^[1-9][0-9]*$/.test(row.pointer_version) ||
      BigInt(row.pointer_version) > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof row.annual_results_current !== 'boolean' ||
      (index > 0 && rows[index - 1].subject_id >= row.subject_id)
    ) {
      throw new Error('Tax report generation pointers are incomplete or unsorted')
    }
    return {
      subjectId: row.subject_id,
      generationId: row.generation_id,
      candidateDigest: row.candidate_digest,
      ledgerFingerprint: row.ledger_fingerprint,
      state: row.state,
      pointerVersion: Number(row.pointer_version),
      annualResultsCurrent: row.annual_results_current,
    }
  })

export const normalizeTaxReportGenerationEligibility = (rows) =>
  rows.map((row, index) => {
    if (
      typeof row.subject_id !== 'string' || row.subject_id.length === 0 ||
      !['ELIGIBLE', 'APPLICATION_PENDING'].includes(row.eligibility_status) ||
      (index > 0 && rows[index - 1].subject_id >= row.subject_id)
    ) {
      throw new Error(
        'Tax report generation eligibility is incomplete or unsorted',
      )
    }
    return {
      subjectId: row.subject_id,
      eligibilityStatus: row.eligibility_status,
    }
  })

export const eligibleTaxReportGenerationSubjectIDs = (
  eligibility,
  runtimeSubjectIDs,
  requestedSubjectIDs = runtimeSubjectIDs,
) => {
  const runtimeSubjects = new Set(runtimeSubjectIDs ?? [])
  const eligibilityBySubject = new Map(
    (eligibility ?? []).map(({ subjectId, eligibilityStatus }) =>
      [subjectId, eligibilityStatus]),
  )
  for (const subjectID of runtimeSubjects) {
    if (!eligibilityBySubject.has(subjectID)) {
      throw new Error(
        `Tax report generation eligibility is missing for ${subjectID}`,
      )
    }
  }
  const requested = [...new Set(requestedSubjectIDs ?? [])]
  if (requested.some((subjectID) => !runtimeSubjects.has(subjectID))) {
    throw new Error(
      'Tax report generation eligibility subject is outside the candidate runtime',
    )
  }
  return requested
    .filter((subjectID) =>
      eligibilityBySubject.get(subjectID) === 'ELIGIBLE')
    .sort()
}

export const runTaxReportGenerationSubjectMutations = async (
  subjectIDs,
  mutate,
) => {
  const results = new Map()
  for (const subjectID of [...new Set(subjectIDs ?? [])].sort()) {
    const result = await mutate(subjectID)
    if (result !== undefined) results.set(subjectID, result)
  }
  return results
}

export const retiredTaxGenerationSubjectIDs = (
  generationPointers,
  profileSubjectIDs,
) => {
  const profiles = new Set(profileSubjectIDs ?? [])
  return (generationPointers ?? [])
    .filter(({ subjectId, state }) => state !== 'RETIRED' && !profiles.has(subjectId))
    .map(({ subjectId }) => subjectId)
    .sort()
}

export const taxReportGenerationRetrySubjectIDs = (
  pendingSubjectIDs,
  currentSubjectIDs,
) => [...new Set([
  ...(pendingSubjectIDs ?? []),
  ...(currentSubjectIDs ?? []),
])].sort()

export const taxReportGenerationRebuildSubjectIDs = (
  generationPointers,
  runtime,
  requestedSubjectIDs = runtime?.subjectIDs ?? [],
) => {
  const pointers = new Map(
    (generationPointers ?? []).map((pointer) => [pointer.subjectId, pointer]),
  )
  const epochs = new Map(
    (runtime?.subjectEpochs ?? []).map(({ subjectId, ledgerEpoch }) =>
      [subjectId, ledgerEpoch]),
  )
  return [...new Set(requestedSubjectIDs ?? [])]
    .filter((subjectID) => {
      const pointer = pointers.get(subjectID)
      return pointer?.state !== 'ACTIVE' ||
        pointer.candidateDigest !== runtime?.candidateDigest ||
        pointer.ledgerFingerprint !== epochs.get(subjectID) ||
        !pointer.annualResultsCurrent
    })
    .sort()
}

export const changedTaxSubjectIDs = (
  previousEpochs,
  nextEpochs,
  nextProfileSubjectIDs,
) => {
  const previous = new Map(
    (previousEpochs ?? []).map(({ subjectId, ledgerEpoch }) =>
      [subjectId, ledgerEpoch]),
  )
  const current = new Map(
    (nextEpochs ?? []).map(({ subjectId, ledgerEpoch }) =>
      [subjectId, ledgerEpoch]),
  )
  return [...new Set(nextProfileSubjectIDs ?? [])]
    .filter((subjectID) => previous.get(subjectID) !== current.get(subjectID))
    .sort()
}

export const taxProfileSnapshotStable = (before, after) =>
  typeof before?.candidateDigest === 'string' &&
  before.candidateDigest.length > 0 &&
  before.candidateDigest === after?.candidateDigest &&
  canonicalJSON(before.subjectEpochs) === canonicalJSON(after?.subjectEpochs)

export const taxProfileRefreshNeeded = (
  state,
  subjectEpochs,
  now = Date.now(),
) => {
  const epochs = subjectEpochs ?? []
  if (state === null || state === undefined) return true
  if (state.status === 'NO_PROFILES') {
    return canonicalJSON(state.subjectEpochs ?? []) !== canonicalJSON(epochs)
  }
  if (state.status === 'ACTIVE') {
    return canonicalJSON(state.subjectEpochs ?? []) !==
      canonicalJSON(epochs)
  }
  if (state.status !== 'FAILED') return true
  const retryAt = Date.parse(state.retryAt ?? '')
  return !Number.isFinite(retryAt) || now >= retryAt
}

export const planTaxProfileReconcile = ({
  state,
  subjectEpochs,
  taxdRunning,
  taxdReady,
  now = Date.now(),
}) => {
  if (taxProfileRefreshNeeded(state, subjectEpochs, now)) {
    return 'REFRESH_PROFILES'
  }
  if (state?.status === 'ACTIVE' && (!taxdRunning || !taxdReady)) {
    return 'RESTART_TAXD'
  }
  return 'NONE'
}

export const planTaxProfileActivation = ({ state, runtime, action }) => {
  const candidateChanged = state?.candidateDigest !== runtime.candidateDigest
  const changedSubjectIDs = changedTaxSubjectIDs(
    state?.subjectEpochs ?? [],
    runtime.subjectEpochs,
    runtime.subjectIDs,
  )
  const retryingSameCandidate = ['ACTIVATING', 'FAILED'].includes(state?.status) &&
    state.candidateDigest === runtime.candidateDigest
  return {
    candidateChanged,
    prefetch: retryingSameCandidate
      ? state.prefetchRequired
      : action === 'REFRESH_PROFILES',
    subjectIDs: retryingSameCandidate
      ? state.affectedSubjectIDs.filter((subjectID) =>
        runtime.subjectIDs.includes(subjectID))
      : state?.status === 'ACTIVE'
        ? candidateChanged
          ? runtime.subjectIDs
          : changedSubjectIDs
        : runtime.subjectIDs,
  }
}

const readTaxSubjectEpochs = async (queryURL) => {
  const client = new Client({ connectionString: queryURL })
  await client.connect()
  try {
    const result = await client.query(currentTaxProfileEpochRowsQuery)
    return normalizeTaxSubjectEpochs(result.rows)
  } finally {
    await client.end()
  }
}

const readTaxReportGenerationPointers = async (client) => {
  const result = await client.query(currentTaxReportGenerationRowsQuery)
  return normalizeTaxReportGenerationPointers(result.rows)
}

const readTaxReportGenerationEligibility = async (client) => {
  const result = await client.query(
    currentTaxReportGenerationEligibilityRowsQuery,
  )
  return normalizeTaxReportGenerationEligibility(result.rows)
}

const filterTaxReportGenerationEligibleSubjects = async (
  taxURL,
  runtime,
  subjectIDs,
) => {
  const client = new Client({ connectionString: taxURL })
  await client.connect()
  try {
    return eligibleTaxReportGenerationSubjectIDs(
      await readTaxReportGenerationEligibility(client),
      runtime.subjectIDs,
      subjectIDs,
    )
  } finally {
    await client.end()
  }
}

const filterTaxReportGenerationRebuildSubjects = async (
  taxURL,
  runtime,
  subjectIDs,
) => {
  const client = new Client({ connectionString: taxURL })
  await client.connect()
  try {
    const eligibleSubjectIDs = eligibleTaxReportGenerationSubjectIDs(
      await readTaxReportGenerationEligibility(client),
      runtime.subjectIDs,
      subjectIDs,
    )
    return taxReportGenerationRebuildSubjectIDs(
      await readTaxReportGenerationPointers(client),
      runtime,
      eligibleSubjectIDs,
    )
  } finally {
    await client.end()
  }
}

const normalizeTaxReportGenerationMutation = (row, expectedState) => {
  if (
    typeof row?.generation_id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.generation_id) ||
    typeof row?.pointer_version !== 'string' ||
    !/^[1-9][0-9]*$/.test(row.pointer_version) ||
    BigInt(row.pointer_version) > BigInt(Number.MAX_SAFE_INTEGER) ||
    row?.state !== expectedState
  ) {
    throw new Error(`Tax report generation ${expectedState} result is invalid`)
  }
  return {
    generationId: row.generation_id,
    pointerVersion: Number(row.pointer_version),
    state: row.state,
  }
}

const withTaxReportGenerationTransaction = async (taxURL, operation) => {
  const client = new Client({ connectionString: taxURL })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

const retireMissingTaxReportGenerations = async (taxURL, runtime) =>
  withTaxReportGenerationTransaction(taxURL, async (client) => {
    const pointers = await readTaxReportGenerationPointers(client)
    const retiredSubjectIDs = retiredTaxGenerationSubjectIDs(
      pointers,
      runtime.subjectIDs,
    )
    const pointerBySubject = new Map(
      pointers.map((pointer) => [pointer.subjectId, pointer]),
    )
    const epochBySubject = new Map(
      runtime.subjectEpochs.map(({ subjectId, ledgerEpoch }) =>
        [subjectId, ledgerEpoch]),
    )
    for (const subjectID of retiredSubjectIDs) {
      const pointer = pointerBySubject.get(subjectID)
      const candidateDigest = runtime.candidateDigest ?? pointer.candidateDigest
      const result = await client.query(
        `
          SELECT generation_id,pointer_version::text,state
          FROM reporting.retire_tax_report_generation_v1($1,$2,$3,$4,$5)
        `,
        [
          subjectID,
          candidateDigest,
          epochBySubject.get(subjectID) ?? null,
          pointer.generationId,
          pointer.pointerVersion,
        ],
      )
      normalizeTaxReportGenerationMutation(result.rows[0], 'RETIRED')
    }
    return retiredSubjectIDs
  })

const beginTaxReportGenerations = async (taxURL, runtime, subjectIDs) => {
  const epochBySubject = new Map(
    runtime.subjectEpochs.map(({ subjectId, ledgerEpoch }) =>
      [subjectId, ledgerEpoch]),
  )
  return runTaxReportGenerationSubjectMutations(
    subjectIDs,
    (subjectID) => withTaxReportGenerationTransaction(
      taxURL,
      async (client) => {
        const eligibleSubjectIDs = eligibleTaxReportGenerationSubjectIDs(
          await readTaxReportGenerationEligibility(client),
          runtime.subjectIDs,
          [subjectID],
        )
        if (eligibleSubjectIDs.length === 0) return undefined
        if (!runtime.subjectIDs.includes(subjectID)) {
          throw new Error(
            'Tax report generation subject is outside the candidate runtime',
          )
        }
        const ledgerFingerprint = epochBySubject.get(subjectID)
        if (!ledgerFingerprint) {
          throw new Error(
            'Tax report generation subject has no ledger fingerprint',
          )
        }
        const pointers = await readTaxReportGenerationPointers(client)
        const pointerBySubject = new Map(
          pointers.map((pointer) => [pointer.subjectId, pointer]),
        )
        const current = pointerBySubject.get(subjectID)
        const mutation = await client.query(
          `
            SELECT generation_id,pointer_version::text,state
            FROM reporting.begin_tax_report_generation_v1($1,$2,$3,$4,$5)
          `,
          [
            subjectID,
            runtime.candidateDigest,
            ledgerFingerprint,
            current?.generationId ?? null,
            current?.pointerVersion ?? 0,
          ],
        )
        const normalized = normalizeTaxReportGenerationMutation(
          mutation.rows[0],
          'BUILDING',
        )
        return {
          ...normalized,
          candidateDigest: runtime.candidateDigest,
          ledgerFingerprint,
        }
      },
    ),
  )
}

const activateTaxReportGenerations = async (
  taxURL,
  runtime,
  pendingGenerations,
) => runTaxReportGenerationSubjectMutations(
  pendingGenerations.keys(),
  (subjectID) => withTaxReportGenerationTransaction(taxURL, async (client) => {
    const eligibleSubjectIDs = eligibleTaxReportGenerationSubjectIDs(
      await readTaxReportGenerationEligibility(client),
      runtime.subjectIDs,
      [subjectID],
    )
    if (eligibleSubjectIDs.length === 0) return undefined
    const pending = pendingGenerations.get(subjectID)
    if (
      pending.candidateDigest !== runtime.candidateDigest ||
      runtime.subjectEpochs.find(({ subjectId }) => subjectId === subjectID)
        ?.ledgerEpoch !== pending.ledgerFingerprint
    ) {
      throw new Error('Tax report generation activation snapshot is stale')
    }
    const outcomes = new Map(
      pending.outcomes.map(({ taxYear, report }) => [taxYear, report]),
    )
    if (
      outcomes.size !== hostTaxSimulationYears.length ||
      hostTaxSimulationYears.some((taxYear) =>
        outcomes.get(taxYear) !== null && (
          typeof outcomes.get(taxYear)?.reportId !== 'string' ||
          outcomes.get(taxYear).reportId.trim().length === 0 ||
          !Number.isSafeInteger(outcomes.get(taxYear)?.pointerVersion) ||
          outcomes.get(taxYear).pointerVersion < 1
        ))
    ) {
      throw new Error('Tax report generation is missing an annual outcome')
    }
    const mutation = await client.query(
      `
        SELECT generation_id,pointer_version::text,state
        FROM reporting.activate_tax_report_generation_v1(
          $1,$2,$3,$4,$5,$6,$7,$8,$9
        )
      `,
      [
        subjectID,
        pending.generationId,
        pending.pointerVersion,
        outcomes.get(2025)?.reportId ?? null,
        outcomes.get(2025)?.pointerVersion ?? null,
        outcomes.get(2026)?.reportId ?? null,
        outcomes.get(2026)?.pointerVersion ?? null,
        outcomes.get(2027)?.reportId ?? null,
        outcomes.get(2027)?.pointerVersion ?? null,
      ],
    )
    normalizeTaxReportGenerationMutation(mutation.rows[0], 'ACTIVE')
    return true
  }),
)

const readTaxdProfileState = () => {
  try {
    const state = JSON.parse(readFileSync(taxdProfileStateFile, 'utf8'))
    if (
      state?.schemaVersion !== 'giwa.taxd-profile-state.v2' ||
      !['ACTIVE', 'ACTIVATING', 'FAILED', 'NO_PROFILES'].includes(state.status) ||
      (state.candidateDigest !== null &&
        !/^[0-9a-f]{64}$/.test(state.candidateDigest)) ||
      (state.runtimeManifestPath !== null &&
        (typeof state.runtimeManifestPath !== 'string' ||
          !isAbsolute(state.runtimeManifestPath) ||
          resolve(state.runtimeManifestPath) !== state.runtimeManifestPath ||
          !pathIsWithin(taxCandidateRoot, state.runtimeManifestPath))) ||
      (['ACTIVE', 'ACTIVATING'].includes(state.status) &&
        (state.candidateDigest === null || state.runtimeManifestPath === null)) ||
      (state.status === 'NO_PROFILES' &&
        (state.candidateDigest !== null || state.runtimeManifestPath !== null)) ||
      typeof state.prefetchRequired !== 'boolean' ||
      !Array.isArray(state.affectedSubjectIDs) ||
      state.affectedSubjectIDs.some((subjectID, index) =>
        typeof subjectID !== 'string' ||
        subjectID.length === 0 ||
        (index > 0 && state.affectedSubjectIDs[index - 1] >= subjectID)) ||
      (!['ACTIVATING', 'FAILED'].includes(state.status) &&
        (state.prefetchRequired || state.affectedSubjectIDs.length > 0)) ||
      !Array.isArray(state.subjectEpochs) ||
      state.subjectEpochs.some((epoch, index) =>
        typeof epoch?.subjectId !== 'string' ||
        epoch.subjectId.length === 0 ||
        typeof epoch.ledgerEpoch !== 'string' ||
        !/^[0-9a-f]{64}$/.test(epoch.ledgerEpoch) ||
        (index > 0 &&
          state.subjectEpochs[index - 1].subjectId >= epoch.subjectId)) ||
      typeof state.updatedAt !== 'string' ||
      (state.reason !== undefined && typeof state.reason !== 'string') ||
      (state.retryAt !== undefined &&
        !Number.isFinite(Date.parse(state.retryAt)))
    ) return null
    return state
  } catch {
    return null
  }
}

const writeTaxdProfileState = ({
  status,
  candidateDigest = null,
  runtimeManifestPath = null,
  subjectEpochs = [],
  prefetchRequired = false,
  affectedSubjectIDs = [],
  reason = null,
  retryAt = null,
  now = new Date(),
}) => {
  const state = {
    schemaVersion: 'giwa.taxd-profile-state.v2',
    status,
    candidateDigest,
    runtimeManifestPath,
    prefetchRequired,
    affectedSubjectIDs,
    subjectEpochs,
    updatedAt: now.toISOString(),
  }
  if (reason !== null) state.reason = reason
  if (retryAt !== null) state.retryAt = retryAt.toISOString()
  writeRuntimeFileAtomically(
    taxdProfileStateFile,
    `${canonicalJSON(state)}\n`,
  )
  rmSync(taxdLegacyNoProfilesMarker, { force: true })
  return state
}

const markTaxdDisabled = ({
  reason,
  status,
  candidateDigest = null,
  runtimeManifestPath = null,
  subjectEpochs = [],
  prefetchRequired = false,
  affectedSubjectIDs = [],
  retry = false,
}) => {
  const now = new Date()
  writeTaxdProfileState({
    status,
    candidateDigest,
    runtimeManifestPath,
    prefetchRequired,
    affectedSubjectIDs,
    subjectEpochs,
    reason,
    retryAt: retry
      ? new Date(now.getTime() + hostTaxProfileRefreshRetryMs)
      : null,
    now,
  })
}

const prefetchTaxQuotes = (
  taxURL,
  runtime,
  subjectIDs = runtime.subjectIDs,
) => {
  const totals = {
    subjects: 0,
    archiveCoverageEvents: 0,
    archiveCoverageLegs: 0,
    persistedValuations: 0,
    annualRebuilds: 0,
    annualReports: 0,
    subjectOutcomes: [],
  }
  const runBackfill = (args, label) => {
    const result = spawnSync(
      join(binaryRoot, 'tax-backfill'),
      args,
      {
        cwd: taxRepository,
        env: taxEnvironment(taxURL, runtime, { archiveOnly: false }),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    if (result.status !== 0) {
      const reason = result.error?.message ??
        (result.signal ? `signal ${result.signal}` : `status ${result.status}`)
      throw new Error(`${label} failed with ${reason}`)
    }
    return result.stdout
  }
  for (const [index, subjectID] of subjectIDs.entries()) {
    try {
      const summary = validateTaxQuotePrefetchResult(
        runBackfill(
          taxQuotePrefetchArgs(subjectID),
          `Tax quote prefetch at subject ${index + 1}/${subjectIDs.length}`,
        ),
        subjectID,
      )
      totals.subjects++
      totals.archiveCoverageEvents += summary.archiveCoverageEvents
      totals.archiveCoverageLegs += summary.archiveCoverageLegs
      totals.persistedValuations += summary.persistedValuations
      const outcomes = []
      for (const taxYear of hostTaxSimulationYears) {
        const rebuilt = validateTaxSubjectRebuildResult(
          runBackfill(
            taxSubjectRebuildArgs(subjectID, taxYear),
            `Tax annual rebuild ${taxYear} at subject ${index + 1}/${subjectIDs.length}`,
          ),
          subjectID,
          taxYear,
        )
        totals.persistedValuations += rebuilt.persistedValuations
        totals.annualRebuilds++
        if (rebuilt.rebuiltReport) totals.annualReports++
        outcomes.push({ taxYear, report: rebuilt.report })
      }
      totals.subjectOutcomes.push({ subjectID, outcomes })
    } catch (error) {
      error.taxRuntime = runtime
      error.taxSubjectIDs = subjectIDs.slice(index)
      throw error
    }
  }
  console.log(
    `Tax quote archive coverage and annual rebuild verified: subjects=${totals.subjects} events=${totals.archiveCoverageEvents} legs=${totals.archiveCoverageLegs} persistedValuations=${totals.persistedValuations} annualRebuilds=${totals.annualRebuilds} annualReports=${totals.annualReports}`,
  )
  return totals
}

const prepareStableTaxRuntime = async (
  queryURL,
  taxURL,
  initialRuntime,
  initialSubjectIDs = initialRuntime.subjectIDs,
) => {
  let runtime = initialRuntime
  let subjectIDs = await filterTaxReportGenerationRebuildSubjects(
    taxURL,
    initialRuntime,
    initialSubjectIDs,
  )
  if (subjectIDs.length === 0) return runtime
  const pendingGenerations = new Map()
  const retrySubjectIDs = () => taxReportGenerationRetrySubjectIDs(
    pendingGenerations.keys(),
    subjectIDs,
  )
  for (let pass = 1; pass <= hostTaxProfileStabilityPasses; pass++) {
    writeTaxdProfileState({
      status: 'ACTIVATING',
      candidateDigest: runtime.candidateDigest,
      runtimeManifestPath: runtime.manifestPath,
      subjectEpochs: runtime.subjectEpochs,
      prefetchRequired: true,
      affectedSubjectIDs: retrySubjectIDs(),
    })
    const begun = await beginTaxReportGenerations(taxURL, runtime, subjectIDs)
    subjectIDs = [...begun.keys()].sort()
    if (subjectIDs.length === 0 && pendingGenerations.size === 0) {
      return runtime
    }
    let rebuilt
    try {
      rebuilt = prefetchTaxQuotes(taxURL, runtime, subjectIDs)
    } catch (error) {
      error.taxRuntime = runtime
      error.taxSubjectIDs = retrySubjectIDs()
      throw error
    }
    for (const { subjectID, outcomes } of rebuilt.subjectOutcomes) {
      const generation = begun.get(subjectID)
      if (!generation) {
        throw new Error('Tax annual rebuild has no BUILDING generation')
      }
      pendingGenerations.set(subjectID, { ...generation, outcomes })
    }
    let refreshedRuntime
    try {
      refreshedRuntime = await createTaxRuntime(queryURL)
    } catch (error) {
      error.taxRuntime = runtime
      error.taxSubjectIDs = retrySubjectIDs()
      throw error
    }
    if (!taxRuntimeHasProfiles(refreshedRuntime)) {
      await retireMissingTaxReportGenerations(taxURL, refreshedRuntime)
      const error = new Error(
        'Tax profile snapshot disappeared during quote prefetch',
      )
      error.taxRuntime = runtime
      error.taxSubjectIDs = runtime.subjectIDs
      throw error
    }
    if (taxProfileSnapshotStable(runtime, refreshedRuntime)) {
      try {
        await activateTaxReportGenerations(
          taxURL,
          refreshedRuntime,
          pendingGenerations,
        )
      } catch (error) {
        error.taxRuntime = refreshedRuntime
        error.taxSubjectIDs = retrySubjectIDs()
        throw error
      }
      return refreshedRuntime
    }
    try {
      await retireMissingTaxReportGenerations(taxURL, refreshedRuntime)
    } catch (error) {
      error.taxRuntime = refreshedRuntime
      error.taxSubjectIDs = retrySubjectIDs()
      throw error
    }
    for (const [subjectID, pending] of pendingGenerations) {
      const refreshedEpoch = refreshedRuntime.subjectEpochs.find(
        ({ subjectId }) => subjectId === subjectID,
      )?.ledgerEpoch
      if (
        pending.candidateDigest !== refreshedRuntime.candidateDigest ||
        pending.ledgerFingerprint !== refreshedEpoch ||
        !refreshedRuntime.subjectIDs.includes(subjectID)
      ) {
        pendingGenerations.delete(subjectID)
      }
    }
    subjectIDs = changedTaxSubjectIDs(
      runtime.subjectEpochs,
      refreshedRuntime.subjectEpochs,
      refreshedRuntime.subjectIDs,
    )
    if (
      runtime.candidateDigest !== refreshedRuntime.candidateDigest
    ) {
      subjectIDs = refreshedRuntime.subjectIDs
    }
    runtime = refreshedRuntime
    subjectIDs = await filterTaxReportGenerationRebuildSubjects(
      taxURL,
      runtime,
      subjectIDs,
    )
  }
  const error = new Error(
    `Tax profile snapshot did not stabilize after ${hostTaxProfileStabilityPasses} quote-prefetch passes`,
  )
  error.taxRuntime = runtime
  error.taxSubjectIDs = retrySubjectIDs()
  throw error
}

const startTaxdRuntime = async (taxURL, runtime) => {
  if (isRunning('taxd')) {
    throw new Error('Tax profile activation requires taxd to be stopped')
  }
  const taxdEnvironment = taxEnvironment(
    taxURL,
    runtime,
    { archiveOnly: false },
  )
  spawnService(
    'taxd',
    join(binaryRoot, 'taxd'),
    [],
    taxdEnvironment,
    { cwd: taxRepository },
  )
  await waitFor(
    'Tax Engine candidate',
    () => isRunning('taxd') && taxRuntimeReady(runtime.candidateDigest),
    30_000,
  )
  writeTaxdProfileState({
    status: 'ACTIVE',
    candidateDigest: runtime.candidateDigest,
    runtimeManifestPath: runtime.manifestPath,
    subjectEpochs: runtime.subjectEpochs,
  })
  try {
    const removed = pruneTaxCandidateDirectories({
      root: taxCandidateRoot,
      activeDigest: runtime.candidateDigest,
    })
    if (removed.length > 0) {
      console.log(`Pruned ${removed.length} inactive Tax runtime candidates`)
    }
  } catch (error) {
    console.warn(`Tax candidate pruning skipped: ${error.message}`)
  }
}

const activateTaxRuntime = async (
  queryURL,
  taxURL,
  initialRuntime,
  { prefetch, subjectIDs = initialRuntime.subjectIDs },
) => {
  let runtime = initialRuntime
  let activationSubjectIDs = []
  try {
    if (typeof prefetch !== 'boolean') {
      throw new Error('Tax profile activation requires an explicit prefetch mode')
    }
    if (!taxRuntimeHasProfiles(runtime)) {
      throw new Error('Tax profile activation requires a non-empty runtime')
    }
    activationSubjectIDs = [...new Set(subjectIDs)].sort()
    if (activationSubjectIDs.some((subjectID) =>
      typeof subjectID !== 'string' ||
      !runtime.subjectIDs.includes(subjectID))) {
      throw new Error('Tax profile activation subjects are outside the candidate runtime')
    }
    if (prefetch) {
      activationSubjectIDs = await filterTaxReportGenerationEligibleSubjects(
        taxURL,
        runtime,
        activationSubjectIDs,
      )
    }
    writeTaxdProfileState({
      status: 'ACTIVATING',
      candidateDigest: runtime.candidateDigest,
      runtimeManifestPath: runtime.manifestPath,
      subjectEpochs: runtime.subjectEpochs,
      prefetchRequired: prefetch,
      affectedSubjectIDs: prefetch ? activationSubjectIDs : [],
    })
    if (isRunning('taxd')) await stopService('taxd')
    if (prefetch) {
      runtime = await prepareStableTaxRuntime(
        queryURL,
        taxURL,
        runtime,
        activationSubjectIDs,
      )
    }
    await startTaxdRuntime(taxURL, runtime)
    return true
  } catch (error) {
    runtime = error.taxRuntime ?? runtime
    const failedSubjectIDs = error.taxSubjectIDs ?? activationSubjectIDs
    if (isRunning('taxd')) await stopService('taxd')
    markTaxdDisabled({
      reason: 'Tax profile activation, quote archive coverage, or annual rebuild did not complete. The supervisor will retry after the bounded cooldown.',
      status: 'FAILED',
      candidateDigest: runtime?.candidateDigest ?? null,
      runtimeManifestPath: runtime?.manifestPath ?? null,
      subjectEpochs: runtime?.subjectEpochs ?? [],
      prefetchRequired: prefetch,
      affectedSubjectIDs: prefetch ? [...failedSubjectIDs].sort() : [],
      retry: true,
    })
    console.error(`Tax Engine remains disabled: ${error.message}`)
    return false
  }
}

const startServices = async ({ buildArtifacts = true } = {}) => {
  if (allServiceOrder.some(isRunning))
    throw new Error('Backend services are already running; use backend:restart')
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  // JIT evaluates profiles from this checkout while the canonical Posting
  // worker independently verifies their runtime coordinate. Pin both services
  // to the same clean revision on every start, including prebuilt restarts.
  assertCleanRuntimeCheckouts()
  const actionRuntimeRelease = loadVerifiedActionRuntimeRelease(deFiLabelRepository)
  if (buildArtifacts) build()
  for (const requiredArtifact of [
    jitBinary,
    join(binaryRoot, 'engine-api'),
    join(binaryRoot, 'engine-healthcheck'),
    join(binaryRoot, 'sync-worker'),
    join(binaryRoot, 'posting-worker'),
    join(binaryRoot, 'taxd'),
    join(binaryRoot, 'tax-backfill'),
    join(binaryRoot, 'upbit-candle-sync'),
    upbitCandleCollectorQuoteConfigFile,
    taxBinaryReleaseManifestFile,
    join(binaryRoot, 'evm-posting-worker'),
    join(runtimeRoot, 'app', 'web-api', 'server.js'),
  ]) {
    if (!existsSync(requiredArtifact)) {
      throw new Error(`Prebuilt backend artifact is missing: ${requiredArtifact}`)
    }
  }
  if (buildArtifacts) {
    await restartUpbitCandleCollector()
  } else {
    ensureUpbitCandleCollectorRunning()
  }
  loadRuntimeEnvironment()

  try {
    run('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: databaseRepository,
    })
    await waitFor('PostgreSQL', () => tcpReady(55432), 30_000)
    const parserSocket = join(socketRoot, 'pdf-parser.sock')
    const jitSocket = join(socketRoot, 'jit.sock')
    const engineSocket = join(socketRoot, 'engine.sock')
    rmSync(parserSocket, { force: true })
    rmSync(jitSocket, { force: true })
    rmSync(engineSocket, { force: true })

    spawnService(
      'pdf-parser',
      process.env.GIWA_PDF_PARSER_PYTHON ??
        (existsSync(join(repositoryRoot, 'services', 'engine', '.venv-pdf-parser', 'bin', 'python'))
          ? join(repositoryRoot, 'services', 'engine', '.venv-pdf-parser', 'bin', 'python')
          : join(projectRoot, 'daejang', 'services', 'engine', '.venv-pdf-parser', 'bin', 'python')),
      [
        '-I',
        '-B',
        join(
          repositoryRoot,
          'services',
          'engine',
          'python',
          'pdf_parser_server.py',
        ),
        '--socket',
        parserSocket,
        '--request-timeout-seconds',
        '25',
      ],
      {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
      },
    )
    await waitFor('PDF parser', parserReady)

    const sourceURL = databaseURL(
      'daejang_source_app',
      process.env.DAEJANG_SOURCE_APP_PASSWORD,
    )
    const queryURL = databaseURL(
      'daejang_query_app',
      process.env.DAEJANG_QUERY_APP_PASSWORD,
    )
    const eventURL = databaseURL(
      'daejang_event_app',
      process.env.DAEJANG_EVENT_APP_PASSWORD,
    )
    const jitURL = databaseURL(
      'daejang_jit_app',
      process.env.DAEJANG_JIT_APP_PASSWORD,
    )
    const webURL = databaseURL(
      'daejang_web_app',
      process.env.DAEJANG_WEB_APP_PASSWORD,
    )
    const taxURL = databaseURL(
      'daejang_tax_app',
      process.env.DAEJANG_TAX_APP_PASSWORD,
    )
    const ethereumRPC = process.env.ENV_RPC_URL_ETHEREUM_MAINNET
    const optimismRPC =
      process.env.ENV_RPC_URL_OPTIMISM_MAINNET ?? 'https://mainnet.optimism.io'
    if (!ethereumRPC) throw new Error('ENV_RPC_URL_ETHEREUM_MAINNET is missing')

    const jitConfig = createCombinedJITConfig()
    const subjectACLSource = resolveRuntimeSubjectACLSource(
      join(jitRuntime, 'configs', 'subject-acl.json'),
      join(configRoot, 'subject-acl.source.json'),
    )
    const subjectACL = createRuntimeSubjectACL(
      subjectACLSource,
      join(configRoot, 'subject-acl.runtime.json'),
    )
    const indexerView = ensureRuntimeIndexerView(
      join(configRoot, 'evm-indexer-view'),
      {
        'ethereum-mainnet-tail': process.env.GIWA_ETHEREUM_INDEX_STORE ??
          '/Users/Shared/Projects/00_Backlight/evm-indexer-data/index/ethereum-mainnet-tail',
        'optimism-mainnet-bulk-bedrock-tail': process.env.GIWA_OPTIMISM_INDEX_STORE ??
          '/Users/Shared/Projects/00_Backlight/evm-indexer-data/index-bulk/optimism-mainnet-bulk-bedrock-tail',
      },
    )
    const indexerConfig = createRuntimeIndexerConfig(
      process.env.GIWA_EVM_INDEXER_CONFIG ??
        '/Users/Shared/Projects/00_Backlight/evm-indexer/configs/local-nodes.json',
      process.env.GIWA_EVM_BULK_INDEXER_CONFIG ??
        '/Users/Shared/Projects/00_Backlight/evm-indexer/configs/bulk-portal.json',
      join(configRoot, 'evm-indexer.runtime.json'),
      indexerView,
    )
    spawnService(
      'jit',
      jitBinary,
      [
        '--config',
        jitConfig,
        '--selection-dir',
        join(stateRoot, 'selections'),
        '--indexer-binary',
        process.env.GIWA_EVM_INDEXER_BINARY ??
          '/Users/Shared/Projects/00_Backlight/evm-indexer/bin/evm-indexer',
        '--indexer-config',
        indexerConfig,
        '--schema-dir',
        schemaRepository,
        '--cue-binary',
        join(jitRuntime, 'bin', 'cue'),
        '--subject-acl',
        subjectACL,
        '--defi-label-dir',
        deFiLabelRepository,
      ],
      serviceEnvironment(['EVM_INDEXER_DATA_DIR'], ['ENV_RPC_URL_', 'ETHEREUM_', 'OPTIMISM_'], {
        ENV_POSTGRES_DSN: jitURL,
        ENV_RPC_URL_ETHEREUM_MAINNET: ethereumRPC,
        ENV_RPC_URL_OPTIMISM_MAINNET: optimismRPC,
        ETHEREUM_RPC_URL: ethereumRPC,
        ETHEREUM_TRACE_RPC_URL: ethereumRPC,
        OPTIMISM_RPC_URL: optimismRPC,
        OPTIMISM_TRACE_RPC_URL: optimismRPC,
      }),
    )
    await waitFor(
      'multichain JIT',
      () => existsSync(jitSocket) ? unixReady(jitSocket) : Promise.resolve(false),
      60_000,
    )

    const engineEnvironment = serviceEnvironment([], [], {
      ENGINE_LISTEN: `unix://${engineSocket}`,
      DAEJANG_SOURCE_DATABASE_URL: sourceURL,
      DAEJANG_SOURCE_ARTIFACT_DATABASE_URL: sourceURL,
      DAEJANG_QUERY_DATABASE_URL: queryURL,
      DAEJANG_REPORT_DATABASE_URL: eventURL,
      DAEJANG_REVIEW_DATABASE_URL: eventURL,
      DAEJANG_REVIEW_ARTIFACT_DATABASE_URL: sourceURL,
      DAEJANG_SOURCE_ARTIFACT_ROOT: join(artifactRoot, 'source', 'root'),
      DAEJANG_SOURCE_ARTIFACT_TEMP: join(artifactRoot, 'source', 'tmp'),
      DAEJANG_TAX_ARTIFACT_DATABASE_URL: taxURL,
      DAEJANG_TAX_ARTIFACT_ROOT: join(artifactRoot, 'tax', 'root'),
      DAEJANG_TAX_ARTIFACT_TEMP: join(artifactRoot, 'tax', 'tmp'),
      DAEJANG_REVIEW_ARTIFACT_ROOT: join(artifactRoot, 'review', 'root'),
      DAEJANG_REVIEW_ARTIFACT_TEMP: join(artifactRoot, 'review', 'tmp'),
      ENGINE_PDF_PARSER_SOCKET_PATH: parserSocket,
      ...privateObjectWriteEnvironment(process.env),
    })
    spawnService('engine', join(binaryRoot, 'engine-api'), [], engineEnvironment)
    await waitFor('Engine', () => Promise.resolve(engineReady()), 30_000)

    const bridgeConfigSource = resolve(
      process.env.GIWA_JIT_BRIDGE_CONFIG ?? join(configRoot, 'jit-bridge.json'),
    )
    if (!existsSync(bridgeConfigSource)) {
      throw new Error(`JIT bridge config is missing: ${bridgeConfigSource}`)
    }
    const bridgeConfig = createRuntimeBridgeConfig(bridgeConfigSource)
    const workerReadyFile = join(stateRoot, 'worker.ready')
    rmSync(workerReadyFile, { force: true })
    spawnService('worker', join(binaryRoot, 'sync-worker'), [], serviceEnvironment([], [], {
      DAEJANG_SOURCE_DATABASE_URL: sourceURL,
      DAEJANG_PRIVATE_OBJECT_ROOT: join(runtimeRoot, 'private-objects'),
      DAEJANG_JIT_BRIDGE_CONFIG: bridgeConfig,
      DAEJANG_WORKER_READY_FILE: workerReadyFile,
      ...privateObjectWriteEnvironment(process.env),
      PRIVATE_OBJECT_LEGACY_KEY_ID: process.env.PRIVATE_OBJECT_LEGACY_KEY_ID,
      PRIVATE_OBJECT_DECRYPTION_KEYS: process.env.PRIVATE_OBJECT_DECRYPTION_KEYS,
    }))
    await waitFor(
      'worker',
      () => Promise.resolve(isRunning('worker') && existsSync(workerReadyFile)),
      10_000,
    )

    if (!existsSync(sourcePublicationClaimPolicy)) {
      throw new Error(
        `SOURCE publication claim policy is missing: ${sourcePublicationClaimPolicy}`,
      )
    }
    const postingArgs = hostPostingWorkerArgs(
      artifactRoot,
      postingRepository,
      sourcePublicationClaimPolicy,
    )
    const postingEnvironment = serviceEnvironment(
      [],
      [],
      hostPostingWorkerEnvironment(
        process.env.DAEJANG_PUBLICATION_POLICY_TRUST_KEY,
        eventURL,
        sourceURL,
      ),
    )
    runBestEffort(
      join(binaryRoot, 'posting-worker'),
      [...postingArgs, '--once'],
      { cwd: postingRepository, env: postingEnvironment },
    )
    spawnService(
      'posting',
      join(binaryRoot, 'posting-worker'),
      postingArgs,
      postingEnvironment,
      { cwd: postingRepository },
    )
    await sleep(1_000)
    if (!isRunning('posting')) {
      throw new Error('Posting worker exited during startup')
    }

    if (evmPostingEnabled()) {
      const evmPostingArgs = hostEVMPostingWorkerArgs(
        jitArtifactRoot,
        jitArtifactTemp,
        evmPublicationClaimPolicy,
        actionRuntimeRelease,
      )
      const evmPostingEnvironment = serviceEnvironment(
        [],
        [],
        hostEVMPostingWorkerEnvironment(
          process.env.DAEJANG_PUBLICATION_POLICY_TRUST_KEY,
          eventURL,
        ),
      )
      runBestEffort(
        join(binaryRoot, 'evm-posting-worker'),
        [...evmPostingArgs, '--once'],
        { cwd: postingRepository, env: evmPostingEnvironment },
      )
      spawnService(
        'evm-posting',
        join(binaryRoot, 'evm-posting-worker'),
        evmPostingArgs,
        evmPostingEnvironment,
        { cwd: postingRepository },
      )
      await sleep(1_000)
      if (!isRunning('evm-posting')) {
        throw new Error('JIT/EVM Posting worker exited during startup')
      }
    } else {
      console.warn(
        `JIT/EVM Posting worker is disabled until a signed policy is provisioned at ${evmPublicationClaimPolicy}`,
      )
    }

    const taxRuntime = await createTaxRuntime(queryURL)
    await retireMissingTaxReportGenerations(taxURL, taxRuntime)
    let taxdStarted = false
    if (taxRuntimeHasProfiles(taxRuntime)) {
      // Prefetch closes the current backlog before launch. Keep the single
      // daemon network-enabled so later ledger deliveries can archive their
      // own historical quote before calculation; manual backfill is blocked
      // while taxd is running, so only one Host process consumes Upbit.
      taxdStarted = await activateTaxRuntime(
        queryURL,
        taxURL,
        taxRuntime,
        { prefetch: true },
      )
    } else {
      markTaxdDisabled({
        reason: 'No current ledger subjects are available. The supervisor will activate taxd after Posting materialization.',
        status: 'NO_PROFILES',
        subjectEpochs: taxRuntime.subjectEpochs,
      })
      console.warn(
        'Tax Engine is disabled until at least one current ledger subject exists; the supervisor will recheck automatically',
      )
    }

    const webAPIEnvironment = serviceEnvironment(
      [
        'BODY_LIMIT_BYTES',
        'IDENTITY_VERIFICATION_MODE',
        'PRIVATE_OBJECT_DECRYPTION_KEYS',
        'PRIVATE_OBJECT_ENCRYPTION_KEY',
        'PRIVATE_OBJECT_ENCRYPTION_KEY_ID',
        'PRIVATE_OBJECT_LEGACY_KEY_ID',
        'PUBLIC_ORIGIN',
        'RATE_LIMIT_HMAC_SECRET',
        'SESSION_ABSOLUTE_TTL_SECONDS',
        'SESSION_IDLE_TTL_SECONDS',
        'SIGNUP_ENABLED',
        'SIGNUP_SESSION_TTL_SECONDS',
        'TRUST_PROXY_HOPS',
        'UPBIT_PDF_IMPORT_ENABLED',
        ...hostWebAPIForwardedEnvironmentNames,
      ],
      hostWebAPIForwardedEnvironmentPrefixes,
      {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: process.env.GIWA_HOST_API_PORT ?? '3001',
      DATABASE_URL: webURL,
      PRIVATE_OBJECT_ROOT: join(runtimeRoot, 'private-objects'),
      ...privateObjectWriteEnvironment(process.env),
      ...hostWebAPIEngineEnvironment(engineSocket),
      ENGINE_PROTO_PATH: join(
        runtimeRoot,
        'proto',
        'giwa',
        'engine',
        'v1',
        'engine.proto',
      ),
      UPBIT_PDF_IMPORT_ENABLED:
        process.env.UPBIT_PDF_IMPORT_ENABLED ?? 'false',
      },
    )
    spawnService(
      'web-api',
      'npm',
      ['run', 'start:web-api:host-production'],
      {
        ...webAPIEnvironment,
        GIWA_WEB_API_ENTRYPOINT: join(runtimeRoot, 'app', 'web-api', 'server.js'),
      },
      { cwd: repositoryRoot },
    )
    await waitFor(
      'Web API',
      webReady,
      30_000,
    )

    // Reclassification can immediately drive JIT, Posting, and ledger writes.
    // Enqueue only after every downstream service is stable so a deployment
    // restart cannot strand a deterministic runtime job in a failed state.
    const actionRuntimeID = createActionRuntimeIdentity(
      deFiLabelRepository,
      managedJITBinary,
      join(binaryRoot, 'evm-posting-worker'),
    )
    run(
      join(binaryRoot, 'action-runtime-reclassify'),
      [],
      {
        env: serviceEnvironment([], [], {
          DAEJANG_SOURCE_DATABASE_URL: sourceURL,
          DAEJANG_ACTION_RUNTIME_ID: actionRuntimeID,
        }),
      },
    )

    if (shutdownRequested) throw new Error('Backend shutdown was requested')
    rmSync(pauseFile, { force: true })
    const evmPostingStatus = evmPostingEnabled()
      ? ', JIT/EVM Posting worker'
      : ''
    const taxStatus = taxdStarted ? ', Tax Engine' : ''
    console.log(
      `Backend is ready: PostgreSQL, PDF parser, multichain JIT, Engine, sync worker, SOURCE Posting worker${evmPostingStatus}${taxStatus}, Web API`,
    )
  } catch (error) {
    await stopServices()
    throw error
  }
}

const stopService = async (name) => {
  const state = readProcessState(name)
  if (!isRunning(name)) {
    rmSync(pidFile(name), { force: true })
    if (name === 'taxd') {
      await waitFor(
        'taxd port release',
        async () => !await tcpReady(8981),
        5_000,
      )
    }
    return
  }
  try {
    process.kill(-state.pid, 'SIGTERM')
  } catch {
    process.kill(state.pid, 'SIGTERM')
  }
  const stoppedGracefully = await waitFor(
    `${name} shutdown`,
    () => Promise.resolve(!isRunning(name)),
    15_000,
  ).then(() => true).catch(() => false)
  if (!stoppedGracefully && isRunning(name)) {
    try {
      process.kill(-state.pid, 'SIGKILL')
    } catch {
      process.kill(state.pid, 'SIGKILL')
    }
    await waitFor(
      `${name} forced shutdown`,
      () => Promise.resolve(!isRunning(name)),
      5_000,
    )
  }
  if (name === 'taxd') {
    await waitFor(
      'taxd port release',
      async () => !await tcpReady(8981),
      5_000,
    )
  }
  rmSync(pidFile(name), { force: true })
}

const stopServices = async () => {
  for (const name of [...allServiceOrder].reverse()) {
    await stopService(name)
  }
  console.log('Backend services stopped; PostgreSQL remains running')
}

const stop = async () => {
  await withOperationLock(async () => {
    ensureRuntimeDirectories()
    writeFileSync(pauseFile, 'paused\n', { mode: fileMode })
    await stopServices()
  })
}

const start = (options) => withOperationLock(() => startServices(options))

export const runRestartOperation = async ({ prepare, pause, stop, start }) => {
  await prepare()
  pause()
  await stop()
  await start()
}

export const assertReportAttestationRuntimeInstalled = ({
  enabled,
  repository,
  fileExists = existsSync,
}) => {
  if (!enabled) return
  const entrypoint = join(
    repository,
    'node_modules',
    '@backward-labs',
    'daejang-contracts',
    'dist',
    'public',
    'giwaSepoliaV1.js',
  )
  if (!fileExists(entrypoint)) {
    throw new Error(
      'GIWA report attestation runtime is missing; install the verified contracts tarball before restart',
    )
  }
}

const prepareRestart = () => {
  ensureRuntimeDirectories()
  loadRuntimeEnvironment()
  assertReportAttestationRuntimeInstalled({
    enabled: process.env.GIWA_REPORT_ATTESTATIONS_ENABLED === 'true',
    repository: repositoryRoot,
  })
}

const restart = () => withOperationLock(async () => {
  await runRestartOperation({
    prepare: prepareRestart,
    pause: () => writeFileSync(pauseFile, 'paused\n', { mode: fileMode }),
    stop: stopServices,
    start: startServices,
  })
})

export const taxBackfillArgs = (subjectID, eventID, taxYearInput) => {
  if (!subjectID || !eventID) {
    throw new Error('tax-backfill requires subject and event IDs')
  }
  const rawTaxYear = taxYearInput === undefined ? '2027' : String(taxYearInput)
  if (!/^[0-9]{4}$/.test(rawTaxYear) || Number(rawTaxYear) < 2025) {
    throw new Error('tax-backfill tax year must be an integer from 2025 through 9999')
  }
  return [
    '-subject', subjectID,
    '-event', eventID,
    '-tax-year', rawTaxYear,
    '-apply',
  ]
}

const taxBackfill = (subjectID, eventID, taxYearInput) => withOperationLock(async () => {
  const commandArgs = taxBackfillArgs(subjectID, eventID, taxYearInput)
  if (isRunning('taxd')) {
    throw new Error('Stop taxd before applying a valuation backfill')
  }
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  loadRuntimeEnvironment()
  const queryURL = databaseURL(
    'daejang_query_app',
    process.env.DAEJANG_QUERY_APP_PASSWORD,
  )
  const taxURL = databaseURL(
    'daejang_tax_app',
    process.env.DAEJANG_TAX_APP_PASSWORD,
  )
  const runtime = await createTaxRuntime(queryURL)
  if (!taxRuntimeHasProfiles(runtime)) {
    throw new Error('Tax backfill requires at least one current ledger subject profile')
  }
  run(
    join(binaryRoot, 'tax-backfill'),
    commandArgs,
    {
      cwd: taxRepository,
      env: taxEnvironment(taxURL, runtime, { archiveOnly: false }),
    },
  )
})

const status = () => {
  for (const name of allServiceOrder) {
    const state = isRunning(name) ? 'running' : 'stopped'
    let disabled = ''
    if (name === 'evm-posting' && !evmPostingEnabled()) {
      disabled = ' (disabled: signed claim policy not provisioned)'
    } else if (name === 'taxd' && !taxdEnabled()) {
      const reason = readTaxdProfileState()?.reason ??
        'Tax profile runtime is not active'
      disabled = ` (disabled: ${reason})`
    }
    console.log(`${name}: ${state}${disabled}`)
  }
  const collector = readUpbitCandleCollectorArchiveStatus({
    path: upbitCandleCollectorStateFile,
  })
  const serviceState = isRunning('upbit-candle-sync') ? 'running' : 'stopped'
  const details = [`archive=${collector.status}`]
  if (collector.updatedAt) details.push(`updated=${collector.updatedAt}`)
  if (Number.isSafeInteger(collector.archiveBytes)) {
    details.push(
      `storage=${(collector.archiveBytes / (1 << 30)).toFixed(2)}/${(collector.quotaBytes / (1 << 30)).toFixed(0)}GiB`,
    )
  }
  if (Number.isSafeInteger(collector.completedPacks)) {
    details.push(`packs-created-this-run=${collector.completedPacks}`)
  }
  if (collector.nextMarket && collector.nextMonth) {
    details.push(`next=${collector.nextMarket}/${collector.nextMonth}`)
  }
  if (collector.status === 'BLOCKED') {
    details.push(collector.manualBlock
      ? 'manual-block=true'
      : `blocked-until=${collector.blockedUntil || 'unknown'}`)
  }
  if (collector.lastError) {
    details.push(`error=${collector.lastError.replaceAll(/\s+/gu, ' ').slice(0, 240)}`)
  }
  console.log(
    `upbit-candle-sync: ${serviceState} (supervisor-managed); ${details.join(', ')}`,
  )
}

const logs = () => {
  const files = [...allServiceOrder, 'upbit-candle-sync']
    .filter((name) => existsSync(logFile(name)))
    .map(logFile)
  if (files.length === 0) throw new Error('No backend logs are available')
  run('tail', ['-n', process.env.GIWA_LOG_LINES ?? '80', ...files])
}

let lastTaxProfileRefreshCheckAt = 0
let lastUpbitCandleCollectorRecoveryAt = 0

const reconcileUpbitCandleCollector = () => {
  if (isRunning('upbit-candle-sync')) return
  const now = Date.now()
  if (now - lastUpbitCandleCollectorRecoveryAt < 60_000) return
  lastUpbitCandleCollectorRecoveryAt = now
  try {
    ensureUpbitCandleCollectorRunning()
    console.log('Upbit candle collector recovered from the verified prebuilt release')
  } catch (error) {
    console.error(`Upbit candle collector recovery failed: ${error.message}`)
  }
}

const reconcileTaxRuntime = async () => {
  if (!await coreRuntimeHealthy()) return false

  const now = Date.now()
  const state = readTaxdProfileState()
  const taxdRunning = isRunning('taxd')
  const taxdReady = taxdRunning &&
    state?.status === 'ACTIVE' &&
    await taxRuntimeReady(state.candidateDigest)
  const unhealthyTaxd = state?.status === 'ACTIVE' &&
    (!taxdRunning || !taxdReady)
  if (
    !unhealthyTaxd &&
    now - lastTaxProfileRefreshCheckAt < hostTaxProfileRefreshIntervalMs
  ) return false
  lastTaxProfileRefreshCheckAt = now

  const queryURL = databaseURL(
    'daejang_query_app',
    process.env.DAEJANG_QUERY_APP_PASSWORD,
  )
  const taxURL = databaseURL(
    'daejang_tax_app',
    process.env.DAEJANG_TAX_APP_PASSWORD,
  )
  const subjectEpochs = await readTaxSubjectEpochs(queryURL)
  const action = planTaxProfileReconcile({
    state,
    subjectEpochs,
    taxdRunning,
    taxdReady,
    now,
  })
  if (action === 'NONE') return false

  if (action === 'RESTART_TAXD') {
    let activeRuntime
    try {
      activeRuntime = loadActiveTaxRuntime(state)
    } catch (error) {
      markTaxdDisabled({
        reason: `Active Tax runtime recovery failed: ${error.message}`,
        status: 'FAILED',
        candidateDigest: state?.candidateDigest ?? null,
        runtimeManifestPath: state?.runtimeManifestPath ?? null,
        subjectEpochs: state?.subjectEpochs ?? subjectEpochs,
        retry: true,
      })
      if (taxdRunning) await stopService('taxd')
      console.error(`Tax Engine recovery failed closed: ${error.message}`)
      return true
    }
    console.log('Tax Engine health failed; restarting taxd only from its active candidate manifest')
    await activateTaxRuntime(
      queryURL,
      taxURL,
      activeRuntime,
      { prefetch: false },
    )
    return true
  }

  let runtime
  try {
    runtime = await createTaxRuntime(queryURL)
    await retireMissingTaxReportGenerations(taxURL, runtime)
  } catch (error) {
    markTaxdDisabled({
      reason: `Tax profile generation failed: ${error.message}`,
      status: 'FAILED',
      subjectEpochs,
      retry: true,
    })
    if (taxdRunning) await stopService('taxd')
    console.error(`Tax Engine stopped after profile generation failed: ${error.message}`)
    return true
  }

  if (!taxRuntimeHasProfiles(runtime)) {
    markTaxdDisabled({
      reason: 'No current ledger subjects are available. The supervisor will activate taxd after Posting materialization.',
      status: 'NO_PROFILES',
      subjectEpochs: runtime.subjectEpochs,
    })
    if (taxdRunning) await stopService('taxd')
    console.warn('Tax Engine stopped because no current ledger subject remains')
    return true
  }

  const activation = planTaxProfileActivation({ state, runtime, action })

  console.log(
    `${activation.candidateChanged ? 'Tax profile change' : 'Tax ledger change or Engine failure'} detected; rebuilding affected annual outputs and restarting taxd: ${state?.candidateDigest ?? 'none'} -> ${runtime.candidateDigest}`,
  )
  await activateTaxRuntime(
    queryURL,
    taxURL,
    runtime,
    {
      prefetch: activation.prefetch,
      subjectIDs: activation.subjectIDs,
    },
  )
  return true
}

const supervise = async () => {
  ensureRuntimeDirectories()
  loadRuntimeEnvironment()
  const supervisorLock = tryAcquireProcessLock(supervisorLockFile)
  if (!supervisorLock) {
    const existing = JSON.parse(readFileSync(supervisorLockFile, 'utf8'))
    throw new Error(`Backend supervisor is already running as PID ${existing.pid}`)
  }
  try {
    while (!shutdownRequested) {
      await withOperationLock(async () => {
        reconcileUpbitCandleCollector()
        if (existsSync(pauseFile)) return
        if (await reconcileTaxRuntime()) return
        if (await runtimeHealthy()) return
        const running = allServiceOrder.filter(isRunning)
        if (running.length > 0) await stopServices()
        await startServices({ buildArtifacts: false })
      }).catch((error) => console.error(error))
      await sleep(5_000)
    }
  } finally {
    releaseProcessLock(supervisorLockFile, supervisorLock)
  }
}

const xmlEscape = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

export const launchdServiceDomains = (uid) => [`gui/${uid}`, `user/${uid}`]

export const readUpbitCandleCollectorArchiveStatus = ({
  path,
  fileExists = existsSync,
  readFile = readFileSync,
}) => {
  if (!fileExists(path)) return { status: 'NOT_STARTED' }
  try {
    const state = JSON.parse(readFile(path, 'utf8'))
    const allowed = new Set([
      'CATALOG',
      'PARTIAL',
      'SYNCING',
      'IDLE',
      'FAILED',
      'BLOCKED',
    ])
    if (
      state?.schemaVersion !== 'daejang.upbit-minute-bulk-state.v1' ||
      !allowed.has(state.status) ||
      typeof state.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(state.updatedAt)) ||
      !Number.isSafeInteger(state.archiveBytes) ||
      state.archiveBytes < 0 ||
      !Number.isSafeInteger(state.quotaBytes) ||
      state.quotaBytes < 1
    ) {
      return { status: 'CORRUPT' }
    }
    return {
      status: state.status,
      updatedAt: new Date(state.updatedAt).toISOString(),
      archiveBytes: state.archiveBytes,
      quotaBytes: state.quotaBytes,
      completedPacks: Number.isSafeInteger(state.completedPacks)
        ? state.completedPacks
        : 0,
      nextMarket: typeof state.nextMarket === 'string'
        ? state.nextMarket
        : '',
      nextMonth: typeof state.nextMonth === 'string'
        ? state.nextMonth
        : '',
      manualBlock: state.manualBlock === true,
      blockedUntil: typeof state.blockedUntil === 'string' &&
          Number.isFinite(Date.parse(state.blockedUntil))
        ? new Date(state.blockedUntil).toISOString()
        : '',
      lastError: typeof state.lastError === 'string' ? state.lastError : '',
    }
  } catch {
    return { status: 'CORRUPT' }
  }
}

export const stableSupervisorPath = ({ node, home }) => [...new Set([
  dirname(node),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  join(home, '.orbstack', 'bin'),
])].join(':')

export const cronAutostartEntries = ({
  repository,
  node,
  script,
  log,
  path,
  marker,
  group = runtimeGroupID,
}) => {
  const environment = [
    `PATH=${shellQuote(path)}`,
    `GIWA_APP_REPOSITORY=${shellQuote(repository)}`,
    ...(group >= 0 ? [`GIWA_HOST_RUNTIME_GROUP=${shellQuote(String(group))}`] : []),
  ].join(' ')
  const command = (operation) =>
    `cd ${shellQuote(repository)} && ${environment} ${shellQuote(node)} ${shellQuote(script)} ${operation} >> ${shellQuote(log)} 2>&1`
  return [
    `@reboot ${command('supervise')} ${marker}`,
    `* * * * * ${command('watchdog')} ${marker}`,
  ]
}

export const supervisorProcessSpec = ({ repository, node, script, path }) => ({
  command: node,
  args: [script, 'supervise'],
  options: {
    cwd: repository,
    detached: true,
    env: {
      ...baseEnvironment(),
      PATH: path,
      GIWA_APP_REPOSITORY: repository,
      GIWA_HOST_RUNTIME_ROOT: runtimeRoot,
      ...(runtimeShared
        ? { GIWA_HOST_RUNTIME_GROUP: String(runtimeGroupID) }
        : {}),
    },
  },
})

const startDetachedSupervisor = (script) => {
  const spec = supervisorProcessSpec({
    repository: canonicalRepositoryRoot,
    node: process.execPath,
    script,
    path: stableSupervisorPath({ node: process.execPath, home: homedir() }),
  })
  const descriptor = openSync(join(logRoot, 'supervisor.log'), 'a', fileMode)
  const child = spawn(spec.command, spec.args, {
    ...spec.options,
    stdio: ['ignore', descriptor, descriptor],
  })
  child.unref()
  closeSync(descriptor)
  console.log(`Started detached backend supervisor as PID ${child.pid}`)
}

const runSupervisorWatchdog = (script) => {
  ensureRuntimeDirectories()
  let lease
  try {
    lease = tryAcquireProcessLock(supervisorLockFile)
  } catch (error) {
    if (!String(error?.message).startsWith('Stale backend lock requires manual removal:')) {
      throw error
    }
    rmSync(supervisorLockFile)
    lease = tryAcquireProcessLock(supervisorLockFile)
  }
  if (!lease) return
  releaseProcessLock(supervisorLockFile, lease)
  startDetachedSupervisor(script)
}

const cronMarker = '# GIWA_HOST_BACKEND'

export const rewriteCrontabLines = (existing, entries, marker = cronMarker) => [
  ...existing.split(/\r?\n/).filter((line) => line && !line.includes(marker)),
  ...entries,
]

const readCrontab = () => {
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
  if (existing.status !== 0 && existing.status !== 1) {
    throw new Error(`Unable to read crontab: status ${existing.status}`)
  }
  return existing.stdout ?? ''
}

const writeCrontab = (lines) => {
  const installed = spawnSync('crontab', ['-'], {
    input: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (installed.status !== 0) {
    throw new Error(`Unable to install crontab: status ${installed.status}`)
  }
}

// launchd and cron would otherwise both try to own the supervisor, and the
// stale cron entries keep failing every minute against an older script path.
const removeCronAutostart = () => {
  const existing = readCrontab()
  if (!existing.includes(cronMarker)) return
  writeCrontab(rewriteCrontabLines(existing, []))
  console.log('Removed the superseded crontab supervisor entries')
}

const installCronAutostart = (script) => {
  writeCrontab(rewriteCrontabLines(readCrontab(), cronAutostartEntries({
    repository: canonicalRepositoryRoot,
    node: process.execPath,
    script,
    log: join(logRoot, 'supervisor.log'),
    path: stableSupervisorPath({ node: process.execPath, home: homedir() }),
    marker: cronMarker,
  })))
  console.log('Installed @reboot supervisor through crontab')
  return 'cron'
}

// Autostart must run the supervisor from the checkout that owns its
// dependencies. Node resolves bare specifiers such as `pg` by walking up from
// the importing module's own directory, so a copy placed under the runtime
// root can never resolve them no matter what working directory it is given.
export const resolveSupervisorScript = (repository, fileExists = existsSync) => {
  const script = join(repository, 'scripts', 'host-backend.mjs')
  if (!fileExists(script)) {
    throw new Error(`Supervisor script is missing: ${script}`)
  }
  if (!fileExists(join(repository, 'node_modules', 'pg'))) {
    throw new Error(
      `Supervisor dependencies are missing; run npm install in ${repository}`,
    )
  }
  return script
}

const installAutostart = () => withOperationLock(async () => {
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  const launchAgents = join(homedir(), 'Library', 'LaunchAgents')
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 })
  const plist = join(launchAgents, 'io.backwardlabs.giwa-host-backend.plist')
  const script = resolveSupervisorScript(canonicalRepositoryRoot)
  const servicePath = stableSupervisorPath({ node: process.execPath, home: homedir() })
  const collectorBinary = join(binaryRoot, 'upbit-candle-sync')
  const collectorQuoteConfig = upbitCandleCollectorQuoteConfigFile
  if (!existsSync(collectorBinary) || !existsSync(collectorQuoteConfig)) {
    throw new Error(
      'Upbit candle collector binary or quote config is missing; run backend:upbit-collector-start or backend:start before installing autostart',
    )
  }
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.backwardlabs.giwa-host-backend</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(script)}</string>
    <string>supervise</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(canonicalRepositoryRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(logRoot, 'supervisor.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logRoot, 'supervisor.log'))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xmlEscape(servicePath)}</string>
    <key>GIWA_HOST_RUNTIME_ROOT</key><string>${xmlEscape(runtimeRoot)}</string>
    <key>GIWA_APP_REPOSITORY</key><string>${xmlEscape(canonicalRepositoryRoot)}</string>${runtimeShared ? `
    <key>GIWA_HOST_RUNTIME_GROUP</key><string>${xmlEscape(String(runtimeGroupID))}</string>` : ''}
  </dict>
</dict></plist>
`, { mode: 0o600 })
  let installedWith
  let launchdDomain
  // bootstrap fails outright when the label is already loaded, which would
  // otherwise make a re-install silently fall back to cron.
  for (const domain of launchdServiceDomains(process.getuid())) {
    spawnSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' })
  }
  for (const domain of launchdServiceDomains(process.getuid())) {
    const bootstrap = spawnSync(
      'launchctl',
      ['bootstrap', domain, plist],
      { stdio: 'inherit' },
    )
    if (bootstrap.status === 0) {
      installedWith = 'launchd'
      launchdDomain = domain
      break
    }
  }
  if (!installedWith) {
    const load = spawnSync('launchctl', ['load', '-w', plist], {
      stdio: 'inherit',
    })
    installedWith = load.status === 0 ? 'launchd' : installCronAutostart(script)
  }
  if (installedWith === 'launchd') {
    removeCronAutostart()
    console.log(
      `Installed login supervisor${launchdDomain ? ` in ${launchdDomain}` : ''}: ${plist}`,
    )
  } else {
    runSupervisorWatchdog(script)
  }
  ensureUpbitCandleCollectorRunning()
  console.log('Upbit candle collector is supervised independently from backend stop/start')
})

let handlingSignal = false
export const runSignalShutdown = async ({
  pause,
  activeOperation,
  stop,
  preserveServices = false,
}) => {
  pause()
  if (activeOperation) await activeOperation.catch(() => {})
  if (!preserveServices) await stop()
}

export const finishSignalShutdown = ({ supervising, exitCode, exit }) => {
  process.exitCode = exitCode
  if (!supervising) exit(exitCode)
}

export const finishSuperviseCommand = ({ shutdown, exitCode, exit }) => {
  if (shutdown) exit(exitCode ?? 0)
}

export const handoffSupervisorAfterSignal = ({ shutdown, start }) => {
  if (shutdown) start()
}

export const pauseForSignalShutdown = ({ supervising, pause }) => {
  if (!supervising) pause()
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, async () => {
    if (handlingSignal) return
    handlingSignal = true
    shutdownRequested = true
    const supervising = process.argv[2] === 'supervise'
    ensureRuntimeDirectories()
    try {
      await runSignalShutdown({
        preserveServices: supervising,
        pause: () => pauseForSignalShutdown({
          supervising,
          pause: () => writeFileSync(pauseFile, 'paused\n', { mode: fileMode }),
        }),
        activeOperation: activeOperationPromise,
        stop: () => withOperationLock(async () => {
          pauseForSignalShutdown({
            supervising,
            pause: () => writeFileSync(pauseFile, 'paused\n', { mode: fileMode }),
          })
          await stopServices()
        }, { allowDuringShutdown: true }),
      })
    } catch (error) {
      console.error(error)
    } finally {
      finishSignalShutdown({
        supervising,
        exitCode,
        exit: process.exit,
      })
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === 'start') await start()
  else if (command === 'stop') await stop()
  else if (command === 'upbit-collector-start') {
    await startUpbitCandleCollectorOnly()
  } else if (command === 'restart') {
    await restart()
  } else if (command === 'tax-backfill') {
    await taxBackfill(process.argv[3], process.argv[4], process.argv[5])
  } else if (command === 'status') status()
  else if (command === 'logs') logs()
  else if (command === 'supervise') {
    await supervise()
    handoffSupervisorAfterSignal({
      shutdown: shutdownRequested,
      start: () => startDetachedSupervisor(fileURLToPath(import.meta.url)),
    })
    finishSuperviseCommand({
      shutdown: shutdownRequested,
      exitCode: process.exitCode,
      exit: process.exit,
    })
  }
  else if (command === 'install-autostart') await installAutostart()
  else if (command === 'share-runtime') shareRuntime()
  else if (command === 'watchdog') {
    runSupervisorWatchdog(fileURLToPath(import.meta.url))
  }
  else throw new Error('Usage: host-backend.mjs start|stop|upbit-collector-start|restart|status|logs|tax-backfill <subject> <event> [tax-year>=2025]|supervise|watchdog|install-autostart|share-runtime')
}
