import { Pool } from 'pg'

import { buildApp } from './app.js'
import { PostgresAccountAuthStore } from './auth/account-auth-store.js'
import { ResendVerificationEmailSender } from './auth/email-auth.js'
import { PostgresRateLimitStore } from './auth/rate-limit.js'
import { PostgresSessionStore } from './auth/postgres-session-store.js'
import { loadConfig } from './config.js'
import {
  assertReportAttestationSchema,
  assertReportPaymentSchema,
  assertTaxReportSchema,
  assertWebAuthSchema,
} from './database/preflight.js'
import { EngineMtlsClient } from './engine/mtls-client.js'
import {
  HttpReportAttestationDeploymentReader,
} from './report-attestation-deployment/reader.js'
import {
  createGiwaSepoliaReportAttestationServerRuntime,
} from './report-attestations/giwa-sepolia-server-runtime.js'
import { HttpReportPaymentFacilitator } from './report-payment/facilitator.js'
import { PostgresReportPaymentStore } from './report-payment/postgres-report-payment-store.js'
import {
  assessReportAttestationDeploymentSnapshot,
} from './routes/report-attestation-deployment.js'
import { PostgresWalletSourceStore } from './sources/postgres-wallet-source-store.js'
import { PostgresTaxReportReader } from './tax-report/postgres-tax-report-reader.js'
import {
  assertPrivateObjectRoot,
  PostgresFileUploadStore,
} from './uploads/postgres-file-upload-store.js'
import { startUploadCleanup } from './uploads/upload-cleanup.js'

type UploadCleanup = ReturnType<typeof startUploadCleanup>
type EngineClient = Awaited<
  ReturnType<typeof EngineMtlsClient.connect>
>
type GiwaRuntimeResources = Awaited<
  ReturnType<
    typeof createGiwaSepoliaReportAttestationServerRuntime
  >
>

