import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, it } from 'vitest'

import { buildApp } from '../app.js'
import { PostgresAccountAuthStore } from '../auth/account-auth-store.js'
import { PostgresSessionStore } from '../auth/postgres-session-store.js'
import { PostgresRateLimitStore } from '../auth/rate-limit.js'
import type { AppConfig } from '../config.js'
import { EngineMtlsClient } from '../engine/mtls-client.js'
import { PostgresTaxReportReader } from '../tax-report/postgres-tax-report-reader.js'

const enabled = process.env.RUN_REVIEW_RESOLUTION_E2E_TESTS === '1'
const dockerHostEnabled = process.env.ALLOW_DOCKER_HOST_E2E === '1'
const e2eTimeoutMilliseconds = 360_000
const requestTimeoutMilliseconds = 10_000
const pollIntervalMilliseconds = 1_000
// The proof must be anchored on the chain the ReviewRoom under test targets.
// That is GIWA Sepolia for the published run, and a disposable local chain when
// the suite runs fully self-contained, so the expectation follows the target
// rather than assuming one.
const giwaSepoliaChainId = '91342'
const expectedAnchorChainId =
  process.env.REVIEW_E2E_ANCHOR_CHAIN_ID || giwaSepoliaChainId

const testAccount = {
  id: '00000000-0000-4000-8000-00000000e2e1',
  email: 'test@example.test',
  password: 'test1234!',
} as const

const requireEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for Review resolution E2E tests`)
  return value
}

const allowedHosts = () => {
  const result = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (dockerHostEnabled) result.add('host.docker.internal')
  return result
}

const disposableDatabaseUrl = (name: string) => {
  if (!enabled) return undefined
  const value = requireEnvironment(name)
  const url = new URL(value)
  const databaseName = decodeURIComponent(url.pathname.slice(1)).toLowerCase()
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !allowedHosts().has(url.hostname) ||
    !databaseName.includes('test')
  ) {
    throw new Error(`${name} must target an explicitly allowed disposable test database`)
  }
  return value
}

const engineUnixTarget = () => {
  if (!enabled) return undefined
  const value = requireEnvironment('TEST_ENGINE_GRPC_TARGET')
  const match = /^unix:(\/.+)$/.exec(value)
  const socketPath = match?.[1]
  if (!socketPath || socketPath === '/' || resolve(socketPath) !== socketPath) {
    throw new Error('TEST_ENGINE_GRPC_TARGET must be a normalized absolute Unix socket target')
  }
  return value
}

const reviewRoomOrigin = () => {
  if (!enabled) return undefined
  const value = requireEnvironment('REVIEWROOM_INTERNAL_API_URL')
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !allowedHosts().has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('REVIEWROOM_INTERNAL_API_URL must be an allowed loopback origin')
  }
  return url.origin
}

const ownerDatabaseUrl = disposableDatabaseUrl('TEST_DATABASE_URL')
const webDatabaseUrl = disposableDatabaseUrl('TEST_WEB_DATABASE_URL')
const engineTarget = engineUnixTarget()
const reviewRoomApiOrigin = reviewRoomOrigin()
const fixtureTaxYear = 2025 as const
const proofVectorToken = enabled
  ? requireEnvironment('REVIEWROOM_PROOF_VECTOR_TOKEN')
  : undefined
const e2eSubjectId = enabled ? requireEnvironment('DAEJANG_E2E_SUBJECT_ID') : undefined

if (enabled && e2eSubjectId !== testAccount.id) {
  throw new Error(`DAEJANG_E2E_SUBJECT_ID must be ${testAccount.id}`)
}
if (enabled && proofVectorToken!.length < 32) {
  throw new Error('REVIEWROOM_PROOF_VECTOR_TOKEN must contain at least 32 characters')
}

const describeWithReviewResolution = enabled ? describe : describe.skip

const config = (databaseUrl: string): AppConfig => ({
  runtimeMode: 'test',
  reportsUiMode: 'product',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1024 * 1024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl,
  rateLimitHmacSecret: 'review-resolution-e2e-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'review-resolution-e2e-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 2),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'review-resolution-e2e-email-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: false,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: false,
  engineMtls: undefined,
})

type Invariant = (condition: unknown, message: string) => asserts condition

const invariant: Invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const sleep = (milliseconds: number) =>
  new Promise<void>((complete) => setTimeout(complete, milliseconds))

const poll = async <T>(description: string, operation: () => Promise<T | undefined>) => {
  const deadline = Date.now() + e2eTimeoutMilliseconds
  while (Date.now() < deadline) {
    const result = await operation()
    if (result !== undefined) return result
    await sleep(Math.min(pollIntervalMilliseconds, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`${description} did not complete before the bounded E2E timeout`)
}

type ReviewDetail = {
  id: string
  revisionId: string
  pointerVersion: string
  status: string
  resolutionCode: string
  options: Array<{ code: string; requiresEvidence: boolean }>
}

type ResolutionResponse = {
  review: ReviewDetail
  replayed: boolean
}

type EventRow = {
  event_id: string
  subject_id: string
  review_id: string
  resolved_review_revision_id: string
  resolution_code: string
}

type ApplicationRow = {
  result: string
  application_fingerprint: string
  application_digest: string
  completion_fingerprint: string | null
  completion_digest: string | null
}

type DeliveryRow = {
  consumer: string
  state: string
  attempts: number
  lease_token: string | null
  lease_expires_at: Date | null
  delivered_at: Date | null
}

type ReviewRoomStatus = {
  proofReady: boolean
  reviewGateReady: boolean
  resolution: {
    eventId: string
    resolutionCode: string
    proof: { status: string; proofId?: string }
    anchor: {
      status: string
      chainId?: string
      transactionHash?: string
    }
  }
  applicationReceipts: Array<{
    status: string
    resultDigest: string
    resultingLedgerFingerprint?: string
  }>
}

type ProofVector = {
  schema: string
  complete: boolean
  verificationCheckpoint: { chainId: string }
  items: Array<{
    resolutionEventId: string
    proofCurrent: boolean
    applicationTerminal: boolean
    blockers: string[]
    proof?: { proofId: string }
    anchor?: { chainId: string; transactionHash: string }
    application?: {
      status: string
      resultDigest: string
      resultingLedgerFingerprint?: string
    }
  }>
}

type TaxReportGenerationStatus = {
  generationId: string | null
  state: string
  taxYear: number
  finality: string
  pointerVersion: number
  outcome: string | null
  completedAt: string | null
  blockedReasonCode: string | null
  hasCurrentReport: boolean
}

type CurrentTaxReport = {
  report: {
    reportId: string
    taxYear: number
    finality: string
    pointerVersion: number
  }
}

type TaxReportDetail = {
  report: {
    schemaVersion: string
    reportId: string
    evidencePackDigest: string
    taxYear: number
    status: string
    filingAction: string
    filingStatus: string
    reportFinality: string
    limitations: Array<{
      reviewId: string | null
      reviewRevisionId: string | null
    }>
    summary: {
      calculationRule: {
        basisAllocationRounding: string
      }
    }
    methodology: {
      taxInventoryRunId: string
      taxEstimateId: string
      lotRunId: string
      sourceLedgerGenerationId: string
      schemaDigest: string
    }
  }
}

type TaxEvidencePack = {
  evidencePack: {
    schemaVersion: string
    reportId: string
    artifactDigest: string
    taxYear: number
    methodology: TaxReportDetail['report']['methodology']
  }
}

type ReportBindingRow = {
  status_generation_id: string
  status_generation_pointer_version: string
  report_generation_id: string
  report_generation_pointer_version: string
  report_id: string
  report_pointer_version: string
  bound_report_pointer_version: string
}

describeWithReviewResolution('authenticated Review resolution E2E', () => {
  let ownerPool: Pool | undefined
  let webPool: Pool | undefined
  let engine: EngineMtlsClient | undefined
  let context: Awaited<ReturnType<typeof buildApp>> | undefined
  let sessionCookie = ''

  beforeAll(async () => {
    ownerPool = new Pool({ connectionString: ownerDatabaseUrl })
    webPool = new Pool({ connectionString: webDatabaseUrl })
    engine = EngineMtlsClient.connectInsecureLoopback(engineTarget!, false)
    await engine.waitForReady(10_000)
    const taxReportReader = new PostgresTaxReportReader(webPool)
    context = await buildApp({
      config: config(webDatabaseUrl!),
      logger: false,
      accountAuthStore: new PostgresAccountAuthStore(webPool),
      sessionStore: new PostgresSessionStore(webPool),
      rateLimitStore: new PostgresRateLimitStore(webPool),
      engineDataClient: engine,
      taxReportReader,
      taxReportGenerationStatusReader: taxReportReader,
      taxReportModelReader: engine,
      taxEvidencePackReader: engine,
    })

    const login = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: { origin: config(webDatabaseUrl!).publicOrigin },
      payload: { email: testAccount.email, password: testAccount.password },
    })
    invariant(login.statusCode === 200, 'Seeded E2E account login failed')
    const loginBody = login.json<{ status: string; user: { id: string } }>()
    invariant(
      loginBody.status === 'authenticated' && loginBody.user.id === testAccount.id,
      'Seeded E2E account identity did not match the disposable fixture',
    )
    const setCookie = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'][0]
      : login.headers['set-cookie']
    sessionCookie = setCookie?.split(';', 1)[0] ?? ''
    invariant(/^daejang_session=\S+$/.test(sessionCookie), 'Authenticated session cookie was not issued')
  }, 30_000)

  afterAll(async () => {
    await context?.app.close()
    engine?.close()
    await webPool?.end()
    await ownerPool?.end()
    sessionCookie = ''
  })

  const inject = (input: {
    method: 'GET' | 'POST'
    url: string
    payload?: Record<string, unknown>
  }) => context!.app.inject({
    method: input.method,
    url: input.url,
    headers: {
      cookie: sessionCookie,
      ...(input.method === 'POST' ? { origin: config(webDatabaseUrl!).publicOrigin } : {}),
    },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  })

  const ownAccountReview = async () => {
    let cursor = ''
    const seenCursors = new Set<string>()
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const query = new URLSearchParams({ taxYear: String(fixtureTaxYear), limit: '100' })
      if (cursor) query.set('cursor', cursor)
      const list = await inject({ method: 'GET', url: `/api/v1/reviews?${query.toString()}` })
      invariant(list.statusCode === 200, 'Authenticated Review list request failed')
      const page = list.json<{ items: Array<{ id: string }>; nextCursor?: string }>()
      invariant(Array.isArray(page.items), 'Authenticated Review list response was malformed')

      for (const item of page.items) {
        invariant(typeof item.id === 'string' && item.id !== '', 'Review list returned an invalid item')
        const response = await inject({
          method: 'GET',
          url: `/api/v1/reviews/${encodeURIComponent(item.id)}`,
        })
        invariant(response.statusCode === 200, 'Authenticated Review detail request failed')
        const detail = response.json<{ review: ReviewDetail }>().review
        if (
          detail.status === 'OPEN' &&
          detail.options.some((option) => option.code === 'OWN_ACCOUNT')
        ) {
          return detail
        }
      }

      const nextCursor = page.nextCursor ?? ''
      if (!nextCursor) break
      invariant(!seenCursors.has(nextCursor), 'Review pagination returned a cursor cycle')
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    throw new Error('No OPEN Review with the OWN_ACCOUNT option exists in the fixed 2025 fixture')
  }

  const reviewRoomJson = async (
    path: string,
    method: 'GET' | 'POST',
    payload?: Record<string, unknown>,
  ): Promise<{ status: number; body?: unknown } | undefined> => {
    try {
      const response = await fetch(new URL(path, `${reviewRoomApiOrigin!}/`), {
        method,
        headers: {
          authorization: `Bearer ${proofVectorToken!}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      })
      if (response.status !== 200) return { status: response.status }
      try {
        return { status: response.status, body: await response.json() }
      } catch {
        throw new Error('ReviewRoom returned a malformed JSON response')
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'ReviewRoom returned a malformed JSON response') {
        throw error
      }
      return undefined
    }
  }

  it('resolves a 2025 OWN_ACCOUNT Review, applies it, and verifies its GIWA proof vector', async () => {
    const openReview = await ownAccountReview()
    invariant(openReview.revisionId !== '', 'Review detail omitted its current revision')
    invariant(/^[1-9][0-9]*$/.test(openReview.pointerVersion), 'Review detail returned an invalid pointer')

    const initialGenerationResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${fixtureTaxYear}/status?finality=PROVISIONAL`,
    })
    invariant(initialGenerationResponse.statusCode === 200, 'Initial Tax generation status request failed')
    const initialGeneration = initialGenerationResponse
      .json<{ status: TaxReportGenerationStatus }>()
      .status
    invariant(
      initialGeneration.generationId !== null &&
      initialGeneration.state === 'REVIEW_REQUIRED' &&
      initialGeneration.taxYear === fixtureTaxYear &&
      initialGeneration.finality === 'PROVISIONAL' &&
      initialGeneration.pointerVersion >= 1 &&
      initialGeneration.outcome === 'REPORT' &&
      initialGeneration.completedAt !== null &&
      initialGeneration.blockedReasonCode === 'REVIEW_REQUIRED' &&
      initialGeneration.hasCurrentReport === true,
      'Initial provisional Tax report generation was not ready for Review resolution',
    )
    const initialCurrentResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${fixtureTaxYear}/current?finality=PROVISIONAL`,
    })
    invariant(initialCurrentResponse.statusCode === 200, 'Initial current Tax report request failed')
    const initialCurrent = initialCurrentResponse.json<CurrentTaxReport>().report
    invariant(
      initialCurrent.taxYear === fixtureTaxYear &&
      initialCurrent.finality === 'PROVISIONAL' &&
      initialCurrent.pointerVersion >= 1,
      'Initial current Tax report identity was inconsistent',
    )
    const initialDetailResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${encodeURIComponent(initialCurrent.reportId)}`,
    })
    invariant(initialDetailResponse.statusCode === 200, 'Initial Tax report detail request failed')
    const initialDetail = initialDetailResponse.json<TaxReportDetail>().report
    invariant(
      initialDetail.reportId === initialCurrent.reportId &&
      initialDetail.limitations.some((limitation) =>
        limitation.reviewId === openReview.id &&
        limitation.reviewRevisionId === openReview.revisionId),
      'Initial Tax report did not contain the OPEN Review limitation',
    )

    const stableIntentDigest = createHash('sha256')
      .update(`review-resolution-e2e\0${openReview.id}\0OWN_ACCOUNT`)
      .digest('hex')
    const resolutionPayload = {
      expectedRevisionId: openReview.revisionId,
      expectedPointerVersion: openReview.pointerVersion,
      resolutionCode: 'OWN_ACCOUNT',
      resolutionNote: 'Automated confirmation against disposable E2E data.',
      intentKey: `review-resolution-e2e:${stableIntentDigest}`,
    }
    const resolutionPath = `/api/v1/reviews/${encodeURIComponent(openReview.id)}/resolutions`

    const created = await inject({ method: 'POST', url: resolutionPath, payload: resolutionPayload })
    invariant(created.statusCode === 201, 'Initial Review resolution request did not create a revision')
    const createdBody = created.json<ResolutionResponse>()
    invariant(!createdBody.replayed, 'Initial Review resolution was unexpectedly reported as a replay')
    invariant(
      createdBody.review.id === openReview.id &&
      createdBody.review.status === 'RESOLVED' &&
      createdBody.review.resolutionCode === 'OWN_ACCOUNT',
      'Initial Review resolution response was inconsistent',
    )

    const replay = await inject({ method: 'POST', url: resolutionPath, payload: resolutionPayload })
    invariant(replay.statusCode === 200, 'Exact Review resolution replay did not return HTTP 200')
    const replayBody = replay.json<ResolutionResponse>()
    invariant(replayBody.replayed, 'Exact Review resolution was not reported as a replay')
    invariant(
      replayBody.review.revisionId === createdBody.review.revisionId &&
      replayBody.review.pointerVersion === createdBody.review.pointerVersion,
      'Exact Review resolution replay changed immutable revision identity',
    )

    let eventRows
    try {
      eventRows = await ownerPool!.query<EventRow>(
        `SELECT event_id,subject_id,review_id,resolved_review_revision_id,resolution_code
         FROM review.resolution_event_v2
         WHERE subject_id=$1 AND review_id=$2 AND resolved_review_revision_id=$3`,
        [testAccount.id, openReview.id, createdBody.review.revisionId],
      )
    } catch {
      throw new Error('Central Review resolution event lookup failed')
    }
    invariant(eventRows.rows.length === 1, 'Central DB did not contain exactly one Review resolution event')
    const event = eventRows.rows[0]!
    invariant(
      event.subject_id === testAccount.id &&
      event.review_id === openReview.id &&
      event.resolved_review_revision_id === createdBody.review.revisionId &&
      event.resolution_code === 'OWN_ACCOUNT',
      'Central Review resolution event identity was inconsistent',
    )

    const durable = await poll('Review resolution application and delivery', async () => {
      try {
        const [application, deliveries] = await Promise.all([
          ownerPool!.query<ApplicationRow>(
            `SELECT application.result,
                    application.resulting_ledger_fingerprint::text AS application_fingerprint,
                    application.result_digest::text AS application_digest,
                    completion.resulting_ledger_fingerprint::text AS completion_fingerprint,
                    completion.result_digest::text AS completion_digest
             FROM review.resolution_application_v2 AS application
             LEFT JOIN review.resolution_application_completion_v2 AS completion
               ON completion.event_id=application.event_id
             WHERE application.event_id=$1`,
            [event.event_id],
          ),
          ownerPool!.query<DeliveryRow>(
            `SELECT consumer,state,attempts,lease_token,lease_expires_at,delivered_at
             FROM review.resolution_delivery_v2
             WHERE event_id=$1
             ORDER BY consumer`,
            [event.event_id],
          ),
        ])
        if (
          application.rows.length !== 1 ||
          application.rows[0]!.completion_digest === null ||
          deliveries.rows.length !== 2 ||
          deliveries.rows.some((delivery) => delivery.state !== 'DELIVERED')
        ) {
          return undefined
        }
        return { application: application.rows[0]!, deliveries: deliveries.rows }
      } catch {
        throw new Error('Central Review application polling failed')
      }
    })

    const application = durable.application
    invariant(application.result === 'NO_OP', 'OWN_ACCOUNT application did not produce NO_OP')
    invariant(
      /^[0-9a-f]{64}$/.test(application.application_fingerprint) &&
      /^[0-9a-f]{64}$/.test(application.application_digest),
      'Application digest or fingerprint was malformed',
    )
    const expectedApplicationDigest = createHash('sha256')
      .update(`${event.event_id}\n${testAccount.id}\nNO_OP\n${application.application_fingerprint}`)
      .digest('hex')
    invariant(
      application.application_digest === expectedApplicationDigest &&
      application.completion_digest === application.application_digest &&
      application.completion_fingerprint === application.application_fingerprint,
      'Application and completion digest/fingerprint identities were inconsistent',
    )
    invariant(
      durable.deliveries.map((delivery) => delivery.consumer).join(',') ===
        'APPLICATION_ENGINE,REVIEWROOM' &&
      durable.deliveries.every((delivery) =>
        delivery.attempts >= 1 &&
        delivery.lease_token === null &&
        delivery.lease_expires_at === null &&
        delivery.delivered_at !== null),
      'Review delivery terminal state was inconsistent',
    )

    const reportGeneration = await poll<TaxReportGenerationStatus>(
      'post-Review Tax report generation outcome',
      async () => {
        const response = await inject({
          method: 'GET',
          url: `/api/v1/tax-reports/${fixtureTaxYear}/status?finality=PROVISIONAL`,
        })
        invariant(response.statusCode === 200, 'Tax report generation status request failed')
        const status = response.json<{ status: TaxReportGenerationStatus }>().status
        if (
          status.state === 'BUILDING' ||
          status.blockedReasonCode === 'APPLICATION_PENDING' ||
          status.generationId === initialGeneration.generationId ||
          status.pointerVersion <= initialGeneration.pointerVersion
        ) {
          return undefined
        }
        return status
      },
    )
    invariant(
      reportGeneration.generationId !== null &&
      reportGeneration.state === 'REVIEW_REQUIRED' &&
      reportGeneration.taxYear === fixtureTaxYear &&
      reportGeneration.finality === 'PROVISIONAL' &&
      reportGeneration.pointerVersion > initialGeneration.pointerVersion &&
      reportGeneration.outcome === 'REPORT' &&
      reportGeneration.completedAt !== null &&
      reportGeneration.blockedReasonCode === 'REVIEW_REQUIRED' &&
      reportGeneration.hasCurrentReport === true,
      `Post-Review Tax generation did not publish the expected provisional report: ${JSON.stringify({
        generationId: reportGeneration.generationId,
        state: reportGeneration.state,
        taxYear: reportGeneration.taxYear,
        finality: reportGeneration.finality,
        pointerVersion: reportGeneration.pointerVersion,
        outcome: reportGeneration.outcome,
        completedAt: reportGeneration.completedAt,
        blockedReasonCode: reportGeneration.blockedReasonCode,
        hasCurrentReport: reportGeneration.hasCurrentReport,
      })}`,
    )
    const currentReport = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${fixtureTaxYear}/current?finality=PROVISIONAL`,
    })
    invariant(
      currentReport.statusCode === 200,
      'Post-Review provisional Tax report was not exposed as current',
    )
    const current = currentReport.json<CurrentTaxReport>().report
    invariant(
      current.reportId !== initialCurrent.reportId &&
      current.taxYear === fixtureTaxYear &&
      current.finality === 'PROVISIONAL' &&
      current.pointerVersion > initialCurrent.pointerVersion,
      'Post-Review current Tax report did not advance from the pre-Review report',
    )

    const detailResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${encodeURIComponent(current.reportId)}`,
    })
    invariant(detailResponse.statusCode === 200, 'Post-Review Tax report detail request failed')
    const detail = detailResponse.json<TaxReportDetail>().report
    const expectedFilingAction = 'FILING_NOT_APPLICABLE'
    const hasResolvedReviewLimitation = detail.limitations.some((limitation) =>
      limitation.reviewId === openReview.id)
    invariant(
      detail.schemaVersion === 'giwa.tax-report-model.v2' &&
      detail.reportId === current.reportId &&
      detail.taxYear === fixtureTaxYear &&
      detail.status === 'PARTIAL' &&
      detail.filingAction === expectedFilingAction &&
      detail.filingStatus === 'BLOCKED' &&
      detail.reportFinality === 'PROVISIONAL' &&
      detail.summary.calculationRule.basisAllocationRounding ===
        'CUMULATIVE_FLOOR_ANNUAL_POOL' &&
      !hasResolvedReviewLimitation,
      `Post-Review Tax report detail did not reflect the resolved Review: ${JSON.stringify({
        schemaVersion: detail.schemaVersion,
        reportIdentityMatches: detail.reportId === current.reportId,
        taxYear: detail.taxYear,
        status: detail.status,
        filingAction: detail.filingAction,
        filingStatus: detail.filingStatus,
        reportFinality: detail.reportFinality,
        basisAllocationRounding: detail.summary.calculationRule.basisAllocationRounding,
        limitationCount: detail.limitations.length,
        hasResolvedReviewLimitation,
      })}`,
    )

    const evidenceResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${encodeURIComponent(current.reportId)}/evidence`,
    })
    invariant(evidenceResponse.statusCode === 200, 'Post-Review EvidencePack request failed')
    const evidence = evidenceResponse.json<TaxEvidencePack>().evidencePack
    invariant(
      evidence.schemaVersion === 'giwa.tax-evidence-pack.v2' &&
      evidence.reportId === current.reportId &&
      evidence.artifactDigest === detail.evidencePackDigest &&
      evidence.taxYear === fixtureTaxYear &&
      evidence.methodology.taxInventoryRunId === detail.methodology.taxInventoryRunId &&
      evidence.methodology.taxEstimateId === detail.methodology.taxEstimateId &&
      evidence.methodology.lotRunId === detail.methodology.lotRunId &&
      evidence.methodology.sourceLedgerGenerationId ===
        detail.methodology.sourceLedgerGenerationId &&
      evidence.methodology.schemaDigest === detail.methodology.schemaDigest &&
      !evidenceResponse.body.includes('subjectId') &&
      !evidenceResponse.body.includes('residentId'),
      'Post-Review EvidencePack did not match the Tax report decision roots',
    )

    const pdfResponse = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${encodeURIComponent(current.reportId)}/artifacts/pdf`,
    })
    const pdfSha256 = createHash('sha256').update(pdfResponse.rawPayload).digest('hex')
    const expectedFilePrefix = 'daejang-tax-simulation'
    const safeReportId = current.reportId
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 96)
    invariant(
      pdfResponse.statusCode === 200 &&
      pdfResponse.headers['content-type'] === 'application/pdf' &&
      pdfResponse.rawPayload.subarray(0, 5).toString('ascii') === '%PDF-' &&
      pdfResponse.rawPayload.byteLength > 15_000 &&
      pdfResponse.headers['content-length'] === String(pdfResponse.rawPayload.byteLength) &&
      pdfResponse.headers['x-report-id'] === current.reportId &&
      pdfResponse.headers.etag === `"sha256-${pdfSha256}"` &&
      String(pdfResponse.headers['content-disposition']).includes(
        `${expectedFilePrefix}-${fixtureTaxYear}-${safeReportId}.pdf`,
      ),
      'Post-Review rendered PDF or its integrity headers were inconsistent',
    )

    const binding = await ownerPool!.query<ReportBindingRow>(
      `SELECT status.generation_id AS status_generation_id,
              status.pointer_version::text AS status_generation_pointer_version,
              current.generation_id AS report_generation_id,
              current.generation_pointer_version::text AS report_generation_pointer_version,
              current.report_id,
              current.pointer_version::text AS report_pointer_version,
              current.bound_report_pointer_version::text AS bound_report_pointer_version
       FROM reporting.current_tax_report_generation_status_read_v2 AS status
       JOIN reporting.current_tax_report_read_v2 AS current
         ON current.subject_id=status.subject_id
        AND current.resident_id=status.resident_id
        AND current.tax_year=status.tax_year
        AND current.finality=status.finality
        AND current.generation_id=status.generation_id
       WHERE status.subject_id=$1 AND status.tax_year=$2 AND status.finality='PROVISIONAL'`,
      [testAccount.id, fixtureTaxYear],
    )
    invariant(binding.rows.length === 1, 'Post-Review generation/report binding was not unique')
    const bound = binding.rows[0]!
    invariant(
      bound.status_generation_id === reportGeneration.generationId &&
      Number(bound.status_generation_pointer_version) === reportGeneration.pointerVersion &&
      bound.report_generation_id === reportGeneration.generationId &&
      Number(bound.report_generation_pointer_version) === reportGeneration.pointerVersion &&
      bound.report_id === current.reportId &&
      Number(bound.report_pointer_version) === current.pointerVersion &&
      Number(bound.bound_report_pointer_version) === current.pointerVersion,
      'Post-Review current Report was not atomically bound to the observed generation',
    )

    const [stableGenerationResponse, stableCurrentResponse] = await Promise.all([
      inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${fixtureTaxYear}/status?finality=PROVISIONAL`,
      }),
      inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${fixtureTaxYear}/current?finality=PROVISIONAL`,
      }),
    ])
    invariant(
      stableGenerationResponse.statusCode === 200 &&
      stableCurrentResponse.statusCode === 200,
      'Post-Review stable report fence could not reread the current scope',
    )
    const stableGeneration = stableGenerationResponse
      .json<{ status: TaxReportGenerationStatus }>()
      .status
    const stableCurrent = stableCurrentResponse.json<CurrentTaxReport>().report
    invariant(
      stableGeneration.generationId === reportGeneration.generationId &&
      stableGeneration.pointerVersion === reportGeneration.pointerVersion &&
      stableCurrent.reportId === current.reportId &&
      stableCurrent.pointerVersion === current.pointerVersion,
      'Post-Review report scope changed while its detail, evidence, or PDF was read',
    )

    const statusPath = `/internal/v2/review-resolutions/${encodeURIComponent(event.event_id)}`
    const status = await poll<ReviewRoomStatus>('ReviewRoom canonical status', async () => {
      const response = await reviewRoomJson(statusPath, 'GET')
      if (response === undefined || [404, 429, 500, 502, 503, 504].includes(response.status)) {
        return undefined
      }
      invariant(response.status === 200, 'ReviewRoom canonical status request was rejected')
      const body = response.body as ReviewRoomStatus
      if (body.proofReady !== true || body.reviewGateReady !== true) return undefined
      return body
    })
    invariant(
      status.resolution.eventId === event.event_id &&
      status.resolution.resolutionCode === 'OWN_ACCOUNT' &&
      status.resolution.proof.status === 'ANCHORED' &&
      status.resolution.anchor.status === 'CONFIRMED' &&
      status.resolution.anchor.chainId === expectedAnchorChainId,
      `ReviewRoom canonical status was not anchored on chain ${expectedAnchorChainId}`,
    )
    invariant(
      status.applicationReceipts.some((receipt) =>
        receipt.status === 'NO_OP' &&
        receipt.resultDigest === `0x${application.application_digest}` &&
        receipt.resultingLedgerFingerprint === `0x${application.application_fingerprint}`),
      'ReviewRoom canonical status did not contain the matching NO_OP receipt',
    )

    const vector = await poll<ProofVector>('GIWA Review proof vector', async () => {
      const response = await reviewRoomJson(
        '/internal/v2/review-proof-vectors/verify',
        'POST',
        {
          schema: 'daejang.review-proof-vector-request/v1',
          resolutionEventIds: [event.event_id],
        },
      )
      if (response === undefined || [429, 500, 502, 503, 504].includes(response.status)) {
        return undefined
      }
      invariant(response.status === 200, 'ReviewRoom proof-vector request was rejected')
      const body = response.body as ProofVector
      return body.complete === true ? body : undefined
    })

    invariant(
      vector.schema === 'daejang.review-proof-vector/v1' &&
      vector.complete === true &&
      vector.verificationCheckpoint.chainId === expectedAnchorChainId &&
      vector.items.length === 1,
      `ReviewRoom proof vector did not complete on chain ${expectedAnchorChainId}`,
    )
    const vectorItem = vector.items[0]!
    invariant(
      vectorItem.resolutionEventId === event.event_id &&
      vectorItem.proofCurrent === true &&
      vectorItem.applicationTerminal === true &&
      vectorItem.blockers.length === 0,
      'ReviewRoom proof-vector item was incomplete',
    )
    invariant(
      vectorItem.application?.status === 'NO_OP' &&
      vectorItem.application.resultDigest === `0x${application.application_digest}` &&
      vectorItem.application.resultingLedgerFingerprint === `0x${application.application_fingerprint}`,
      'ReviewRoom proof-vector application did not match the central DB result',
    )
    const vectorAnchor = vectorItem.anchor
    const vectorProof = vectorItem.proof
    invariant(
      vectorAnchor !== undefined &&
      vectorProof !== undefined &&
      vectorAnchor.chainId === expectedAnchorChainId &&
      /^0x[0-9a-fA-F]{64}$/.test(vectorAnchor.transactionHash) &&
      vectorAnchor.transactionHash === status.resolution.anchor.transactionHash &&
      /^0x[0-9a-fA-F]{64}$/.test(vectorProof.proofId) &&
      vectorProof.proofId === status.resolution.proof.proofId,
      'ReviewRoom proof-vector chain receipt did not match canonical status',
    )

    process.stdout.write(`GIWA_REVIEW_E2E_RESULT ${JSON.stringify({
      chainId: vectorAnchor.chainId,
      reportGenerationId: reportGeneration.generationId,
      reportId: current.reportId,
      reportPointerVersion: current.pointerVersion,
      reportPdfSha256: pdfSha256,
      proofId: vectorProof.proofId,
      taxYear: fixtureTaxYear,
      transactionHash: vectorAnchor.transactionHash,
    })}\n`)
  }, e2eTimeoutMilliseconds + 60_000)
})
