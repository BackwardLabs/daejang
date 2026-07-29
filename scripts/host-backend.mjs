import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryParent = resolve(repositoryRoot, '..')
const projectRoot =
  basename(repositoryParent) === '.worktrees'
    ? resolve(repositoryParent, '..')
    : repositoryParent
const databaseRepository = resolve(
  process.env.GIWA_DATABASE_REPOSITORY ?? join(projectRoot, 'daejang-db'),
)
const jitRepository = resolve(
  process.env.GIWA_JIT_REPOSITORY ?? join(projectRoot, 'daejang-jit-engine'),
)
const jitRuntime = resolve(
  process.env.GIWA_JIT_RUNTIME ?? join(projectRoot, 'daejang-jit-runtime'),
)
const runtimeRoot = resolve(
  process.env.GIWA_HOST_RUNTIME_ROOT ??
    join(repositoryRoot, '.runtime', 'production'),
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
const binaryRoot = join(runtimeRoot, 'bin')
const artifactRoot = join(runtimeRoot, 'artifacts')

const ensureRuntimeDirectories = () => {
  for (const directory of [
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
  }
}

const databaseEnvFile = resolve(
  process.env.GIWA_DATABASE_ENV_FILE ?? join(databaseRepository, '.env'),
)
const productionEnvFile = resolve(
  process.env.GIWA_PRODUCTION_ENV_FILE ??
    join(repositoryRoot, 'deploy', 'production.env'),
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

const serviceOrder = ['pdf-parser', 'jit', 'engine', 'worker', 'web-api']
const pidFile = (name) => join(pidRoot, `${name}.pid`)
const logFile = (name) => join(logRoot, `${name}.log`)

const readPid = (name) => {
  try {
    return Number.parseInt(readFileSync(pidFile(name), 'utf8').trim(), 10)
  } catch {
    return undefined
  }
}

const isRunning = (name) => {
  const pid = readPid(name)
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0)
    throw new Error(`${command} failed with status ${result.status}`)
}

const spawnService = (name, command, args, environment) => {
  if (isRunning(name)) throw new Error(`${name} is already running`)
  rmSync(pidFile(name), { force: true })
  const descriptor = openSync(logFile(name), 'a', 0o600)
  const child = spawn(command, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', descriptor, descriptor],
  })
  child.unref()
  closeSync(descriptor)
  writeFileSync(pidFile(name), `${child.pid}\n`, { mode: 0o600 })
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
  })
  for (const [command, output] of [
    ['./cmd/engine-api', join(binaryRoot, 'engine-api')],
    ['./cmd/sync-worker', join(binaryRoot, 'sync-worker')],
  ]) {
    run('go', ['build', '-o', output, command], {
      cwd: join(repositoryRoot, 'services', 'engine'),
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? join(runtimeRoot, 'go-build-cache'),
      },
    })
  }
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
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  })
  return output
}