const start = async () => {
  const config = loadConfig()
  let pool: Pool | undefined
  let engineClient: EngineClient | undefined
  let giwaRuntime: GiwaRuntimeResources | undefined
  let reportAttestationSchema:
    | Awaited<ReturnType<typeof assertReportAttestationSchema>>
    | undefined
  let uploadCleanup: UploadCleanup | undefined
  let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined

  try {
    pool = config.databaseUrl
      ? new Pool({
          connectionString: config.databaseUrl,
          application_name: 'daejang-web-api',
          max: 10,
          statement_timeout: 10_000,
        })
      : undefined
    engineClient = config.engineMtls
      ? await EngineMtlsClient.connect(
          config.engineMtls,
          config.upbitPdfImportEnabled,
        )
      : config.engineInsecureTarget
        ? EngineMtlsClient.connectInsecureLoopback(
            config.engineInsecureTarget,
            config.upbitPdfImportEnabled,
          )
        : undefined

    if (config.reportAttestationSyntheticTestnet && !pool) {
      throw new Error(
        'DATABASE_URL is required for GIWA report attestation writes',
      )
    }
    if (pool) {
      await assertWebAuthSchema(pool)
      await assertTaxReportSchema(pool)
      if (config.reportPayments) {
        await assertReportPaymentSchema(pool)
      }
      if (config.reportAttestationSyntheticTestnet) {
        reportAttestationSchema =
          await assertReportAttestationSchema(pool)
      }
    }
    if (config.privateObjectRoot) {
      await assertPrivateObjectRoot(config.privateObjectRoot)
    }

    const uploadStore =
      pool && config.privateObjectRoot
        ? new PostgresFileUploadStore(
            pool,
            config.privateObjectRoot,
            config.privateObjectEncryptionKey
              ? {
                  encryptionKey:
                    config.privateObjectEncryptionKey,
                  ...(config.privateObjectEncryptionKeyId
                    ? {
                        encryptionKeyId:
                          config.privateObjectEncryptionKeyId,
                      }
                    : {}),
                  ...(config.privateObjectDecryptionKeys
                    ? {
                        decryptionKeys:
                          config.privateObjectDecryptionKeys,
                      }
                    : {}),
                  ...(config.privateObjectLegacyKeyId
                    ? {
                        legacyKeyId:
                          config.privateObjectLegacyKeyId,
                      }
                    : {}),
                }
              : {},
          )
        : undefined
    const taxReportReader = pool
      ? new PostgresTaxReportReader(pool)
      : undefined
    const reportAttestationDeploymentReader =
      config.reportAttestationDeployment
        ? new HttpReportAttestationDeploymentReader(
            config.reportAttestationDeployment,
          )
        : undefined

    if (
      pool &&
      config.reportAttestationDeployment &&
      config.reportAttestationSyntheticTestnet
    ) {
      giwaRuntime =
        await createGiwaSepoliaReportAttestationServerRuntime({
          pool,
          deployment: config.reportAttestationDeployment,
          writer: config.reportAttestationSyntheticTestnet,
        })
    }

    const context = await buildApp({
      config,
      ...(config.emailAuth.enabled
        ? {
            verificationEmailSender:
              new ResendVerificationEmailSender(
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
                  reportPaymentTaxReportReader:
                    taxReportReader,
                  reportPaymentStore:
                    new PostgresReportPaymentStore(pool),
                  reportPaymentFacilitator:
                    new HttpReportPaymentFacilitator(
                      config.reportPayments.facilitatorUrl,
                    ),
                }
              : {}),
            ...(engineClient
              ? {
                  walletSourceStore:
                    new PostgresWalletSourceStore(
                      pool,
                      engineClient,
                    ),
                  engineDataClient: engineClient,
                }
              : {}),
            ...(uploadStore ? { uploadStore } : {}),
          }
        : {}),
      ...(giwaRuntime
        ? {
            reportAttestations: {
              runtime: giwaRuntime.runtime,
              reviewOutcome: giwaRuntime.reviewOutcome,
              store: giwaRuntime.store,
              identityKey: giwaRuntime.identityKey,
              publicationSource:
                giwaRuntime.publicationSource,
              reconciliationEnabled:
                reportAttestationSchema
                  ?.reconciliationEnabled === true,
            },
          }
        : {}),
      ...(reportAttestationDeploymentReader
        ? { reportAttestationDeploymentReader }
        : {}),
      ...(engineClient
        ? { taxReportModelReader: engineClient }
        : {}),
      ...(pool
        ? {
            readinessCheck: async () => {
              const checks: Promise<unknown>[] = [
                pool?.query('SELECT 1') ??
                  Promise.reject(
                    new Error('Database pool is unavailable'),
                  ),
              ]
              if (config.privateObjectRoot) {
                checks.push(
                  assertPrivateObjectRoot(
                    config.privateObjectRoot,
                  ),
                )
              }
              if (giwaRuntime) {
                checks.push(giwaRuntime.readiness())
              }
              if (
                config.reportAttestationSyntheticTestnet &&
                config.reportAttestationDeployment &&
                reportAttestationDeploymentReader
              ) {
                checks.push(
                  reportAttestationDeploymentReader
                    .read()
                    .then((snapshot) => {
                      const assessment =
                        assessReportAttestationDeploymentSnapshot(
                          config.reportAttestationDeployment as NonNullable<
                            typeof config.reportAttestationDeployment
                          >,
                          snapshot,
                        )
                      if (assessment.status !== 'CONNECTED') {
                        throw new Error(
                          assessment.reasonCode ??
                            'GIWA_REPORT_DEPLOYMENT_NOT_CONNECTED',
                        )
                      }
                    }),
                )
              }
              await Promise.all(checks)
            },
          }
        : {}),
    })
    app = context.app

    app.addHook('onClose', async () => {
      await context.reportAttestationService?.close()
      await uploadCleanup?.stop()
      engineClient?.close()
      await pool?.end()
    })

    await giwaRuntime?.preflight()

    uploadCleanup = uploadStore
      ? startUploadCleanup({
          store: uploadStore,
          onResult: (result) => {
            if (result.examined === 0) return
            app?.log.info(
              result,
              'abandoned upload cleanup completed',
            )
          },
          onError: (error) => {
            app?.log.error(
              {
                errorClass:
                  error instanceof Error
                    ? error.name
                    : 'non_error',
              },
              'abandoned upload cleanup failed',
            )
          },
        })
      : undefined

    let shutdownPromise: Promise<void> | undefined
    const shutdown = (signal: NodeJS.Signals) => {
      if (!shutdownPromise) {
        app?.log.info({ signal }, 'shutting down')
        shutdownPromise = (app?.close() ?? Promise.resolve())
          .catch((error: unknown) => {
            app?.log.error(error, 'shutdown failed')
            process.exitCode = 1
          })
      }
      return shutdownPromise
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))

    await app.listen({
      host: config.host,
      port: config.port,
    })
  } catch (error) {
    if (app) {
      try {
        await app.close()
      } catch {
        // The startup error below remains authoritative.
      }
    } else {
      try {
        await giwaRuntime?.close()
      } catch {
        // The startup error below remains authoritative.
      }
      engineClient?.close()
      try {
        await pool?.end()
      } catch {
        // The startup error below remains authoritative.
      }
    }
    throw error
  }
}

try {
  await start()
} catch (error) {
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : 'non-error startup failure'
  process.stderr.write(`web api startup failed: ${detail}\n`)
  process.exitCode = 1
}
