import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryParent = resolve(repositoryRoot, '..')
const projectRoot = basename(repositoryParent) === '.worktrees'
  ? resolve(repositoryParent, '..')
  : repositoryParent
const databaseRepository = resolve(
  process.env.GIWA_DATABASE_REPOSITORY ?? join(projectRoot, 'daejang-db'),
)
const pinnedDatabaseCommit = readFileSync(
  join(repositoryRoot, 'services', 'engine', 'go.mod'),
  'utf8',
).match(/github\.com\/BackwardLabs\/daejang-db v[^\n]*-([0-9a-f]{12})/)?.[1]
const databaseCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: databaseRepository,
  encoding: 'utf8',
})
if (
  !pinnedDatabaseCommit ||
  databaseCommit.status !== 0 ||
  !databaseCommit.stdout.trim().startsWith(pinnedDatabaseCommit)
) {
  throw new Error(
    'GIWA_DATABASE_REPOSITORY must be the exact daejang-db commit pinned by services/engine/go.mod',
  )
}
const socketTempRoot = existsSync('/private/tmp') ? '/private/tmp' : tmpdir()
const runtimeRoot = mkdtempSync(join(socketTempRoot, 'djsp-e2e-'))
const parserSocket = join(runtimeRoot, 'pdf-parser.sock')
const engineSocket = join(runtimeRoot, 'engine.sock')
for (const socketPath of [parserSocket, engineSocket]) {
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`Unix socket path is too long: ${socketPath}`)
  }
}
const allocateLoopbackPort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('unable to allocate test database port')))
      return
    }
    server.close(() => resolvePort(String(address.port)))
  })
})
const databasePort = await allocateLoopbackPort()
const databaseName = 'daejang_source_pipeline_test'
const ownerPassword = 'daejang-owner-source-e2e-only'
const webPassword = 'daejang-web-source-e2e-only'
const sourcePassword = 'daejang-source-source-e2e-only'
const queryPassword = 'daejang-query-source-e2e-only'
const eventPassword = 'daejang-event-source-e2e-only'
const composeProject = 'daejang-source-pipeline-e2e'

const databaseEnvironment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: composeProject,
  POSTGRES_DB: databaseName,
  POSTGRES_PORT: databasePort,
  POSTGRES_USER: 'daejang_owner',
  POSTGRES_PASSWORD: ownerPassword,
  DAEJANG_WEB_APP_PASSWORD: webPassword,
  DAEJANG_JIT_APP_PASSWORD: 'daejang-jit-source-e2e-only',
  DAEJANG_SOURCE_APP_PASSWORD: sourcePassword,
  DAEJANG_QUERY_APP_PASSWORD: queryPassword,
  DAEJANG_EVENT_APP_PASSWORD: eventPassword,
  DAEJANG_LOT_APP_PASSWORD: 'daejang-lot-source-e2e-only',
}

