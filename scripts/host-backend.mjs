import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  linkSync,
  openSync,
  readlinkSync,
  readFileSync,
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
const jitRepository = resolve(
  process.env.GIWA_JIT_REPOSITORY ?? join(projectRoot, 'daejang-jit-engine'),
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
const sourcePublicationClaimPolicy = join(
  configRoot,
  'source-publication-claim-policy.json',
)
const binaryRoot = join(runtimeRoot, 'bin')
const artifactRoot = join(runtimeRoot, 'artifacts')
const managedJITBinary = join(binaryRoot, 'jitd')
const jitBinary = resolve(
  process.env.GIWA_JIT_BINARY ??
    (existsSync(managedJITBinary)
      ? managedJITBinary
      : join(jitRuntime, 'bin', 'jitd')),
)
const pauseFile = join(stateRoot, 'paused')
const supervisorLockFile = join(stateRoot, 'supervisor.lock')
const operationLockFile = join(stateRoot, 'operation.lock')

const pathIsWithin = (parent, candidate) =>
  candidate === parent || candidate.startsWith(`${parent}/`)

const assertExternalRuntimeRoot = () => {
  for (const checkout of [
    repositoryRoot,
    databaseRepository,
    postingRepository,
    jitRepository,
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
    binaryRoot,
    join(artifactRoot, 'source', 'root'),
    join(artifactRoot, 'source', 'tmp'),
    join(artifactRoot, 'review', 'root'),
    join(artifactRoot, 'review', 'tmp'),
    join(runtimeRoot, 'private-objects'),
    join(stateRoot, 'selections'),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const linkMetadata = lstatSync(directory)
    if (linkMetadata.isSymbolicLink()) {
      throw new Error(`Runtime directory must not be a symbolic link: ${directory}`)
    }
    const metadata = statSync(directory)
    if (!metadata.isDirectory() || metadata.uid !== process.getuid()) {
      throw new Error(`Runtime directory is not owned by this service account: ${directory}`)
    }
    chmodSync(directory, 0o700)
  }
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

const serviceOrder = ['pdf-parser', 'jit', 'engine', 'worker', 'posting', 'web-api']
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

const spawnService = (name, command, args, environment, options = {}) => {
  if (isRunning(name)) throw new Error(`${name} is already running`)
  if (command.includes('/') && !existsSync(command)) {
    throw new Error(`${name} executable is missing: ${command}`)
  }
  rmSync(pidFile(name), { force: true })
  const descriptor = openSync(logFile(name), 'a', 0o600)
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
    { mode: 0o600 },
  )
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
  'GIWA_REPORT_ATTESTATIONS_ENABLED',
  'GIWA_REPORT_RPC_URL',
  'GIWA_REPORT_EAS_ADDRESS',
  'GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS',
  'GIWA_REPORT_REGISTRY_PROXY_ADDRESS',
  'GIWA_REPORT_CONSUMER_ADDRESS',
  'GIWA_REPORT_SCHEMA_UID',
  'GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST',
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
    const descriptor = openSync(temporaryPath, 'wx', 0o600)
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

const runtimeHealthy = async () => {
  if (!serviceOrder.every(isRunning)) return false
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

const databaseURL = (role, password) => {
  if (!password) throw new Error(`Database password for ${role} is missing`)
  const url = new URL('postgresql://127.0.0.1:55432/daejang')
  url.username = role
  url.password = password
  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

const build = () => {
  run('npm', ['run', 'build', '--workspace', '@daejang/web-api'], {
    cwd: repositoryRoot,
    env: baseEnvironment(),
  })
  for (const [command, output] of [
    ['./cmd/engine-api', join(binaryRoot, 'engine-api')],
    ['./cmd/engine-healthcheck', join(binaryRoot, 'engine-healthcheck')],
    ['./cmd/sync-worker', join(binaryRoot, 'sync-worker')],
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
  const webAPIRuntime = join(runtimeRoot, 'app', 'web-api')
  rmSync(webAPIRuntime, { recursive: true, force: true })
  mkdirSync(dirname(webAPIRuntime), { recursive: true, mode: 0o700 })
  cpSync(join(repositoryRoot, 'apps', 'web-api', 'dist'), webAPIRuntime, {
    recursive: true,
  })
  const runtimeProto = join(runtimeRoot, 'proto')
  rmSync(runtimeProto, { recursive: true, force: true })
  cpSync(join(repositoryRoot, 'proto'), runtimeProto, { recursive: true })
  const runtimeNodeModules = join(runtimeRoot, 'app', 'node_modules')
  rmSync(runtimeNodeModules, { recursive: true, force: true })
  symlinkSync(join(repositoryRoot, 'node_modules'), runtimeNodeModules, 'dir')
}

const createCombinedJITConfig = () => {
  const output = join(configRoot, 'ethereum-optimism-mainnet.yaml')
  const result = spawnSync(
    process.env.YQ_BINARY ?? '/opt/homebrew/bin/yq',
    [
      'ea',
      `. as $item ireduce ({}; . * $item) | .server.listen = "unix://${join(socketRoot, 'jit.sock')}"`,
      join(jitRuntime, 'configs', 'ethereum-mainnet.yaml'),
      join(jitRuntime, 'configs', 'optimism-mainnet.yaml'),
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0)
    throw new Error('Unable to create combined JIT config')
  writeFileSync(output, result.stdout, { mode: 0o600 })
  return output
}

const createRuntimeBridgeConfig = (source) => {
  const output = join(configRoot, 'jit-bridge.runtime.json')
  const config = JSON.parse(readFileSync(source, 'utf8'))
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
    mode: 0o600,
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
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  chmodSync(output, 0o600)
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
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  chmodSync(output, 0o600)
  return output
}

export const ensureRuntimeIndexerView = (root, stores) => {
  if (!isAbsolute(root)) throw new Error('EVM indexer view root must be absolute')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
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

const startServices = async ({ buildArtifacts = true } = {}) => {
  if (serviceOrder.some(isRunning))
    throw new Error('Backend services are already running; use backend:restart')
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  if (buildArtifacts) build()
  for (const requiredArtifact of [
    jitBinary,
    join(binaryRoot, 'engine-api'),
    join(binaryRoot, 'engine-healthcheck'),
    join(binaryRoot, 'sync-worker'),
    join(binaryRoot, 'posting-worker'),
    join(runtimeRoot, 'app', 'web-api', 'server.js'),
  ]) {
    if (!existsSync(requiredArtifact)) {
      throw new Error(`Prebuilt backend artifact is missing: ${requiredArtifact}`)
    }
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
        join(jitRuntime, 'schema'),
        '--cue-binary',
        join(jitRuntime, 'bin', 'cue'),
        '--subject-acl',
        subjectACL,
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
    run(
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

    if (shutdownRequested) throw new Error('Backend shutdown was requested')
    rmSync(pauseFile, { force: true })
    console.log(
      'Backend is ready: PostgreSQL, PDF parser, multichain JIT, Engine, sync worker, Posting worker, Web API',
    )
  } catch (error) {
    await stopServices()
    throw error
  }
}

const stopServices = async () => {
  for (const name of [...serviceOrder].reverse()) {
    const state = readProcessState(name)
    if (!isRunning(name)) {
      rmSync(pidFile(name), { force: true })
      continue
    }
    try {
      process.kill(-state.pid, 'SIGTERM')
    } catch {
      process.kill(state.pid, 'SIGTERM')
    }
    await waitFor(
      `${name} shutdown`,
      () => Promise.resolve(!isRunning(name)),
      15_000,
    ).catch(() => {
      if (isRunning(name)) {
        try {
          process.kill(-state.pid, 'SIGKILL')
        } catch {
          process.kill(state.pid, 'SIGKILL')
        }
      }
    })
    rmSync(pidFile(name), { force: true })
  }
  console.log('Backend services stopped; PostgreSQL remains running')
}

const stop = async () => {
  await withOperationLock(async () => {
    ensureRuntimeDirectories()
    writeFileSync(pauseFile, 'paused\n', { mode: 0o600 })
    await stopServices()
  })
}

const start = (options) => withOperationLock(() => startServices(options))

export const runRestartOperation = async ({ prepare, pause, stop, start }) => {
  prepare()
  pause()
  await stop()
  await start()
}

const restart = () => withOperationLock(async () => {
  await runRestartOperation({
    prepare: ensureRuntimeDirectories,
    pause: () => writeFileSync(pauseFile, 'paused\n', { mode: 0o600 }),
    stop: stopServices,
    start: startServices,
  })
})

const status = () => {
  for (const name of serviceOrder)
    console.log(`${name}: ${isRunning(name) ? 'running' : 'stopped'}`)
}

const logs = () => {
  const files = serviceOrder
    .filter((name) => existsSync(logFile(name)))
    .map(logFile)
  if (files.length === 0) throw new Error('No backend logs are available')
  run('tail', ['-n', process.env.GIWA_LOG_LINES ?? '80', ...files])
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
      if (!existsSync(pauseFile)) {
        await withOperationLock(async () => {
          if (existsSync(pauseFile) || await runtimeHealthy()) return
          const running = serviceOrder.filter(isRunning)
          if (running.length > 0) await stopServices()
          await startServices({ buildArtifacts: false })
        }).catch((error) => console.error(error))
      }
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

const installCronAutostart = (script) => {
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
  if (existing.status !== 0 && existing.status !== 1) {
    throw new Error(`Unable to read crontab: status ${existing.status}`)
  }
  const marker = '# GIWA_HOST_BACKEND'
  const retained = (existing.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line && !line.includes(marker))
  retained.push(
    `@reboot cd ${shellQuote(canonicalRepositoryRoot)} && GIWA_APP_REPOSITORY=${shellQuote(canonicalRepositoryRoot)} ${shellQuote(process.execPath)} ${shellQuote(script)} supervise >> ${shellQuote(join(logRoot, 'supervisor.log'))} 2>&1 ${marker}`,
  )
  const installed = spawnSync('crontab', ['-'], {
    input: `${retained.join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (installed.status !== 0) {
    throw new Error(`Unable to install crontab: status ${installed.status}`)
  }
  console.log('Installed @reboot supervisor through crontab')
  return 'cron'
}

const installAutostart = () => {
  assertExternalRuntimeRoot()
  ensureRuntimeDirectories()
  const launchAgents = join(homedir(), 'Library', 'LaunchAgents')
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 })
  const plist = join(launchAgents, 'io.backwardlabs.giwa-host-backend.plist')
  const script = join(stateRoot, 'host-backend.mjs')
  cpSync(fileURLToPath(import.meta.url), script)
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
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? '')}</string>
    <key>GIWA_HOST_RUNTIME_ROOT</key><string>${xmlEscape(runtimeRoot)}</string>
    <key>GIWA_APP_REPOSITORY</key><string>${xmlEscape(canonicalRepositoryRoot)}</string>
  </dict>
</dict></plist>
`, { mode: 0o600 })
  const bootstrap = spawnSync(
    'launchctl',
    ['bootstrap', `gui/${process.getuid()}`, plist],
    { stdio: 'inherit' },
  )
  let installedWith = 'launchd'
  if (bootstrap.status !== 0) {
    const load = spawnSync('launchctl', ['load', '-w', plist], {
      stdio: 'inherit',
    })
    if (load.status !== 0) installedWith = installCronAutostart(script)
  }
  if (installedWith === 'launchd') {
    console.log(`Installed login supervisor: ${plist}`)
  }
}

let handlingSignal = false
export const runSignalShutdown = async ({ pause, activeOperation, stop }) => {
  pause()
  if (activeOperation) await activeOperation.catch(() => {})
  await stop()
}

export const finishSignalShutdown = ({ supervising, exitCode, exit }) => {
  process.exitCode = exitCode
  if (!supervising) exit(exitCode)
}

export const finishSuperviseCommand = ({ shutdown, exitCode, exit }) => {
  if (shutdown) exit(exitCode ?? 0)
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, async () => {
    if (handlingSignal) return
    handlingSignal = true
    shutdownRequested = true
    ensureRuntimeDirectories()
    try {
      await runSignalShutdown({
        pause: () => writeFileSync(pauseFile, 'paused\n', { mode: 0o600 }),
        activeOperation: activeOperationPromise,
        stop: () => withOperationLock(async () => {
          writeFileSync(pauseFile, 'paused\n', { mode: 0o600 })
          await stopServices()
        }, { allowDuringShutdown: true }),
      })
    } catch (error) {
      console.error(error)
    } finally {
      finishSignalShutdown({
        supervising: process.argv[2] === 'supervise',
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
  else if (command === 'restart') {
    await restart()
  } else if (command === 'status') status()
  else if (command === 'logs') logs()
  else if (command === 'supervise') {
    await supervise()
    finishSuperviseCommand({
      shutdown: shutdownRequested,
      exitCode: process.exitCode,
      exit: process.exit,
    })
  }
  else if (command === 'install-autostart') installAutostart()
  else throw new Error('Usage: host-backend.mjs start|stop|restart|status|logs|supervise|install-autostart')
}
