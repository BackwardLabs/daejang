import { createHash, randomUUID } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import {
  MemoryAccountAuthStore,
  type LegalDocumentType,
} from '../auth/account-auth-store.js'
import type { VerificationEmailSender } from '../auth/email-auth.js'
import type { AppConfig } from '../config.js'
import type { EngineDataClient } from '../routes/data.js'
import type {
  CreateUpload,
  UploadSession,
  UploadStore,
} from '../uploads/upload-store.js'

const config: AppConfig = {
  runtimeMode: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 20 * 1024 * 1024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl: undefined,
  rateLimitHmacSecret: 'acceptance-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'acceptance-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: true,
    resendApiKey: 'acceptance-resend-key',
    from: 'Daejang <acceptance@example.com>',
    verificationHmacSecret: 'acceptance-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: true,
    identityVerificationRequired: false,
    methods: { email: true, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: true,
  engineMtls: undefined,
}

class CapturingEmailSender implements VerificationEmailSender {
  code: string | undefined

  async sendVerificationCode(input: { code: string }) {
    this.code = input.code
  }
}

class JourneyUploadStore implements UploadStore {
  readonly durable = true
  private session: UploadSession | undefined
  private contents: Buffer | undefined

  async create(input: CreateUpload) {
    this.session = {
      id: randomUUID(),
      userId: input.userId,
      provider: 'UPBIT',
      objectKey: `upbit/${input.userId}/${randomUUID()}.pdf`,
      originalFilename: input.originalFilename,
      mediaType: input.mediaType,
      expectedBytes: input.expectedBytes,
      state: 'PENDING',
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(input.now.getTime() + 15 * 60_000),
    }
    return this.session
  }

  async write(
    userId: string,
    uploadId: string,
    contents: Buffer,
    _now: Date,
  ) {
    if (
      !this.session ||
      this.session.userId !== userId ||
      this.session.id !== uploadId ||
      contents.length !== this.session.expectedBytes
    ) {
      return undefined
    }
    this.contents = Buffer.from(contents)
    this.session = { ...this.session, state: 'UPLOADED' }
    return this.session
  }

  async confirm(userId: string, uploadId: string, _now: Date) {
    if (
      !this.session ||
      !this.contents ||
      this.session.userId !== userId ||
      this.session.id !== uploadId ||
      this.session.state !== 'UPLOADED' ||
      this.contents.subarray(0, 5).toString() !== '%PDF-'
    ) {
      return undefined
    }
    this.session = {
      ...this.session,
      state: 'CONFIRMED',
      verifiedBytes: this.contents.length,
      verifiedDigest: createHash('sha256').update(this.contents).digest('hex'),
    }
    return this.session
  }

  async readConfirmed(userId: string, uploadId: string) {
    if (
      !this.session ||
      !this.contents ||
      this.session.userId !== userId ||
      this.session.id !== uploadId ||
      this.session.state !== 'CONFIRMED'
    ) {
      return undefined
    }
    return { session: this.session, contents: Buffer.from(this.contents) }
  }

  async discard(userId: string, uploadId: string) {
    if (
      !this.session ||
      this.session.userId !== userId ||
      this.session.id !== uploadId
    ) {
      return false
    }
    this.contents = undefined
    this.session = undefined
    return true
  }

  async cleanupAbandoned() {
    return { examined: 0, removed: 0, missing: 0, retryPending: 0 }
  }
}

class JourneyEngine implements EngineDataClient {
  readonly upbitPdfImportSupported = true
  private documents: Array<Record<string, unknown>> = []
  private jobs: Array<Record<string, unknown>> = []
  private reports: Array<Record<string, unknown>> = []

  private createDocument(input: {
    originalFilename: string
    byteLength: number
    artifactDigest: string
    coverageStart: string
    coverageEnd: string
  }) {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const source = {
      id: randomUUID(),
      type: 'UPBIT_PDF' as const,
      provider: 'UPBIT' as const,
      originalFilename: input.originalFilename,
      mediaType: 'application/pdf' as const,
      byteLength: input.byteLength,
      artifactDigest: input.artifactDigest,
      coverageStart: input.coverageStart,
      coverageEnd: input.coverageEnd,
      status: 'ACTIVE' as const,
      createdAt: now,
      updatedAt: now,
    }
    this.documents.push(source)
    return source
  }

  async listAllSources() {
    return { wallets: [], documents: [...this.documents] }
  }

  async importUpbitDocument(
    input: Parameters<NonNullable<EngineDataClient['importUpbitDocument']>>[0],
  ) {
    const source = this.createDocument(input)
    const job = {
      id: randomUUID(),
      sourceKind: 'UPBIT_PDF',
      sourceId: source.id,
      state: 'SUCCEEDED',
      stage: 'COMPLETE',
    }
    this.jobs.push(job)
    return {
      source,
      job,
      evidenceTerminalStatus: 'PARTIAL',
      sourceRecordCount: 1,
      normalizedRecordCount: 0,
    }
  }

  async enqueueSync(
    _context: Parameters<EngineDataClient['enqueueSync']>[0],
    input: Parameters<EngineDataClient['enqueueSync']>[1],
  ) {
    const job = {
      id: randomUUID(),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      state: 'QUEUED',
      stage: 'COLLECTING',
    }
    this.jobs.push(job)
    return job
  }

  async getSyncJob(
    _context: Parameters<EngineDataClient['getSyncJob']>[0],
    jobId: string,
  ) {
    return this.jobs.find((job) => job.id === jobId) ?? {}
  }

  async listSyncJobs() {
    return [...this.jobs]
  }

  async getDashboard(
    _context: Parameters<EngineDataClient['getDashboard']>[0],
    taxYear: number,
  ) {
    return {
      taxYear,
      sourceCount: this.documents.length,
      transactionCount: 0,
      openReviewCount: 0,
      completedCount: 0,
      exceptionCount: 0,
      lastSyncState: this.jobs.at(-1)?.state ?? '',
    }
  }

  async listLedgerEvents() {
    return []
  }

  async listReviews() {
    return { items: [], nextPageToken: '' }
  }

  async getReview() {
    return {}
  }

  async resolveReview() {
    return { review: {}, replayed: false }
  }

  async createReport(
    _context: Parameters<EngineDataClient['createReport']>[0],
    taxYear: number,
  ) {
    const report = {
      id: randomUUID(),
      taxYear,
      status: 'PARTIAL',
      createdAt: '2027-07-20T00:00:00.000Z',
    }
    this.reports.push(report)
    return report
  }

  async listReports(
    _context: Parameters<EngineDataClient['listReports']>[0],
    taxYear: number,
  ) {
    return this.reports.filter((report) => report.taxYear === taxYear)
  }

  async listTaxReportHistory() {
    return []
  }
}

const cookiePair = (
  name: string,
  setCookie: string | string[] | undefined,
) => {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie]
  return headers
    .filter((header): header is string => Boolean(header))
    .map((header) => {
      const separatorIndex = header.indexOf(';')
      return separatorIndex < 0 ? header : header.slice(0, separatorIndex)
    })
    .find((cookie) => cookie.startsWith(`${name}=`))
}

