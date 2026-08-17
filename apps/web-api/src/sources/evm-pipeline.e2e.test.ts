import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const enabled = process.env.RUN_EVM_PIPELINE_E2E_TESTS === '1'
const dockerHostEnabled = process.env.ALLOW_DOCKER_HOST_E2E === '1'

const disposableDatabaseUrl = (name: string) => {
  const value = process.env[name]
  if (!enabled) return undefined
  if (!value) throw new Error(`${name} is required for EVM pipeline E2E tests`)
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
  throw new Error('TEST_ENGINE_GRPC_TARGET is required for EVM pipeline E2E tests')
}

const describeWithPipeline = enabled ? describe : describe.skip
// jit fixture의 selection scope·subject ACL과 정확히 일치해야 하는 값들이다.
// 주소는 deploy/compose.dev-e2e.yaml의 DAEJANG_JIT_DEV_E2E_FROM_ADDRESS,
// coverage는 jit_bridge config의 coverage 항목과 같아야 한다.
const fixtureWalletPrivateKey =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const fixtureWalletAddress = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const fixtureCoverageDate = '2015-07-30'
const fixtureTaxYear = 2015
const productAccount = {
  id: '00000000-0000-4000-8000-00000000e2e1',
  email: 'test@example.test',
  password: 'test1234!',
  displayName: 'Daejang E2E',
} as const
const e2eSubjectId = process.env.DAEJANG_E2E_SUBJECT_ID
if (enabled && e2eSubjectId !== productAccount.id) {
  throw new Error(`DAEJANG_E2E_SUBJECT_ID must be ${productAccount.id}`)
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
  rateLimitHmacSecret: 'evm-pipeline-e2e-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'evm-pipeline-e2e-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'evm-pipeline-e2e-email-secret',
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

describeWithPipeline('EVM wallet sync to ledger pipeline E2E', () => {
  const ownerPool = new Pool({ connectionString: ownerDatabaseUrl })
  const webPool = new Pool({ connectionString: webDatabaseUrl })
  const objectEncryptionKey = Buffer.alloc(32, 7)
  let objectRoot: string
  let engine: EngineMtlsClient
  let context: Awaited<ReturnType<typeof buildApp>>
  let sessionCookie: string

  beforeAll(async () => {
    objectRoot = await mkdtemp(join(tmpdir(), 'daejang-evm-pipeline-e2e-'))
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
        encryptionKeyId: 'evm-pipeline-e2e',
      }),
      taxReportReader: new PostgresTaxReportReader(webPool),
      taxReportModelReader: engine,
      taxEvidencePackReader: engine,
      engineDataClient: engine,
    })
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: { origin: config(webDatabaseUrl!).publicOrigin },
      payload: { email: productAccount.email, password: productAccount.password },
    })
    expect(response.statusCode, response.body).toBe(200)
    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]
      : response.headers['set-cookie']
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
    method: 'GET' | 'POST'
    url: string
    payload?: Record<string, unknown>
  }) => context.app.inject({
    method: input.method,
    url: input.url,
    headers: {
      cookie: sessionCookie,
      ...(input.method === 'GET' ? {} : { origin: config(webDatabaseUrl!).publicOrigin }),
    },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  })

  const pollUntil = async <T>(
    label: string,
    timeoutMs: number,
    read: () => Promise<{ done: boolean; value: T }>,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    let latest: T | undefined
    for (;;) {
      const { done, value } = await read()
      latest = value
      if (done) return value
      if (Date.now() > deadline) {
        throw new Error(`${label} timed out: ${JSON.stringify(latest)}`)
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 500))
    }
  }

  it('collects a registered wallet through sync-worker, jitd, and EVM posting into the ledger', async () => {
    const wallet = new Wallet(fixtureWalletPrivateKey)
    expect(wallet.address.toLowerCase()).toBe(fixtureWalletAddress)

    const challengeResponse = await inject({
      method: 'POST',
      url: '/api/v1/sources/wallets/challenges',
      payload: { address: wallet.address, chainId: 'eip155:1' },
    })
    expect(challengeResponse.statusCode, challengeResponse.body).toBe(201)
    const challenge = challengeResponse.json<{ challengeId: string; message: string }>()

    const registration = await inject({
      method: 'POST',
      url: '/api/v1/sources/wallets',
      payload: {
        challengeId: challenge.challengeId,
        signature: await wallet.signMessage(challenge.message),
        chainIds: ['eip155:1'],
        label: 'EVM pipeline E2E wallet',
      },
    })
    expect(registration.statusCode, registration.body).toBe(201)
    const source = registration.json<{ id: string; address: string }>()
    expect(source.address).toBe(fixtureWalletAddress)

    const queued = await inject({
      method: 'POST',
      url: '/api/v1/syncs',
      payload: {
        sourceKind: 'EVM_WALLET',
        sourceId: source.id,
        coverageStart: fixtureCoverageDate,
        coverageEnd: fixtureCoverageDate,
        trigger: 'USER_REQUEST',
        intentKey: randomUUID(),
      },
    })
    expect(queued.statusCode, queued.body).toBe(201)
    const { job } = queued.json<{ job: { id: string; state: string } }>()
    expect(job.state).toBe('QUEUED')

    const succeeded = await pollUntil(
      'sync job SUCCEEDED',
      120_000,
      async () => {
        const response = await inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` })
        expect(response.statusCode, response.body).toBe(200)
        const { job: current } = response.json<{
          job: { state: string; phase: string; failureCode?: string | null }
        }>()
        if (current.state === 'FAILED') {
          throw new Error(`sync job failed: ${JSON.stringify(current)}`)
        }
        return { done: current.state === 'SUCCEEDED', value: current }
      },
    )
    expect(succeeded.phase).toBe('COMPLETE')

    const posted = await pollUntil(
      'JIT publication consumed into postings',
      120_000,
      async () => {
        const outbox = await ownerPool.query<{ state: string; last_error: string | null }>(
          `SELECT state,last_error FROM subject_evidence.publication_outbox
           WHERE subject_id=$1 AND producer_kind='JIT'
           ORDER BY created_at DESC LIMIT 1`,
          [productAccount.id],
        )
        const postings = await ownerPool.query<{ count: string }>(
          `SELECT COUNT(*) AS count
           FROM ledger.interpreted_event AS event
           JOIN ledger.asset_posting AS posting
             ON posting.subject_id=event.subject_id
            AND posting.event_id=event.event_id
            AND posting.revision_id=event.current_revision_id
           WHERE event.subject_id=$1`,
          [productAccount.id],
        )
        const value = {
          outbox: outbox.rows[0] ?? null,
          postingCount: Number(postings.rows[0]?.count ?? 0),
        }
        return {
          done: value.outbox?.state === 'PUBLISHED' && value.postingCount > 0,
          value,
        }
      },
    )
    expect(posted.outbox?.state).toBe('PUBLISHED')

    const ledger = await inject({
      method: 'GET',
      url: `/api/v1/ledger?taxYear=${fixtureTaxYear}`,
    })
    expect(ledger.statusCode, ledger.body).toBe(200)
    const events = ledger.json<{ items: Array<Record<string, unknown>> }>()
    expect(events.items.length).toBeGreaterThan(0)
  }, 300_000)
})
