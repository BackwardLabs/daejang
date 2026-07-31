import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  facilitatorPaymentKeyFor,
  HttpReportPaymentFacilitator,
  type X402PaymentPayload,
  type X402PaymentRequirement,
} from './facilitator.js'

const x402Repository = process.env.DAEJANG_X402_REPO
const describeWithProvider = x402Repository ? describe : describe.skip
const PAYER = '0x3333333333333333333333333333333333333333'
const TRANSACTION = `0x${'7'.repeat(64)}`

const requirement: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:91342',
  asset: '0x1111111111111111111111111111111111111111',
  amount: '100000',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: {
    paymentOrderId: 'contract-order-1',
    pointerVersion: 3,
    resourceDigest: 'a'.repeat(64),
    Z: 'codepoint-first',
    a: 'codepoint-second',
  },
}

const payment: X402PaymentPayload = {
  x402Version: 2,
  accepted: requirement,
  payload: {
    signature: `0x${'1'.repeat(130)}`,
    authorization: {
      from: PAYER,
      to: requirement.payTo,
      value: requirement.amount,
      validAfter: '0',
      validBefore: '9999999999',
      nonce: `0x${'4'.repeat(64)}`,
    },
  },
}

describeWithProvider('daejang-x402 facilitator HTTP contract', () => {
  let provider: ChildProcess
  let facilitator: HttpReportPaymentFacilitator

  beforeAll(async () => {
    const repository = x402Repository as string
    const tsx = path.join(repository, 'node_modules', '.bin', 'tsx')
    const fixture = path.join(
      repository,
      'test',
      'fixtures',
      'facilitator-contract-server.ts',
    )
    await Promise.all([access(tsx), access(fixture)])
    provider = spawn(tsx, [fixture], {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const address = await new Promise<string>((resolve, reject) => {
      const stderr: Buffer[] = []
      provider.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      provider.once('exit', (code) => {
        reject(
          new Error(
            `x402 contract server exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        )
      })
      const lines = readline.createInterface({
        input: provider.stdout!,
        crlfDelay: Infinity,
      })
      lines.once('line', (line) => {
        const value = JSON.parse(line) as { address: string }
        resolve(value.address)
      })
    })
    facilitator = new HttpReportPaymentFacilitator(address)
  })

  afterAll(async () => {
    if (!provider || provider.exitCode !== null) return
    provider.kill('SIGTERM')
    await new Promise<void>((resolve) => provider.once('exit', () => resolve()))
  })

  it('verifies, settles and recovers against the provider implementation', async () => {
    const input = {
      paymentPayload: payment,
      paymentRequirements: requirement,
    }
    const paymentKey = facilitatorPaymentKeyFor(payment)

    await expect(facilitator.verify(input)).resolves.toEqual({
      valid: true,
      payer: PAYER,
    })
    await expect(facilitator.settle(input)).resolves.toEqual({
      status: 'settled',
      paymentKey,
      transaction: TRANSACTION,
      network: 'eip155:91342',
      payer: PAYER,
    })
    await expect(facilitator.recover(paymentKey)).resolves.toEqual({
      status: 'settled',
      paymentKey,
      transaction: TRANSACTION,
    })
  })
})
