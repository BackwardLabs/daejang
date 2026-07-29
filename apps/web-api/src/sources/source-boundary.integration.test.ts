import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EngineMtlsClient } from '../engine/mtls-client.js'
import { PostgresWalletSourceStore } from './postgres-wallet-source-store.js'

const databaseUrl = process.env.TEST_WEB_DATABASE_URL
const engineTarget = process.env.TEST_ENGINE_GRPC_TARGET
const describeWithBoundary =
  process.env.RUN_SOURCE_BOUNDARY_INTEGRATION_TESTS === '1' &&
  databaseUrl &&
  engineTarget
    ? describe
    : describe.skip

describeWithBoundary('Web-to-Engine source persistence boundary', () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const sessionId = 'source-boundary-integration-session'
  const address = '0x1234567890abcdef1234567890abcdef12345680'
  let pool: Pool
  let engine: EngineMtlsClient
  let store: PostgresWalletSourceStore

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    engine = EngineMtlsClient.connectInsecureForDevelopment(engineTarget!, true)
    await engine.waitForReady(5_000)
    store = new PostgresWalletSourceStore(pool, engine)
  })

  afterAll(async () => {
    engine.close()
    await pool.end()
  })

  it('keeps the challenge in Web storage and the durable source behind gRPC', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const challengeId = randomUUID()
    await store.createChallenge({
      id: challengeId,
      userId,
      address,
      verificationChainId: 'eip155:1',
      message: 'Daejang source boundary integration challenge',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      consumedAt: undefined,
    })

    const registered = await store.completeRegistration({
      challengeId,
      userId,
      recoveredAddress: address,
      verificationChainId: 'eip155:1',
      chainIds: ['eip155:1', 'eip155:8453'],
      label: 'Boundary integration wallet',
      now,
      requestId: 'source-boundary-register',
      sessionId,
      idempotencyKey: challengeId,
    })
    expect(registered).toMatchObject({ address, status: 'ACTIVE' })
    expect((await store.getChallenge(userId, challengeId))?.consumedAt).toEqual(now)

    const listed = await store.listWallets({
      requestId: 'source-boundary-list',
      userId,
      sessionId,
    })
    expect(listed).toContainEqual(
      expect.objectContaining({ id: registered?.id, address }),
    )

    const disconnected = await store.disconnectWallet(
      {
        requestId: 'source-boundary-disconnect',
        userId,
        sessionId,
        idempotencyKey: `disconnect:${registered?.id ?? ''}`,
      },
      registered?.id ?? '',
      new Date(now.getTime() + 1_000),
    )
    expect(disconnected).toMatchObject({ status: 'DISCONNECTED' })
  })
})
