import { Pool } from 'pg'

import { buildApp } from './app.js'
import { PostgresAccountAuthStore } from './auth/account-auth-store.js'
import { ResendVerificationEmailSender } from './auth/email-auth.js'
import { PostgresRateLimitStore } from './auth/rate-limit.js'
import { PostgresSessionStore } from './auth/postgres-session-store.js'
import { PostgresUserStore } from './auth/postgres-user-store.js'
import { loadConfig } from './config.js'
import { assertWebAuthSchema } from './database/preflight.js'
import { EngineMtlsClient } from './engine/mtls-client.js'
import { PostgresWalletSourceStore } from './sources/postgres-wallet-source-store.js'
import { assertPrivateObjectRoot, PostgresFileUploadStore } from './uploads/postgres-file-upload-store.js'

const config = loadConfig()
const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      application_name: 'daejang-web-api',
      max: 10,
      statement_timeout: 10_000,
    })
  : undefined
const engineClient = config.engineMtls
  ? await EngineMtlsClient.connect(config.engineMtls)
  : config.engineInsecureTarget
    ? EngineMtlsClient.connectInsecureForDevelopment(config.engineInsecureTarget)
    : undefined

if (pool) {
  await assertWebAuthSchema(pool)
}
if (engineClient) {
  await engineClient.waitForReady(5_000)
}
if (config.privateObjectRoot) {
  await assertPrivateObjectRoot(config.privateObjectRoot)
}

const { app } = await buildApp({
  config,
  ...(config.emailAuth.enabled
    ? {
        verificationEmailSender: new ResendVerificationEmailSender(
          config.emailAuth.resendApiKey as string,
          config.emailAuth.from as string,
        ),
      }
    : {}),
  ...(pool
    ? {
        sessionStore: new PostgresSessionStore(pool),
        rateLimitStore: new PostgresRateLimitStore(pool),
        accountAuthStore: new PostgresAccountAuthStore(pool),
        ...(engineClient
          ? {
              walletSourceStore: new PostgresWalletSourceStore(pool, engineClient),
              engineDataClient: engineClient,
              ...(config.privateObjectRoot
                ? { uploadStore: new PostgresFileUploadStore(pool, config.privateObjectRoot) }
                : {}),
            }
          : {}),
        ...(config.devBootstrapUser
          ? { developmentUserStore: new PostgresUserStore(pool) }
          : {}),
      }
    : {}),
  ...(pool && engineClient
    ? {
        readinessCheck: async () => {
          await Promise.all([
            pool.query('SELECT 1'),
            engineClient.waitForReady(2_000),
            ...(config.privateObjectRoot
              ? [assertPrivateObjectRoot(config.privateObjectRoot)]
              : []),
          ])
        },
      }
    : {}),
})

app.addHook('onClose', async () => {
  engineClient?.close()
  await pool?.end()
})

const shutdown = async (signal: NodeJS.Signals) => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
