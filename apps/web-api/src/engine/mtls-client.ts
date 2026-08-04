import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  ChannelCredentials,
  Client,
  credentials as grpcCredentials,
  connectivityState,
  loadPackageDefinition,
  status,
  type ChannelOptions,
  type ServiceClientConstructor,
  type ServiceError,
} from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

import type { EngineMtlsConfig } from '../config.js'
import type {
  CompleteWalletRegistration,
  SourceRequestContext,
  WalletSource,
  WalletSourceRegistry,
} from '../sources/wallet-source-store.js'
import type {
  TaxEvidencePackReader,
  TaxReportModelReader,
} from '../tax-report/model-reader.js'
import { EngineRpcError } from './rpc-error.js'

const protoPath = process.env.ENGINE_PROTO_PATH ?? fileURLToPath(
  new URL('../../../../proto/giwa/engine/v1/engine.proto', import.meta.url),
)

const readPem = async (path: string, expectedLabels: readonly string[]) => {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)])
  if (!metadata.isFile()) {
    throw new Error(`${path} is not a regular file`)
  }
  if (
    !expectedLabels.some((label) =>
      contents.includes(Buffer.from(`-----BEGIN ${label}-----`)),
    )
  ) {
    throw new Error(`${path} does not contain an expected PEM block`)
  }
  return contents
}

export const createEngineMtlsCredentials = async (config: EngineMtlsConfig) => {
  const [rootCertificate, clientCertificate, clientPrivateKey] = await Promise.all([
    readPem(config.caPath, ['CERTIFICATE']),
    readPem(config.certPath, ['CERTIFICATE']),
    readPem(config.keyPath, ['PRIVATE KEY', 'EC PRIVATE KEY', 'RSA PRIVATE KEY']),
  ])

  return ChannelCredentials.createSsl(
    rootCertificate,
    clientPrivateKey,
    clientCertificate,
  )
}

type ProtoTimestamp = { seconds: string | number; nanos?: number }
type ProtoWalletSource = {
  id: string
  address: string
  accountType: 'EOA'
  verificationChainId: string
  verifiedAt: ProtoTimestamp
  label?: string
  status: 'ACTIVE' | 'DISCONNECTED'
  createdAt: ProtoTimestamp
  updatedAt: ProtoTimestamp
  disconnectedAt?: ProtoTimestamp
  chainScopes: Array<{
    chainId: string
    status: 'ACTIVE' | 'DISABLED'
  }>
}
type ProtoDocumentSource = {
  id: string
  provider: 'UPBIT'
  originalFilename: string
  mediaType: 'application/pdf'
  byteLength: string | number
  artifactDigest: string
  coverageStart: string
  coverageEnd: string
  status: 'ACTIVE' | 'DISCONNECTED'
  createdAt: ProtoTimestamp
  updatedAt: ProtoTimestamp
}

