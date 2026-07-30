import { buildApp } from '../apps/web-api/src/app.js'
import { setSessionCookie } from '../apps/web-api/src/auth/auth-context.js'
import { loadConfig } from '../apps/web-api/src/config.js'
import { ApiError } from '../apps/web-api/src/errors.js'
import { loadLocalReportAttestationRuntime } from '../apps/web-api/src/report-attestations/local-runtime-adapter.js'
import type { ReportReviewOutcome } from '../apps/web-api/src/report-attestations/types.js'
import type { EngineDataClient } from '../apps/web-api/src/routes/data.js'
import type { TaxReportReader } from '../apps/web-api/src/tax-report/types.js'

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const reviewOutcome = process.env.GIWA28_REVIEW_OUTCOME
if (
  reviewOutcome !== 'APPROVE' &&
  reviewOutcome !== 'REJECT' &&
  reviewOutcome !== 'MANUAL_REVIEW'
) {
  throw new Error(
    'GIWA28_REVIEW_OUTCOME must be APPROVE, REJECT, or MANUAL_REVIEW',
  )
}

const demoUserId = process.env.GIWA28_DEMO_USER_ID
const demoDisplayName = process.env.GIWA28_DEMO_DISPLAY_NAME
if (!demoUserId || !userIdPattern.test(demoUserId)) {
  throw new Error('GIWA28_DEMO_USER_ID must be a UUID')
}
if (!demoDisplayName?.trim()) {
  throw new Error('GIWA28_DEMO_DISPLAY_NAME is required')
}

const config = loadConfig()
const publicOriginHostname = new URL(config.publicOrigin).hostname.toLowerCase()
if (
  config.runtimeMode !== 'development' ||
  !loopbackHosts.has(config.host.toLowerCase()) ||
  !loopbackHosts.has(publicOriginHostname)
) {
  throw new Error(
    'The GIWA-28 fixture server only runs in loopback development mode',
  )
}

const runtime = await loadLocalReportAttestationRuntime({
  runtimeMode: config.runtimeMode,
  reviewOutcome: reviewOutcome as ReportReviewOutcome,
})

const unavailableFixtureMethod = async (): Promise<never> => {
  throw new ApiError(
    503,
    'LOCAL_FIXTURE_METHOD_UNAVAILABLE',
    'GIWA-28 로컬 fixture에서 지원하지 않는 기능입니다.',
  )
}

const localReportFixtureEngine: EngineDataClient = {
  upbitPdfImportSupported: false,
  importUpbitDocument: unavailableFixtureMethod,
  listAllSources: async () => ({ wallets: [], documents: [] }),
  enqueueSync: unavailableFixtureMethod,
  getSyncJob: unavailableFixtureMethod,
  listSyncJobs: async () => [],
  getDashboard: unavailableFixtureMethod,
  listLedgerEvents: async () => [],
  listReviews: async () => ({ items: [], nextPageToken: '' }),
  getReview: unavailableFixtureMethod,
  resolveReview: unavailableFixtureMethod,
  createReport: unavailableFixtureMethod,
  listReports: async () => [],
  listTaxReportHistory: async () => [],
}

const emptyTaxReportReader: TaxReportReader = {
  durable: false,
  getCurrent: async () => undefined,
}

let context: Awaited<ReturnType<typeof buildApp>>
try {
  context = await buildApp({
    config,
    engineDataClient: localReportFixtureEngine,
    taxReportReader: emptyTaxReportReader,
    reportAttestations: {
      runtime,
      reviewOutcome: reviewOutcome as ReportReviewOutcome,
      localSyntheticFixture: true,
    },
  })
} catch (error) {
  await runtime.close().catch(() => undefined)
  throw error
}

const { app, sessionService } = context

app.post(
  '/api/v1/dev/report-attestation-session',
  {
    schema: {
      response: {
        201: {
          type: 'object',
          additionalProperties: false,
          required: ['user'],
          properties: {
            user: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'displayName'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                displayName: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    if (request.headers.origin !== config.publicOrigin) {
      throw new ApiError(
        403,
        'LOCAL_DEMO_ORIGIN_REJECTED',
        '로컬 데모 origin이 일치하지 않습니다.',
      )
    }

    const user = {
      id: demoUserId,
      displayName: demoDisplayName.trim(),
    }
    const created = await sessionService.create({ user })
    setSessionCookie(
      reply,
      created.token,
      created.session.absoluteExpiresAt,
      config,
    )
    return reply.status(201).send({ user })
  },
)

let closing = false
const shutdown = async (signal: NodeJS.Signals) => {
  if (closing) return
  closing = true
  app.log.info({ signal }, 'shutting down GIWA-28 local fixture server')
  await app.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error, 'GIWA-28 local fixture server failed to start')
  await app.close().catch(() => undefined)
  process.exit(1)
}
