import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Server, ServerCredentials } from '@grpc/grpc-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EngineMtlsClient } from './mtls-client.js'

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const describeWithOpenSsl =
  opensslAvailable && process.env.RUN_NETWORK_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip

describeWithOpenSsl('EngineMtlsClient', () => {
  let directory: string
  let server: Server
  let port: number

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'daejang-mtls-'))
    const runOpenSsl = (...arguments_: string[]) =>
      execFileSync('openssl', arguments_, { cwd: directory, stdio: 'ignore' })

    await writeFile(
      join(directory, 'server-ext.cnf'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\n',
    )
    runOpenSsl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem')
    runOpenSsl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr')
    runOpenSsl('x509', '-req', '-days', '1', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-extfile', 'server-ext.cnf')
    runOpenSsl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=web-api', '-keyout', 'client.key', '-out', 'client.csr')
    runOpenSsl('x509', '-req', '-days', '1', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem')

    const [ca, serverKey, serverCertificate] = await Promise.all([
      readFile(join(directory, 'ca.pem')),
      readFile(join(directory, 'server.key')),
      readFile(join(directory, 'server.pem')),
    ])
    server = new Server()
    port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createSsl(
          ca,
          [{ private_key: serverKey, cert_chain: serverCertificate }],
          true,
        ),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      )
    })
  }, 20_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  it('completes a TLS handshake using the client certificate and private CA', async () => {
    const client = await EngineMtlsClient.connect({
      target: `127.0.0.1:${port}`,
      caPath: join(directory, 'ca.pem'),
      certPath: join(directory, 'client.pem'),
      keyPath: join(directory, 'client.key'),
      serverNameOverride: 'localhost',
    })

    await expect(client.waitForReady(5_000)).resolves.toBeUndefined()
    expect(client.getConnectivityState()).toBe('READY')
    client.close()
  })
})