type UnaryMethod = (
  request: Record<string, unknown>,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => Client

type SourceServiceClient = Client & {
  registerWallet: UnaryMethod
  importUpbitDocument: UnaryMethod
  listSources: UnaryMethod
  disconnectSource: UnaryMethod
}
type WorkflowServiceClient = Client & {
  enqueueSync: UnaryMethod
  getSyncJob: UnaryMethod
  listSyncJobs: UnaryMethod
}
type QueryServiceClient = Client & {
  getDashboard: UnaryMethod
  listLedgerEvents: UnaryMethod
  getLedgerEventLots: UnaryMethod
  listReviews: UnaryMethod
  createReport: UnaryMethod
  listReports: UnaryMethod
  getCurrentTaxReport: UnaryMethod
  listTaxReportHistory: UnaryMethod
  getTaxReportModel: UnaryMethod
  getTaxEvidencePack: UnaryMethod
}
type ReviewServiceClient = Client & {
  getReview: UnaryMethod
  resolveReview: UnaryMethod
}

const serviceConstructors = () => {
  const definition = loadSync(protoPath, {
    defaults: true,
    enums: String,
    longs: String,
    oneofs: true,
  })
  const loaded = loadPackageDefinition(definition) as unknown as {
    giwa: { engine: { v1: {
      SourceService: ServiceClientConstructor
      WorkflowService: ServiceClientConstructor
      QueryService: ServiceClientConstructor
      ReviewService: ServiceClientConstructor
    } } }
  }
  return loaded.giwa.engine.v1
}

const toProtoTimestamp = (value: Date): ProtoTimestamp => {
  const milliseconds = value.getTime()
  return {
    seconds: Math.floor(milliseconds / 1_000),
    nanos: (milliseconds % 1_000) * 1_000_000,
  }
}

const fromProtoTimestamp = (value: ProtoTimestamp) =>
  new Date(Number(value.seconds) * 1_000 + Math.floor((value.nanos ?? 0) / 1_000_000))

const normalizeProtoValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeProtoValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('seconds' in record && Object.keys(record).every((key) => key === 'seconds' || key === 'nanos')) {
      return fromProtoTimestamp(record as ProtoTimestamp).toISOString()
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, normalizeProtoValue(child)]))
  }
  return value
}

const toWalletSource = (value: ProtoWalletSource): WalletSource => ({
  id: value.id,
  address: value.address,
  accountType: value.accountType,
  verificationChainId: value.verificationChainId,
  verifiedAt: fromProtoTimestamp(value.verifiedAt),
  label: value.label || undefined,
  status: value.status,
  createdAt: fromProtoTimestamp(value.createdAt),
  updatedAt: fromProtoTimestamp(value.updatedAt),
  disconnectedAt: value.disconnectedAt
    ? fromProtoTimestamp(value.disconnectedAt)
    : undefined,
  chainScopes: value.chainScopes,
})

const requestContext = (value: SourceRequestContext) => ({
  requestId: value.requestId,
  idempotencyKey: value.idempotencyKey ?? '',
  actor: { userId: value.userId, sessionId: value.sessionId },
})