describe('documented normal user journey', () => {
  let context: Awaited<ReturnType<typeof buildApp>>
  let emailSender: CapturingEmailSender

  beforeEach(async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const accountStore = new MemoryAccountAuthStore()
    for (const [index, documentType] of [
      'terms',
      'privacy',
      'identity_verification',
    ].entries()) {
      const content = `${documentType} acceptance content`
      accountStore.seedLegalDocument({
        id: `00000000-0000-4000-8000-00000000001${index}`,
        documentType: documentType as LegalDocumentType,
        locale: 'ko-KR',
        version: '2027-07',
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        effectiveAt: now,
      })
    }
    emailSender = new CapturingEmailSender()
    context = await buildApp({
      config,
      logger: false,
      accountAuthStore: accountStore,
      verificationEmailSender: emailSender,
      uploadStore: new JourneyUploadStore(),
      engineDataClient: new JourneyEngine(),
      now: () => now,
    })
  })

  afterEach(async () => context.app.close())

  it('lets a new user activate an account, add an Upbit source, create a report, and return to the same data after login', async () => {
    const origin = { origin: config.publicOrigin }
    const email = 'normal-user@example.com'
    const password = 'Normal1!password'

    const capabilities = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/capabilities',
    })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json()).toEqual({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: [] },
      },
    })

    const codeRequest = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/send-code',
      headers: origin,
      payload: { email, intent: 'signup' },
    })
    expect(codeRequest.statusCode).toBe(202)
    expect(emailSender.code).toMatch(/^[0-9]{6}$/u)

    const codeVerification = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify-code',
      headers: origin,
      payload: { email, intent: 'signup', code: emailSender.code },
    })
    expect(codeVerification.statusCode).toBe(200)

    const signup = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      headers: origin,
      payload: {
        email,
        password,
        passwordConfirmation: password,
        verificationToken: codeVerification.json<{
          verificationToken: string
        }>().verificationToken,
      },
    })
    expect(signup.statusCode).toBe(201)
    expect(signup.json()).toEqual({
      status: 'signup_pending',
      nextStep: 'terms',
    })
    const signupCookie = cookiePair(
      config.signupSessionCookieName,
      signup.headers['set-cookie'],
    )
    expect(signupCookie).toBeTruthy()

    const legalDocuments = await context.app.inject({
      method: 'GET',
      url: '/api/v1/legal-documents/current?locale=ko-KR',
    })
    expect(legalDocuments.statusCode).toBe(200)
    const requiredDocuments = legalDocuments
      .json<{
        documents: Array<{ id: string; documentType: string; required: boolean }>
      }>()
      .documents.filter((document) => document.required)
    expect(requiredDocuments.map(({ documentType }) => documentType).sort()).toEqual([
      'privacy',
      'terms',
    ])

    const consent = await context.app.inject({
      method: 'POST',
      url: '/api/v1/signup/consents',
      headers: { ...origin, cookie: signupCookie as string },
      payload: {
        locale: 'ko-KR',
        decisions: requiredDocuments.map((document) => ({
          legalDocumentId: document.id,
          action: 'accepted',
        })),
      },
    })
    expect(consent.statusCode).toBe(200)
    const activated = consent.json<{
      status: string
      nextPath: string
      user: { id: string; displayName: string }
    }>()
    expect(activated).toEqual({
      status: 'authenticated',
      nextPath: '/dashboard',
      user: {
        id: expect.any(String),
        displayName: 'GIWA 사용자',
      },
    })
    const unverifiedSessionCookie = cookiePair(
      config.sessionCookieName,
      consent.headers['set-cookie'],
    )
    expect(unverifiedSessionCookie).toBeTruthy()
    const unverifiedCapabilities = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources/capabilities',
      headers: { cookie: unverifiedSessionCookie as string },
    })
    expect(unverifiedCapabilities.json()).toEqual({
      upbitPdf: {
        registrationEnabled: false,
        encryptedPdfSupported: true,
      },
    })

    // Production PDF registration requires an independently provisioned,
    // immutable KYC subject-name claim. The acceptance test injects that
    // completed operational boundary before exercising the source flow.
    const verifiedSession = await context.sessionService.create({
      user: activated.user,
      verifiedSubjectName: {
        normalizedValue: 'GIWA 사용자',
      },
    })
    const sessionCookie = `${config.sessionCookieName}=${verifiedSession.token}`
    const authenticatedHeaders = { cookie: sessionCookie as string }

    const verifiedCapabilities = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources/capabilities',
      headers: authenticatedHeaders,
    })
    expect(verifiedCapabilities.json()).toEqual({
      upbitPdf: {
        registrationEnabled: true,
        encryptedPdfSupported: true,
      },
    })

    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authenticatedHeaders,
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({
      user: { displayName: 'GIWA 사용자' },
    })

    const emptySources = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: authenticatedHeaders,
    })
    expect(emptySources.statusCode).toBe(200)
    expect(emptySources.json()).toEqual({ items: [] })

    const pdf = Buffer.from('%PDF-1.7\nnormal Upbit acceptance statement')
    const upload = await context.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { ...origin, ...authenticatedHeaders },
      payload: {
        filename: 'upbit-2027.pdf',
        mediaType: 'application/pdf',
        sizeBytes: pdf.length,
        intentKey: 'normal-upbit-2027',
      },
    })
    expect(upload.statusCode).toBe(201)
    const uploadId = upload.json<{ uploadId: string }>().uploadId

    const uploaded = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/content`,
      headers: {
        ...origin,
        ...authenticatedHeaders,
        'content-type': 'application/pdf',
      },
      payload: pdf,
    })
    expect(uploaded.statusCode).toBe(204)

    const registration = await context.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/import?coverageStart=2027-01-01&coverageEnd=2027-12-31`,
      headers: {
        ...origin,
        ...authenticatedHeaders,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from([1]),
    })
    expect(registration.statusCode).toBe(201)
    expect(registration.json()).toMatchObject({
      source: {
        type: 'UPBIT_PDF',
        coverageStart: '2027-01-01',
        coverageEnd: '2027-12-31',
        status: 'ACTIVE',
      },
      job: { state: 'SUCCEEDED', stage: 'COMPLETE' },
      evidenceTerminalStatus: 'PARTIAL',
    })

    const sources = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: authenticatedHeaders,
    })
    expect(sources.statusCode).toBe(200)
    expect(sources.json()).toMatchObject({
      items: [{ type: 'UPBIT_PDF', status: 'ACTIVE' }],
    })

    const jobs = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: authenticatedHeaders,
    })
    expect(jobs.statusCode).toBe(200)
    expect(jobs.json()).toMatchObject({
      items: [{ state: 'SUCCEEDED', stage: 'COMPLETE' }],
    })

    const dashboard = await context.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard?taxYear=2027',
      headers: authenticatedHeaders,
    })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json()).toMatchObject({
      dashboard: {
        taxYear: 2027,
        sourceCount: 1,
        lastSyncState: 'SUCCEEDED',
      },
    })

    const reportCreation = await context.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { ...origin, ...authenticatedHeaders },
      payload: { taxYear: 2027, intentKey: 'normal-report-2027' },
    })
    expect(reportCreation.statusCode).toBe(201)
    expect(reportCreation.json()).toMatchObject({
      report: { taxYear: 2027, status: 'PARTIAL' },
    })

    const reports = await context.app.inject({
      method: 'GET',
      url: '/api/v1/reports?taxYear=2027',
      headers: authenticatedHeaders,
    })
    expect(reports.statusCode).toBe(200)
    expect(reports.json()).toMatchObject({
      items: [{ taxYear: 2027, status: 'PARTIAL' }],
    })

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...origin, ...authenticatedHeaders },
    })
    expect(logout.statusCode).toBe(204)

    const afterLogout = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authenticatedHeaders,
    })
    expect(afterLogout.statusCode).toBe(401)

    const returningLogin = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: origin,
      payload: { email, password },
    })
    expect(returningLogin.statusCode).toBe(200)
    expect(returningLogin.json()).toEqual({
      status: 'authenticated',
      nextPath: '/dashboard',
      user: {
        id: expect.any(String),
        displayName: 'GIWA 사용자',
      },
    })
    const returningSessionCookie = cookiePair(
      config.sessionCookieName,
      returningLogin.headers['set-cookie'],
    )
    expect(returningSessionCookie).toBeTruthy()
    expect(returningSessionCookie).not.toBe(sessionCookie)

    const returningSources = await context.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: { cookie: returningSessionCookie as string },
    })
    expect(returningSources.statusCode).toBe(200)
    expect(returningSources.json()).toMatchObject({
      items: [{ type: 'UPBIT_PDF', status: 'ACTIVE' }],
    })

    const returningReports = await context.app.inject({
      method: 'GET',
      url: '/api/v1/reports?taxYear=2027',
      headers: { cookie: returningSessionCookie as string },
    })
    expect(returningReports.statusCode).toBe(200)
    expect(returningReports.json()).toMatchObject({
      items: [{ taxYear: 2027, status: 'PARTIAL' }],
    })
  })
})
