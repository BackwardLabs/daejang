import { existsSync, mkdirSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databaseCredentialsFile = resolve(
  process.env.GIWA_DATABASE_ENV_FILE ??
    join(repositoryRoot, '..', 'daejang-db', '.env'),
)
const environmentFile = resolve(
  process.env.GIWA_PRODUCTION_ENV_FILE ??
    join(repositoryRoot, 'deploy', 'production.env'),
)

if (!existsSync(environmentFile)) {
  throw new Error(`Production environment file is missing: ${environmentFile}`)
}
if (!existsSync(databaseCredentialsFile)) {
  throw new Error(
    `Database credentials file is missing: ${databaseCredentialsFile}`,
  )
}

loadEnvFile(databaseCredentialsFile)
loadEnvFile(environmentFile)

const required = [
  'PUBLIC_ORIGIN',
  'WEB_DATABASE_URL',
  'RATE_LIMIT_HMAC_SECRET',
]
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`${name} is required in ${environmentFile}`)
  }
}

const databaseUrl = new URL(process.env.WEB_DATABASE_URL)
if (
  databaseUrl.username === 'daejang_web_app' &&
  process.env.DAEJANG_WEB_APP_PASSWORD
) {
  databaseUrl.password = process.env.DAEJANG_WEB_APP_PASSWORD
}
if (databaseUrl.hostname === 'postgres') {
  databaseUrl.hostname = '127.0.0.1'
  databaseUrl.port = process.env.GIWA_HOST_DATABASE_PORT ?? '55432'
}

const runtimeRoot = resolve(
  process.env.GIWA_HOST_RUNTIME_ROOT ??
    join(repositoryRoot, '.runtime', 'production'),
)
const privateObjectRoot = join(runtimeRoot, 'private-objects')
mkdirSync(privateObjectRoot, { recursive: true, mode: 0o700 })

Object.assign(process.env, {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: process.env.GIWA_HOST_API_PORT ?? '3000',
  DATABASE_URL: databaseUrl.toString(),
  PRIVATE_OBJECT_ROOT: privateObjectRoot,
  ENGINE_ALLOW_INSECURE_LOOPBACK: 'true',
  ENGINE_GRPC_INSECURE_TARGET:
    process.env.ENGINE_GRPC_INSECURE_TARGET ??
    process.env.GIWA_HOST_ENGINE_TARGET ??
    '127.0.0.1:50051',
  UPBIT_PDF_IMPORT_ENABLED: 'false',
})

delete process.env.ENGINE_GRPC_TARGET
delete process.env.ENGINE_GRPC_CA_PATH
delete process.env.ENGINE_GRPC_CERT_PATH
delete process.env.ENGINE_GRPC_KEY_PATH

await import(
  pathToFileURL(join(repositoryRoot, 'apps', 'web-api', 'dist', 'server.js')).href
)
