import { readFile, stat } from 'node:fs/promises'

import {
  ChannelCredentials,
  Client,
  type ChannelOptions,
  connectivityState,
} from '@grpc/grpc-js'

import type { EngineMtlsConfig } from '../config.js'

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

export class EngineMtlsClient {
  readonly #client: Client

  private constructor(client: Client) {
    this.#client = client
  }

  static async connect(config: EngineMtlsConfig) {
    const credentials = await createEngineMtlsCredentials(config)
    const channelOptions: ChannelOptions = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 0,
    }
    if (config.serverNameOverride) {
      channelOptions['grpc.ssl_target_name_override'] = config.serverNameOverride
      channelOptions['grpc.default_authority'] = config.serverNameOverride
    }

    return new EngineMtlsClient(new Client(config.target, credentials, channelOptions))
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

  close() {
    this.#client.close()
  }
}