const start = async () => {
  if (serviceOrder.some(isRunning))
    throw new Error('Backend services are already running; use backend:restart')
  loadRuntimeEnvironment()
  ensureRuntimeDirectories()

  try {
    run('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: databaseRepository,
    })
    await waitFor('PostgreSQL', () => tcpReady(55432), 30_000)
    build()

    const parserSocket = join(socketRoot, 'pdf-parser.sock')
    const jitSocket = join(socketRoot, 'jit.sock')
    rmSync(parserSocket, { force: true })
    rmSync(jitSocket, { force: true })

    spawnService(
      'pdf-parser',
      process.env.GIWA_PDF_PARSER_PYTHON ??
        join(
          repositoryRoot,
          'services',
          'engine',
          '.venv-pdf-parser',
          'bin',
          'python',
        ),
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
    spawnService(
      'jit',
      join(jitRuntime, 'bin', 'jitd'),
      [
        '--config',
        jitConfig,
        '--selection-dir',
        join(stateRoot, 'selections'),
        '--indexer-binary',
        process.env.GIWA_EVM_INDEXER_BINARY ??
          '/Users/Shared/Projects/00_Backlight/evm-indexer/bin/evm-indexer',
        '--indexer-config',
        process.env.GIWA_EVM_INDEXER_CONFIG ??
          '/Users/Shared/Projects/00_Backlight/evm-indexer/configs/local-nodes.json',
        '--schema-dir',
        join(jitRuntime, 'schema'),
        '--cue-binary',
        join(jitRuntime, 'bin', 'cue'),
        '--subject-acl',
        join(jitRuntime, 'configs', 'subject-acl.json'),
      ],
      {
        ...process.env,
        ENV_POSTGRES_DSN: jitURL,
        ENV_RPC_URL_ETHEREUM_MAINNET: ethereumRPC,
        ENV_RPC_URL_OPTIMISM_MAINNET: optimismRPC,
        ETHEREUM_RPC_URL: ethereumRPC,
        ETHEREUM_TRACE_RPC_URL: ethereumRPC,
        OPTIMISM_RPC_URL: optimismRPC,
        OPTIMISM_TRACE_RPC_URL: optimismRPC,
      },
    )
    await waitFor(
      'multichain JIT',
      () => Promise.resolve(existsSync(jitSocket)),
      60_000,
    )

    spawnService('engine', join(binaryRoot, 'engine-api'), [], {
      ...process.env,
      ENGINE_LISTEN: '127.0.0.1:50051',
      ENGINE_ALLOW_INSECURE_LOOPBACK: 'true',
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
      ENGINE_TLS_CERT_PATH: '',
      ENGINE_TLS_KEY_PATH: '',
      ENGINE_TLS_CLIENT_CA_PATH: '',
      ENGINE_WEB_API_CLIENT_DNS_NAME: '',
    })
    await waitFor('Engine', () => tcpReady(50051), 30_000)

    const bridgeConfigSource = resolve(
      process.env.GIWA_JIT_BRIDGE_CONFIG ?? join(configRoot, 'jit-bridge.json'),
    )
    if (!existsSync(bridgeConfigSource)) {
      throw new Error(`JIT bridge config is missing: ${bridgeConfigSource}`)
    }
    const bridgeConfig = createRuntimeBridgeConfig(bridgeConfigSource)
    spawnService('worker', join(binaryRoot, 'sync-worker'), [], {
      ...process.env,
      DAEJANG_SOURCE_DATABASE_URL: sourceURL,
      DAEJANG_PRIVATE_OBJECT_ROOT: join(runtimeRoot, 'private-objects'),
      DAEJANG_JIT_BRIDGE_CONFIG: bridgeConfig,
    })
    await waitFor('worker', () => Promise.resolve(isRunning('worker')), 5_000)

    const webAPIEnvironment = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: process.env.GIWA_HOST_API_PORT ?? '3001',
      DATABASE_URL: webURL,
      PRIVATE_OBJECT_ROOT: join(runtimeRoot, 'private-objects'),
      ENGINE_ALLOW_INSECURE_LOOPBACK: 'true',
      ENGINE_GRPC_INSECURE_TARGET: '127.0.0.1:50051',
      UPBIT_PDF_IMPORT_ENABLED:
        process.env.UPBIT_PDF_IMPORT_ENABLED ?? 'false',
    }
    for (const name of [
      'ENGINE_GRPC_TARGET',
      'ENGINE_GRPC_CA_PATH',
      'ENGINE_GRPC_CERT_PATH',
      'ENGINE_GRPC_KEY_PATH',
    ]) {
      delete webAPIEnvironment[name]
    }
    spawnService(
      'web-api',
      process.execPath,
      [join(repositoryRoot, 'apps', 'web-api', 'dist', 'server.js')],
      webAPIEnvironment,
    )
    await waitFor(
      'Web API',
      async () => {
        try {
          return (
            await fetch(
              `http://127.0.0.1:${process.env.GIWA_HOST_API_PORT ?? '3001'}/readyz`,
            )
          ).ok
        } catch {
          return false
        }
      },
      30_000,
    )

    console.log(
      'Backend is ready: PostgreSQL, PDF parser, multichain JIT, Engine, worker, Web API',
    )
  } catch (error) {
    await stop()
    throw error
  }
}

const stop = async () => {
  for (const name of [...serviceOrder].reverse()) {
    const pid = readPid(name)
    if (!isRunning(name)) {
      rmSync(pidFile(name), { force: true })
      continue
    }
    process.kill(pid, 'SIGTERM')
    await waitFor(
      `${name} shutdown`,
      () => Promise.resolve(!isRunning(name)),
      15_000,
    ).catch(() => {
      process.kill(pid, 'SIGKILL')
    })
    rmSync(pidFile(name), { force: true })
  }
  console.log('Backend services stopped; PostgreSQL remains running')
}

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

let handlingSignal = false
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, async () => {
    if (handlingSignal) return
    handlingSignal = true
    await stop()
    process.exit(exitCode)
  })
}

const command = process.argv[2]
if (command === 'start') await start()
else if (command === 'stop') await stop()
else if (command === 'restart') {
  await stop()
  await start()
} else if (command === 'status') status()
else if (command === 'logs') logs()
else throw new Error('Usage: host-backend.mjs start|stop|restart|status|logs')