export class EngineMtlsClient
  implements WalletSourceRegistry, TaxReportModelReader, TaxEvidencePackReader
{
  readonly durable = true
  readonly upbitPdfImportSupported: boolean
  readonly #client: SourceServiceClient
  readonly #workflowClient: WorkflowServiceClient
  readonly #queryClient: QueryServiceClient
  readonly #reviewClient: ReviewServiceClient

  private constructor(
    client: SourceServiceClient,
    workflowClient: WorkflowServiceClient,
    queryClient: QueryServiceClient,
    reviewClient: ReviewServiceClient,
    upbitPdfImportSupported: boolean,
  ) {
    this.#client = client
    this.#workflowClient = workflowClient
    this.#queryClient = queryClient
    this.#reviewClient = reviewClient
    this.upbitPdfImportSupported = upbitPdfImportSupported
  }

  static async connect(config: EngineMtlsConfig, upbitPdfImportEnabled: boolean) {
    const credentials = await createEngineMtlsCredentials(config)
    return EngineMtlsClient.#create(
      config.target,
      credentials,
      upbitPdfImportEnabled,
      config.serverNameOverride,
    )
  }

  static connectInsecureLoopback(target: string, upbitPdfImportEnabled: boolean) {
    return EngineMtlsClient.#create(
      target,
      grpcCredentials.createInsecure(),
      upbitPdfImportEnabled,
    )
  }

  static #create(
    target: string,
    credentials: ChannelCredentials,
    upbitPdfImportSupported: boolean,
    serverNameOverride?: string,
  ) {
    const channelOptions: ChannelOptions = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 0,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
      'grpc.max_send_message_length': 32 * 1024 * 1024,
    }
    if (serverNameOverride) {
      channelOptions['grpc.ssl_target_name_override'] = serverNameOverride
      channelOptions['grpc.default_authority'] = serverNameOverride
    }
    const { SourceService, WorkflowService, QueryService, ReviewService } = serviceConstructors()
    return new EngineMtlsClient(
      new SourceService(
        target,
        credentials,
        channelOptions,
      ) as unknown as SourceServiceClient,
      new WorkflowService(target, credentials, channelOptions) as unknown as WorkflowServiceClient,
      new QueryService(target, credentials, channelOptions) as unknown as QueryServiceClient,
      new ReviewService(target, credentials, channelOptions) as unknown as ReviewServiceClient,
      upbitPdfImportSupported,
    )
  }

  async waitForReady(timeoutMilliseconds: number) {
    this.#client.getChannel().getConnectivityState(true)
    await new Promise<void>((resolve, reject) => {
      this.#client.waitForReady(Date.now() + timeoutMilliseconds, (error) => {
        if (error) {
          reject(new Error(`Engine mTLS preflight failed: ${error.message}`, { cause: error }))
          return
        }
        resolve()
      })
    })
  }

  async importUpbitDocument(input: {
    context: SourceRequestContext
    uploadId: string
    objectKey: string
    artifactDigest: string
    originalFilename: string
    mediaType: 'application/pdf'
    byteLength: number
    coverageStart: string
    coverageEnd: string
    expectedSubjectName: string
    encryptedOriginalPdf: Buffer
    pdfPasswordUtf8: Buffer
  }) {
    const response = await this.#unaryOn(this.#client, 'importUpbitDocument', {
      context: requestContext(input.context),
      uploadId: input.uploadId,
      objectKey: input.objectKey,
      artifactDigest: input.artifactDigest,
      originalFilename: input.originalFilename,
      mediaType: input.mediaType,
      byteLength: input.byteLength,
      coverageStart: input.coverageStart,
      coverageEnd: input.coverageEnd,
      expectedSubjectName: input.expectedSubjectName,
      encryptedOriginalPdf: input.encryptedOriginalPdf,
      pdfPasswordUtf8: input.pdfPasswordUtf8,
    }, 90_000) as {
      source: ProtoDocumentSource
      job: Record<string, unknown>
      evidenceTerminalStatus: string
      sourceRecordCount: string | number
      normalizedRecordCount: string | number
    }
    return {
      source: this.#documentSource(response.source),
      job: normalizeProtoValue(response.job) as Record<string, unknown>,
      evidenceTerminalStatus: response.evidenceTerminalStatus,
      sourceRecordCount: Number(response.sourceRecordCount),
      normalizedRecordCount: Number(response.normalizedRecordCount),
    }
  }

  async listAllSources(context: SourceRequestContext) {
    const response = (await this.#unary('listSources', { context: requestContext(context) })) as {
      items: ProtoWalletSource[]
      documentItems: ProtoDocumentSource[]
    }
    return { wallets: response.items.map(toWalletSource), documents: response.documentItems.map((value) => this.#documentSource(value)) }
  }

  async enqueueSync(context: SourceRequestContext, input: {
    sourceKind: 'UPBIT_PDF' | 'EVM_WALLET'
    sourceId: string
    requestedCoverageStart: string
    requestedCoverageEnd: string
    trigger: 'USER_REQUEST'
  }) {
    const response = await this.#unaryOn(this.#workflowClient, 'enqueueSync', {
      context: requestContext(context), ...input,
    }) as { job: Record<string, unknown> }
    return normalizeProtoValue(response.job) as Record<string, unknown>
  }

  async getSyncJob(context: SourceRequestContext, jobId: string) {
    const response = await this.#unaryOn(this.#workflowClient, 'getSyncJob', { context: requestContext(context), jobId }) as { job: Record<string, unknown> }
    return normalizeProtoValue(response.job) as Record<string, unknown>
  }

  async listSyncJobs(context: SourceRequestContext, limit = 20) {
    const response = await this.#unaryOn(this.#workflowClient, 'listSyncJobs', { context: requestContext(context), limit }) as { items: Array<Record<string, unknown>> }
    return normalizeProtoValue(response.items) as Array<Record<string, unknown>>
  }

  async getDashboard(context: SourceRequestContext, taxYear: number) {
    const response = await this.#unaryOn(this.#queryClient, 'getDashboard', { context: requestContext(context), taxYear }) as { dashboard: Record<string, unknown> }
    return normalizeProtoValue(response.dashboard) as Record<string, unknown>
  }

  async listLedgerEvents(context: SourceRequestContext, taxYear: number, limit = 100, pageToken = '') {
    const response = await this.#unaryOn(this.#queryClient, 'listLedgerEvents', {
      context: requestContext(context), taxYear, limit, pageToken,
    }) as { items: Array<Record<string, unknown>>; nextPageToken: string }
    return {
      items: normalizeProtoValue(response.items) as Array<Record<string, unknown>>,
      nextPageToken: response.nextPageToken,
    }
  }

  async getLedgerEventLots(context: SourceRequestContext, eventId: string, revisionId: string) {
    const response = await this.#unaryOn(this.#queryClient, 'getLedgerEventLots', {
      context: requestContext(context), eventId, revisionId,
    }) as { runId: string; coverage: string; links: Array<Record<string, unknown>> }
    return {
      runId: response.runId,
      coverage: response.coverage,
      links: normalizeProtoValue(response.links) as Array<Record<string, unknown>>,
    }
  }

  async listReviews(context: SourceRequestContext, limit = 100, pageToken = '') {
    const response = await this.#unaryOn(this.#queryClient, 'listReviews', {
      context: requestContext(context), limit, pageToken,
    }) as { items: Array<Record<string, unknown>>; nextPageToken: string }
    return {
      items: normalizeProtoValue(response.items) as Array<Record<string, unknown>>,
      nextPageToken: response.nextPageToken,
    }
  }

  async getReview(context: SourceRequestContext, reviewId: string) {
    const response = await this.#unaryOn(this.#reviewClient, 'getReview', {
      context: requestContext(context), reviewId,
    }) as { review: Record<string, unknown> }
    return normalizeProtoValue(response.review) as Record<string, unknown>
  }

  async resolveReview(context: SourceRequestContext, input: {
    reviewId: string
    expectedRevisionId: string
    expectedPointerVersion: string
    resolutionCode: string
    resolutionNote: string
  }) {
    const response = await this.#unaryOn(this.#reviewClient, 'resolveReview', {
      context: requestContext(context),
      ...input,
    }) as { review: Record<string, unknown>; replayed: boolean }
    return {
      review: normalizeProtoValue(response.review) as Record<string, unknown>,
      replayed: response.replayed,
    }
  }

  async createReport(context: SourceRequestContext, taxYear: number) {
    const response = await this.#unaryOn(this.#queryClient, 'createReport', { context: requestContext(context), taxYear }) as { report: Record<string, unknown> }
    return normalizeProtoValue(response.report) as Record<string, unknown>
  }

  async listReports(context: SourceRequestContext, taxYear: number, limit = 20) {
    const response = await this.#unaryOn(this.#queryClient, 'listReports', { context: requestContext(context), taxYear, limit }) as { items: Array<Record<string, unknown>> }
    return normalizeProtoValue(response.items) as Array<Record<string, unknown>>
  }

  async getCurrentTaxReport(context: SourceRequestContext, taxYear: number) {
    const response = await this.#unaryOn(this.#queryClient, 'getCurrentTaxReport', {
      context: requestContext(context), taxYear,
    }) as { report: Record<string, unknown> }
    return normalizeProtoValue(response.report) as Record<string, unknown>
  }

  async listTaxReportHistory(context: SourceRequestContext, taxYear: number, limit = 20) {
    const response = await this.#unaryOn(this.#queryClient, 'listTaxReportHistory', {
      context: requestContext(context), taxYear, limit,
    }) as { items: Array<Record<string, unknown>> }
    return normalizeProtoValue(response.items) as Array<Record<string, unknown>>
  }

  async getTaxReportModel(
    context: SourceRequestContext,
    reportId: string,
  ) {
    const response = await this.#unaryOn(
      this.#queryClient,
      'getTaxReportModel',
      {
        context: requestContext(context),
        reportId,
      },
    ) as {
      reportId: string
      artifactDigest: string
      mediaType: string
      canonicalJson: Uint8Array
    }
    return {
      reportId: response.reportId,
      artifactDigest: response.artifactDigest,
      mediaType: response.mediaType,
      canonicalJson: response.canonicalJson,
    }
  }

  async getTaxEvidencePack(
    context: SourceRequestContext,
    reportId: string,
  ) {
    const response = await this.#unaryOn(
      this.#queryClient,
      'getTaxEvidencePack',
      {
        context: requestContext(context),
        reportId,
      },
    ) as {
      reportId: string
      artifactDigest: string
      mediaType: string
      canonicalJson: Uint8Array
    }
    return {
      reportId: response.reportId,
      artifactDigest: response.artifactDigest,
      mediaType: response.mediaType,
      canonicalJson: response.canonicalJson,
    }
  }

  getConnectivityState() {
    return connectivityState[this.#client.getChannel().getConnectivityState(false)]
  }

  async registerWallet(input: CompleteWalletRegistration) {
    const response = (await this.#unary('registerWallet', {
      context: requestContext(input),
      address: input.recoveredAddress,
      verificationChainId: input.verificationChainId,
      chainIds: input.chainIds,
      label: input.label ?? '',
      verifiedAt: toProtoTimestamp(input.now),
    })) as { source: ProtoWalletSource }
    return toWalletSource(response.source)
  }

  async listWallets(context: SourceRequestContext) {
    const response = (await this.#unary('listSources', {
      context: requestContext(context),
    })) as { items: ProtoWalletSource[] }
    return response.items.map(toWalletSource)
  }

  async disconnectWallet(
    context: SourceRequestContext,
    sourceId: string,
    now: Date,
  ) {
    try {
      const response = (await this.#unary('disconnectSource', {
        context: requestContext(context),
        sourceId,
        disconnectedAt: toProtoTimestamp(now),
      })) as { source: ProtoWalletSource }
      return toWalletSource(response.source)
    } catch (error) {
      if (error instanceof EngineRpcError && error.grpcCode === status.NOT_FOUND) {
        return undefined
      }
      throw error
    }
  }

  close() {
    this.#client.close()
    this.#workflowClient.close()
    this.#queryClient.close()
    this.#reviewClient.close()
  }

  #documentSource(value: ProtoDocumentSource) {
    return {
      id: value.id, type: 'UPBIT_PDF' as const, provider: value.provider,
      originalFilename: value.originalFilename, mediaType: value.mediaType,
      byteLength: Number(value.byteLength), artifactDigest: value.artifactDigest,
      coverageStart: value.coverageStart, coverageEnd: value.coverageEnd,
      status: value.status, createdAt: fromProtoTimestamp(value.createdAt),
      updatedAt: fromProtoTimestamp(value.updatedAt),
    }
  }

  async #unary(
    method: keyof Pick<
      SourceServiceClient,
      'registerWallet' | 'listSources' | 'disconnectSource'
    >,
    request: Record<string, unknown>,
  ) {
    return this.#unaryOn(this.#client, method, request)
  }

  async #unaryOn(
    client: Client,
    method: string,
    request: Record<string, unknown>,
    timeoutMilliseconds = 10_000,
  ) {
    return new Promise<unknown>((resolve, reject) => {
      const unary = (client as unknown as Record<string, UnaryMethod>)[method] as UnaryMethod
      unary.call(client,
        request,
        { deadline: new Date(Date.now() + timeoutMilliseconds) },
        (error, response) => {
          if (error) {
            reject(new EngineRpcError(error.code, error.details))
            return
          }
          resolve(response)
        }
      )
    })
  }
}
