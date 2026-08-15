import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Wallet } from 'ethers'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { PostgresAccountAuthStore } from '../auth/account-auth-store.js'
import { PostgresSessionStore } from '../auth/postgres-session-store.js'
import { PostgresRateLimitStore } from '../auth/rate-limit.js'
import type { AppConfig } from '../config.js'
import { EngineMtlsClient } from '../engine/mtls-client.js'
import { PostgresFileUploadStore } from '../uploads/postgres-file-upload-store.js'
import { PostgresTaxReportReader } from '../tax-report/postgres-tax-report-reader.js'
import { PostgresWalletSourceStore } from './postgres-wallet-source-store.js'

const enabled = process.env.RUN_SOURCE_PIPELINE_E2E_TESTS === '1'
const dockerHostEnabled = process.env.ALLOW_DOCKER_HOST_E2E === '1'

const disposableDatabaseUrl = (name: string) => {
  const value = process.env[name]
  if (!enabled) return undefined
  if (!value) throw new Error(`${name} is required for source pipeline E2E tests`)
  const url = new URL(value)
  const databaseName = decodeURIComponent(url.pathname.slice(1)).toLowerCase()
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (dockerHostEnabled) allowedHosts.add('host.docker.internal')
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !allowedHosts.has(url.hostname) ||
    !databaseName.includes('test')
  ) {
    throw new Error(`${name} must target an explicitly allowed disposable test database`)
  }
  return value
}

const ownerDatabaseUrl = disposableDatabaseUrl('TEST_DATABASE_URL')
const webDatabaseUrl = disposableDatabaseUrl('TEST_WEB_DATABASE_URL')
const engineTarget = enabled ? process.env.TEST_ENGINE_GRPC_TARGET : undefined
if (enabled && !engineTarget) {
  throw new Error('TEST_ENGINE_GRPC_TARGET is required for source pipeline E2E tests')
}

const describeWithPipeline = enabled ? describe : describe.skip
const fixturePassword = 'synthetic-pdf-password-do-not-persist'
const testAccount = {
  id: '00000000-0000-4000-8000-00000000e2e1',
  email: 'test@example.test',
  password: 'test1234!',
} as const
const e2eSubjectId = process.env.DAEJANG_E2E_SUBJECT_ID
if (enabled && e2eSubjectId !== testAccount.id) {
  throw new Error(`DAEJANG_E2E_SUBJECT_ID must be ${testAccount.id}`)
}

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
  bodyLimitBytes: 21 * 1024 * 1024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl,
  rateLimitHmacSecret: 'source-pipeline-e2e-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'source-pipeline-e2e-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'source-pipeline-e2e-email-secret',
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
  upbitPdfImportEnabled: true,
  engineMtls: undefined,
})

