import { Pool } from 'pg'

import { buildApp } from './app.js'
import { PostgresRateLimitStore } from './auth/rate-limit.js'
import { PostgresSessionStore } from './auth/postgres-session-store.js'
import { loadConfig } from './config.js'
import { assertWebAuthSchema } from './database/preflight.js'
import { EngineMtlsClient } from './engine/mtls-client.js'

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
  : undefined

if (pool) {
  await assertWebAuthSchema(pool)
}
if (engineClient) {
  await engineClient.waitForReady(5_000)
}

const { app } = await buildApp({
  config,
  ...(pool
    ? {
        sessionStore: new PostgresSessionStore(pool),
        rateLimitStore: new PostgresRateLimitStore(pool),
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
