import { Pool } from 'pg'

import { buildApp } from './app.js'
import { PostgresAccountAuthStore } from './auth/account-auth-store.js'
import { ResendVerificationEmailSender } from './auth/email-auth.js'
import { PostgresRateLimitStore } from './auth/rate-limit.js'
import { PostgresSessionStore } from './auth/postgres-session-store.js'
import { loadConfig } from './config.js'
import { assertReportPaymentSchema, assertTaxReportSchema, assertWebAuthSchema } from './database/preflight.js'
import { EngineMtlsClient } from './engine/mtls-client.js'
import { HttpReportPaymentFacilitator } from './report-payment/facilitator.js'
import { PostgresReportPaymentStore } from './report-payment/postgres-report-payment-store.js'
import { PostgresWalletSourceStore } from './sources/postgres-wallet-source-store.js'
import { PostgresTaxReportReader } from './tax-report/postgres-tax-report-reader.js'
import { startUploadCleanup } from './uploads/upload-cleanup.js'
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
  ? await EngineMtlsClient.connect(config.engineMtls, config.upbitPdfImportEnabled)
  : config.engineInsecureTarget
    ? EngineMtlsClient.connectInsecureLoopback(
        config.engineInsecureTarget,
        config.upbitPdfImportEnabled,
      )
    : undefined
const uploadStore = pool && config.privateObjectRoot
  ? new PostgresFileUploadStore(pool, config.privateObjectRoot)
  : undefined
const taxReportReader = pool ? new PostgresTaxReportReader(pool) : undefined

if (pool) {
  await assertWebAuthSchema(pool)
  await assertTaxReportSchema(pool)
  if (config.reportPayments) {
    await assertReportPaymentSchema(pool)
  }
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
        ...(taxReportReader ? { taxReportReader } : {}),
        ...(config.reportPayments && taxReportReader
          ? {
              reportPaymentTaxReportReader: taxReportReader,
              reportPaymentStore: new PostgresReportPaymentStore(pool),
              reportPaymentFacilitator: new HttpReportPaymentFacilitator(
                config.reportPayments.facilitatorUrl,
              ),
            }
          : {}),
        ...(engineClient
          ? {
              walletSourceStore: new PostgresWalletSourceStore(pool, engineClient),
              engineDataClient: engineClient,
            }
          : {}),
        ...(uploadStore ? { uploadStore } : {}),
      }
    : {}),
  ...(pool
    ? {
        readinessCheck: async () => {
          await Promise.all([
            pool.query('SELECT 1'),
            ...(config.privateObjectRoot
              ? [assertPrivateObjectRoot(config.privateObjectRoot)]
              : []),
          ])
        },
      }
    : {}),
})

const uploadCleanup = uploadStore
  ? startUploadCleanup({
      store: uploadStore,
      onResult: (result) => {
        if (result.examined === 0) return
        app.log.info(result, 'abandoned upload cleanup completed')
      },
      onError: (error) => {
        app.log.error(
          { errorClass: error instanceof Error ? error.name : 'non_error' },
          'abandoned upload cleanup failed',
        )
      },
    })
  : undefined

app.addHook('onClose', async () => {
  await uploadCleanup?.stop()
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
