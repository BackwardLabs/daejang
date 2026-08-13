import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EngineMtlsClient } from './mtls-client.js'

const engineTarget = process.env.TEST_ENGINE_GRPC_TARGET
const describeWithEngine =
  process.env.RUN_ENGINE_INTEGRATION_TESTS === '1' && engineTarget
    ? describe
    : describe.skip

describeWithEngine('SourceService integration', () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const sessionId = 'source-service-integration-session'
  const address = '0x1234567890abcdef1234567890abcdef12345679'
  let client: EngineMtlsClient

  beforeAll(async () => {
    client = EngineMtlsClient.connectInsecureLoopback(engineTarget!, true)
    await client.waitForReady(5_000)
  })

  afterAll(() => client.close())

  it('registers, lists, and disconnects a wallet through the Engine', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const registered = await client.registerWallet({
      challengeId: '00000000-0000-4000-8000-000000000501',
      userId,
      recoveredAddress: address,
      accountType: 'CONTRACT',
      verificationChainId: 'eip155:1',
      chainIds: ['eip155:1', 'eip155:8453'],
      label: 'Engine integration wallet',
      now,
      requestId: 'source-register-integration',
      sessionId,
      idempotencyKey: 'source-register-integration',
    })
    expect(registered).toMatchObject({
      address,
      accountType: 'CONTRACT',
      status: 'ACTIVE',
      chainScopes: [
        { chainId: 'eip155:1', status: 'ACTIVE' },
        { chainId: 'eip155:8453', status: 'ACTIVE' },
      ],
    })

    const listed = await client.listWallets({
      requestId: 'source-list-integration',
      userId,
      sessionId,
    })
    expect(listed).toContainEqual(expect.objectContaining({ id: registered.id, address }))

    const disconnected = await client.disconnectWallet(
      {
        requestId: 'source-disconnect-integration',
        userId,
        sessionId,
        idempotencyKey: `disconnect:${registered.id}`,
      },
      registered.id,
      new Date(now.getTime() + 1_000),
    )
    expect(disconnected).toMatchObject({
      id: registered.id,
      status: 'DISCONNECTED',
      chainScopes: [
        { chainId: 'eip155:1', status: 'DISABLED' },
        { chainId: 'eip155:8453', status: 'DISABLED' },
      ],
    })
  })
})