describeWithPipeline('wallet and Upbit PDF source pipeline E2E', () => {
  const userId = testAccount.id
  const ownerPool = new Pool({ connectionString: ownerDatabaseUrl })
  const webPool = new Pool({ connectionString: webDatabaseUrl })
  const objectEncryptionKey = Buffer.alloc(32, 7)
  let objectRoot: string
  let engine: EngineMtlsClient
  let context: Awaited<ReturnType<typeof buildApp>>
  let sessionCookie: string

  beforeAll(async () => {
    objectRoot = await mkdtemp(join(tmpdir(), 'daejang-source-pipeline-e2e-'))
    engine = EngineMtlsClient.connectInsecureLoopback(engineTarget!, true)
    await engine.waitForReady(10_000)
    context = await buildApp({
      config: config(webDatabaseUrl!),
      logger: false,
      accountAuthStore: new PostgresAccountAuthStore(webPool),
      sessionStore: new PostgresSessionStore(webPool),
      rateLimitStore: new PostgresRateLimitStore(webPool),
      walletSourceStore: new PostgresWalletSourceStore(webPool, engine),
      uploadStore: new PostgresFileUploadStore(webPool, objectRoot, {
        encryptionKey: objectEncryptionKey,
        encryptionKeyId: 'source-pipeline-e2e',
      }),
      taxReportReader: new PostgresTaxReportReader(webPool),
      taxReportModelReader: engine,
      taxEvidencePackReader: engine,
      engineDataClient: engine,
    })
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: { origin: config(webDatabaseUrl!).publicOrigin },
      payload: { email: testAccount.email, password: testAccount.password },
    })
    expect(login.statusCode, login.body).toBe(200)
    expect(login.json()).toMatchObject({
      status: 'authenticated',
      user: { id: userId, displayName: 'Daejang E2E' },
    })
    const setCookie = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'][0]
      : login.headers['set-cookie']
    sessionCookie = setCookie?.split(';', 1)[0] ?? ''
    expect(sessionCookie).toMatch(/^daejang_session=\S+$/)
  }, 30_000)

  afterAll(async () => {
    await context?.app.close()
    engine?.close()
    await webPool.end()
    await ownerPool.end()
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true })
    objectEncryptionKey.fill(0)
  })

  const inject = (input: {
    method: 'GET' | 'POST' | 'PUT'
    url: string
    payload?: Buffer | Record<string, unknown>
    contentType?: string
  }) => context.app.inject({
    method: input.method,
    url: input.url,
    headers: {
      cookie: sessionCookie,
      ...(input.method === 'GET' ? {} : { origin: config(webDatabaseUrl!).publicOrigin }),
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
      ...(Buffer.isBuffer(input.payload)
        ? { 'content-length': String(input.payload.byteLength) }
        : {}),
    },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  })

  it('persists a signed wallet through HTTP, Web PostgreSQL, Engine, and source PostgreSQL', async () => {
    const wallet = Wallet.createRandom()
    const challengeResponse = await inject({
      method: 'POST',
      url: '/api/v1/sources/wallets/challenges',
      payload: { address: wallet.address, chainId: 'eip155:1' },
    })
    expect(challengeResponse.statusCode).toBe(201)
    const challenge = challengeResponse.json<{ challengeId: string; message: string }>()

    const registration = await inject({
      method: 'POST',
      url: '/api/v1/sources/wallets',
      payload: {
        challengeId: challenge.challengeId,
        signature: await wallet.signMessage(challenge.message),
        chainIds: ['eip155:1', 'eip155:10'],
        label: 'E2E wallet',
      },
    })
    expect(registration.statusCode).toBe(201)
    const source = registration.json<{ id: string; address: string }>()
    expect(source.address).toBe(wallet.address.toLowerCase())

    const durable = await ownerPool.query<{
      address: string
      status: string
      consumed_at: Date | null
      chain_ids: string[]
    }>(
      `SELECT wallet.address,wallet.status,challenge.consumed_at,
        ARRAY_AGG(scope.chain_id ORDER BY scope.chain_id)::text[] AS chain_ids
       FROM source_private.wallet_sources AS wallet
       JOIN source_private.wallet_chain_scopes AS scope ON scope.wallet_source_id=wallet.id
       JOIN web_private.wallet_ownership_challenges AS challenge
         ON challenge.id=$2::uuid AND challenge.user_id=wallet.user_id
       WHERE wallet.id=$1::uuid AND wallet.user_id=$3::uuid
       GROUP BY wallet.address,wallet.status,challenge.consumed_at`,
      [source.id, challenge.challengeId, userId],
    )
    expect(durable.rows[0]).toMatchObject({
      address: wallet.address.toLowerCase(),
      status: 'ACTIVE',
      chain_ids: ['eip155:1', 'eip155:10'],
    })
    expect(durable.rows[0]?.consumed_at).toBeInstanceOf(Date)

    const list = await inject({ method: 'GET', url: '/api/v1/sources' })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({
      items: [expect.objectContaining({ id: source.id, status: 'ACTIVE' })],
    })

    const syncIntentKey = randomUUID()
    const queued = await inject({
      method: 'POST',
      url: '/api/v1/syncs',
      payload: {
        sourceKind: 'EVM_WALLET',
        sourceId: source.id,
        coverageStart: '2026-07-28',
        coverageEnd: '2026-07-28',
        trigger: 'USER_REQUEST',
        intentKey: syncIntentKey,
      },
    })
    expect(queued.statusCode, queued.body).toBe(201)
    const { job } = queued.json<{
      job: {
        id: string
        phase: string
        requestedCoverageEnd: string
        requestedCoverageStart: string
        sourceId: string
        sourceKind: string
        state: string
        trigger: string
      }
    }>()
    expect(job).toMatchObject({
      phase: 'VALIDATE_SOURCE',
      requestedCoverageEnd: '2026-07-28',
      requestedCoverageStart: '2026-07-28',
      sourceId: source.id,
      sourceKind: 'EVM_WALLET',
      state: 'QUEUED',
      trigger: 'USER_REQUEST',
    })

    const durableJob = await ownerPool.query<{
      phase: string
      requested_coverage_end: string
      requested_coverage_start: string
      source_id: string
      source_kind: string
      state: string
      trigger_kind: string
    }>(
      `SELECT source_id::text,source_kind,state,phase,
        requested_coverage_start::text,requested_coverage_end::text,trigger_kind
       FROM source_private.sync_jobs
       WHERE id=$1::uuid AND user_id=$2::uuid AND idempotency_key=$3`,
      [job.id, userId, syncIntentKey],
    )
    expect(durableJob.rows[0]).toEqual({
      phase: 'VALIDATE_SOURCE',
      requested_coverage_end: '2026-07-28',
      requested_coverage_start: '2026-07-28',
      source_id: source.id,
      source_kind: 'EVM_WALLET',
      state: 'QUEUED',
      trigger_kind: 'USER_REQUEST',
    })

    const replay = await inject({
      method: 'POST',
      url: '/api/v1/sources/wallets',
      payload: {
        challengeId: challenge.challengeId,
        signature: await wallet.signMessage(challenge.message),
        chainIds: ['eip155:1'],
      },
    })
    expect(replay.statusCode).toBe(409)
  })

  it('persists an encrypted upload through the real PDF parser, artifacts, evidence, and source job DB', async () => {
    const fixturePath = resolve(
      process.cwd(),
      '../../services/engine/internal/pdfparser/testdata/synthetic_upbit_trade.encrypted.pdf.b64',
    )
    const pdf = Buffer.from((await readFile(fixturePath, 'utf8')).trim(), 'base64')
    const create = await inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: {
        filename: 'synthetic-upbit-trade.pdf',
        mediaType: 'application/pdf',
        sizeBytes: pdf.byteLength,
        intentKey: randomUUID(),
      },
    })
    expect(create.statusCode).toBe(201)
    const { uploadId } = create.json<{ uploadId: string }>()

    const upload = await inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/content`,
      contentType: 'application/pdf',
      payload: Buffer.from(pdf),
    })
    expect(upload.statusCode).toBe(204)

    const uploadRow = await ownerPool.query<{ object_key: string }>(
      'SELECT object_key FROM web_private.upload_sessions WHERE id=$1::uuid',
      [uploadId],
    )
    const stored = await readFile(join(objectRoot, uploadRow.rows[0]!.object_key))
    expect(stored.subarray(0, 8).toString()).toBe('GIWAOBJ2')
    expect(stored.includes(Buffer.from('%PDF-'))).toBe(false)

    const passwordEnvelope = Buffer.concat([
      Buffer.from([1]),
      Buffer.from(fixturePassword),
    ])
    const imported = await inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/import?coverageStart=2026-01-01&coverageEnd=2026-12-31`,
      contentType: 'application/octet-stream',
      payload: passwordEnvelope,
    })
    expect(imported.statusCode, imported.body).toBe(201)
    const result = imported.json<{
      source: { id: string; status: string }
      job: { id: string; state: string; phase: string; outputFragmentId: string }
      evidenceTerminalStatus: string
      sourceRecordCount: number
      normalizedRecordCount: number
    }>()
    expect(result).toMatchObject({
      source: { status: 'ACTIVE' },
      job: { state: 'SUCCEEDED', phase: 'COMPLETE' },
      evidenceTerminalStatus: 'PARTIAL',
      sourceRecordCount: 1,
    })
    expect(result.job.outputFragmentId).not.toBe('')

    const durable = await ownerPool.query<{
      upload_state: string
      source_status: string
      job_state: string
      phase: string
      output_fragment_id: string
      fragment_count: string
      artifact_count: string
    }>(
      `SELECT upload.state AS upload_state,document.status AS source_status,
        job.state AS job_state,job.phase,job.output_fragment_id,
        (SELECT COUNT(*)::text FROM subject_evidence.evidence_fragment fragment
          WHERE fragment.subject_id=$1::text AND fragment.fragment_id=job.output_fragment_id) AS fragment_count,
        (SELECT COUNT(*)::text FROM artifact.artifact_object artifact
          WHERE artifact.privacy_class='SUBJECT_PRIVATE') AS artifact_count
       FROM web_private.upload_sessions AS upload
       JOIN source_private.document_sources AS document ON document.upload_id=upload.id
       JOIN source_private.sync_jobs AS job ON job.source_id=document.id
       WHERE upload.id=$2::uuid AND upload.user_id=$1::uuid`,
      [userId, uploadId],
    )
    expect(durable.rows[0]).toMatchObject({
      upload_state: 'CONFIRMED',
      source_status: 'ACTIVE',
      job_state: 'SUCCEEDED',
      phase: 'COMPLETE',
      output_fragment_id: result.job.outputFragmentId,
      fragment_count: '1',
    })
    expect(Number(durable.rows[0]?.artifact_count)).toBeGreaterThanOrEqual(3)

    const requestContext = {
      requestId: randomUUID(),
      userId,
      sessionId: 'source-pipeline-e2e',
    }
    const listed = await engine.listAllSources(requestContext)
    expect(listed.documents).toContainEqual(
      expect.objectContaining({ id: result.source.id, status: 'ACTIVE' }),
    )
    await expect(engine.getSyncJob(requestContext, result.job.id)).resolves.toMatchObject({
      state: 'SUCCEEDED',
      outputFragmentId: result.job.outputFragmentId,
    })
  }, 120_000)

  it('serves the fixed 2025 Posting and Tax result through the authenticated Web API', async () => {
    const response = await inject({
      method: 'GET',
      url: '/api/v1/tax-reports/2025/current?finality=PROVISIONAL',
    })
    expect(response.statusCode, response.body).toBe(200)
    const current = response.json<{ report: { reportId: string } }>()
    expect(current).toMatchObject({
      report: {
        taxYear: 2025,
        finality: 'PROVISIONAL',
      },
    })

    const detail = await inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${encodeURIComponent(current.report.reportId)}`,
    })
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json()).toMatchObject({
      report: {
        reportId: current.report.reportId,
        taxYear: 2025,
        summary: {
          calculationRule: {
            basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
          },
        },
      },
    })
  })
})