const databaseUrl = (user, password) =>
  `postgresql://${user}:${password}@127.0.0.1:${databasePort}/${databaseName}?sslmode=disable`

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`)
  }
}

const waitForSocket = (path, timeoutMilliseconds = 30_000, child) =>
  new Promise((resolveReady, reject) => {
    const deadline = Date.now() + timeoutMilliseconds
    const attempt = () => {
      if (child?.exitCode !== null) {
        reject(new Error(`service exited before socket became ready: ${path}`))
        return
      }
      const socket = net.createConnection(path)
      socket.once('connect', () => {
        socket.destroy()
        resolveReady()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`socket did not become ready: ${path}`))
          return
        }
        setTimeout(attempt, 50)
      })
    }
    attempt()
  })

const waitForParserHealth = (path, timeoutMilliseconds = 30_000, child) =>
  new Promise((resolveReady, reject) => {
    const deadline = Date.now() + timeoutMilliseconds
    const attempt = () => {
      if (child?.exitCode !== null) {
        reject(new Error(`parser exited before becoming healthy: code=${child.exitCode} signal=${child.signalCode}`))
        return
      }
      const socket = net.createConnection(path)
      const response = []
      socket.once('connect', () => socket.end('DJPING01'))
      socket.on('data', (chunk) => response.push(chunk))
      socket.once('end', () => {
        if (Buffer.concat(response).toString() === 'DJPONG01') {
          resolveReady()
          return
        }
        retry()
      })
      socket.once('error', retry)
      function retry() {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`parser did not become healthy: ${path}`))
          return
        }
        setTimeout(attempt, 50)
      }
    }
    attempt()
  })

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

let parser
let engine
let databaseCleanupRequired = false
try {
  databaseCleanupRequired = true
  run('make', ['database-up'], {
    cwd: databaseRepository,
    env: databaseEnvironment,
  })
  const pythonCandidates = [
    process.env.PDF_PARSER_PYTHON,
    join(repositoryRoot, 'services', 'engine', '.venv-pdf-parser', 'bin', 'python'),
    join(projectRoot, 'daejang', 'services', 'engine', '.venv-pdf-parser', 'bin', 'python'),
  ].filter(Boolean)
  const python = pythonCandidates.find((candidate) => existsSync(candidate))
  if (!python) {
    throw new Error('A pinned PDF parser venv is required; set PDF_PARSER_PYTHON')
  }

  parser = spawn(python, [
    '-I',
    '-B',
    join(repositoryRoot, 'services', 'engine', 'python', 'pdf_parser_server.py'),
    '--socket',
    parserSocket,
    '--request-timeout-seconds',
    '20',
  ], { stdio: 'inherit' })
  await waitForParserHealth(parserSocket, 30_000, parser)

  engine = spawn('go', ['run', './cmd/engine-api'], {
    cwd: join(repositoryRoot, 'services', 'engine'),
    stdio: 'inherit',
    env: {
      ...process.env,
      ENGINE_LISTEN: `unix://${engineSocket}`,
      DAEJANG_SOURCE_DATABASE_URL: databaseUrl('daejang_source_app', sourcePassword),
      DAEJANG_SOURCE_ARTIFACT_DATABASE_URL: databaseUrl('daejang_source_app', sourcePassword),
      DAEJANG_QUERY_DATABASE_URL: databaseUrl('daejang_query_app', queryPassword),
      DAEJANG_REPORT_DATABASE_URL: databaseUrl('daejang_event_app', eventPassword),
      DAEJANG_SOURCE_ARTIFACT_ROOT: join(runtimeRoot, 'artifacts'),
      DAEJANG_SOURCE_ARTIFACT_TEMP: join(runtimeRoot, 'artifact-tmp'),
      ENGINE_PDF_PARSER_SOCKET_PATH: parserSocket,
      ENGINE_PDF_PARSER_TIMEOUT: '20s',
      ENGINE_PDF_IMPORT_LEASE_DURATION: '2m',
      PRIVATE_OBJECT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      PRIVATE_OBJECT_ENCRYPTION_KEY_ID: 'source-pipeline-e2e',
      GOCACHE: join(runtimeRoot, 'go-cache'),
    },
  })
  await waitForSocket(engineSocket, 60_000, engine)
  await waitForParserHealth(parserSocket, 10_000, parser)

  run('npm', [
    'run',
    'test',
    '--workspace',
    '@daejang/web-api',
    '--',
    'src/sources/source-pipeline.e2e.test.ts',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RUN_SOURCE_PIPELINE_E2E_TESTS: '1',
      TEST_DATABASE_URL: databaseUrl('daejang_owner', ownerPassword),
      TEST_WEB_DATABASE_URL: databaseUrl('daejang_web_app', webPassword),
      TEST_ENGINE_GRPC_TARGET: `unix:${engineSocket}`,
    },
  })
} finally {
  await stopChild(engine)
  await stopChild(parser)
  if (databaseCleanupRequired && process.env.GIWA_E2E_KEEP_DATABASE !== '1') {
    spawnSync(
      'docker',
      ['compose', '--project-name', composeProject, 'down', '--volumes', '--remove-orphans'],
      { cwd: databaseRepository, env: databaseEnvironment, stdio: 'inherit' },
    )
  }
  rmSync(runtimeRoot, { recursive: true, force: true })
}
