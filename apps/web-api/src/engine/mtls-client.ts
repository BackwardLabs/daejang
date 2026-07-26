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
import { EngineRpcError } from './rpc-error.js'

const protoPath = fileURLToPath(
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

type UnaryMethod = (
  request: Record<string, unknown>,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response: unknown) => void,
) => Client

type SourceServiceClient = Client & {
  registerWallet: UnaryMethod
  listSources: UnaryMethod
  disconnectSource: UnaryMethod
}

const sourceServiceConstructor = () => {
  const definition = loadSync(protoPath, {
    defaults: true,
    enums: String,
    longs: String,
    oneofs: true,
  })
  const loaded = loadPackageDefinition(definition) as unknown as {
    giwa: { engine: { v1: { SourceService: ServiceClientConstructor } } }
  }
  return loaded.giwa.engine.v1.SourceService
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

export class EngineMtlsClient implements WalletSourceRegistry {
  readonly durable = true
  readonly #client: SourceServiceClient

  private constructor(client: SourceServiceClient) {
    this.#client = client
  }

  static async connect(config: EngineMtlsConfig) {
    const credentials = await createEngineMtlsCredentials(config)
    return EngineMtlsClient.#create(config.target, credentials, config.serverNameOverride)
  }

  static connectInsecureForDevelopment(target: string) {
    return EngineMtlsClient.#create(target, grpcCredentials.createInsecure())
  }

  static #create(
    target: string,
    credentials: ChannelCredentials,
    serverNameOverride?: string,
  ) {
    const channelOptions: ChannelOptions = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 0,
    }
    if (serverNameOverride) {
      channelOptions['grpc.ssl_target_name_override'] = serverNameOverride
      channelOptions['grpc.default_authority'] = serverNameOverride
    }
    const SourceService = sourceServiceConstructor()
    return new EngineMtlsClient(
      new SourceService(
        target,
        credentials,
        channelOptions,
      ) as unknown as SourceServiceClient,
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
  }

  async #unary(
    method: keyof Pick<
      SourceServiceClient,
      'registerWallet' | 'listSources' | 'disconnectSource'
    >,
    request: Record<string, unknown>,
  ) {
    return new Promise<unknown>((resolve, reject) => {
      this.#client[method](
        request,
        { deadline: new Date(Date.now() + 10_000) },
        (error, response) => {
          if (error) {
            reject(new EngineRpcError(error.code))
            return
          }
          resolve(response)
        }
      )
    })
  }
}
