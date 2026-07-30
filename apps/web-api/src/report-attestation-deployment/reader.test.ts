import { describe, expect, it, vi } from 'vitest'

import type { ReportAttestationDeploymentConfig } from '../config.js'
import { HttpReportAttestationDeploymentReader } from './reader.js'

const easAddress = '0x4200000000000000000000000000000000000021'
const schemaRegistryAddress =
  '0x4200000000000000000000000000000000000020'
const reportRegistryProxyAddress =
  '0x1111111111111111111111111111111111111111'
const reportConsumerAddress =
  '0x2222222222222222222222222222222222222222'
const schemaUID = `0x${'a'.repeat(64)}`
const evidenceSchemaDigest = `0x${'b'.repeat(64)}`
const anchorNumber = '0x1234'
const anchorHash = `0x${'c'.repeat(64)}`

const config: ReportAttestationDeploymentConfig = {
  network: 'eip155:91342',
  rpcUrl: 'https://sepolia-rpc.giwa.io/private',
  easAddress,
  schemaRegistryAddress,
  reportRegistryProxyAddress,
  reportConsumerAddress,
  schemaUID,
  evidenceSchemaDigest,
}

const encodeAddress = (address: string) =>
  `0x${'0'.repeat(24)}${address.slice(2)}`

describe('HttpReportAttestationDeploymentReader', () => {
  it('reads and caches the exact GIWA deployment relationships', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          jsonrpc: string
          id: number
          method: string
          params: unknown[]
        }
        let result: string
        if (request.method === 'eth_getBlockByNumber') {
          result = JSON.stringify({
            number: anchorNumber,
            hash: anchorHash,
          })
        } else if (request.method === 'eth_chainId') {
          result = '0x164ce'
        } else if (request.method === 'eth_getCode') {
          result = '0x6000'
        } else {
          const call = request.params[0] as { to: string; data: string }
          if (
            call.to === easAddress &&
            call.data === '0xf10b5cc8'
          ) {
            result = encodeAddress(schemaRegistryAddress)
          } else if (call.data === '0x8150864d') {
            result = encodeAddress(easAddress)
          } else if (call.data === '0xf3de0506') {
            result = schemaUID
          } else if (call.data === '0x805dd454') {
            result = evidenceSchemaDigest
          } else if (call.data === '0x37941dea') {
            result = encodeAddress(reportRegistryProxyAddress)
          } else {
            throw new Error('unexpected RPC call')
          }
        }
        const parsedResult =
          request.method === 'eth_getBlockByNumber'
            ? JSON.parse(result)
            : result
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: parsedResult,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    )
    const reader = new HttpReportAttestationDeploymentReader(config, {
      fetchImpl: fetchMock,
    })

    await expect(reader.read()).resolves.toEqual({
      chainId: 91_342n,
      code: {
        eas: '0x6000',
        schemaRegistry: '0x6000',
        reportRegistryProxy: '0x6000',
        reportConsumer: '0x6000',
      },
      easSchemaRegistryAddress: schemaRegistryAddress,
      registry: {
        easAddress,
        schemaUID,
        evidenceSchemaDigest,
      },
      consumerReportRegistryAddress: reportRegistryProxyAddress,
    })
    await reader.read()
    expect(fetchMock).toHaveBeenCalledTimes(12)
    const stateReads = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)) as {
        method: string
        params: unknown[]
      })
      .filter(({ method }) =>
        method === 'eth_getCode' || method === 'eth_call'
      )
    expect(stateReads).toHaveLength(9)
    expect(stateReads.every(({ params }) => params.at(-1) === anchorNumber))
      .toBe(true)
  })

  it('rejects an RPC error instead of returning a partial snapshot', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32_000, message: 'upstream error' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    )
    const reader = new HttpReportAttestationDeploymentReader(config, {
      fetchImpl: fetchMock,
    })

    await expect(reader.read()).rejects.toThrow(
      'GIWA_REPORT_RPC_RESPONSE_INVALID',
    )
    await expect(reader.read()).rejects.toThrow(
      'GIWA_REPORT_RPC_UNAVAILABLE',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a changed canonical anchor instead of mixing chain state', async () => {
    let blockRead = 0
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number
          method: string
          params: unknown[]
        }
        let result: unknown
        if (request.method === 'eth_getBlockByNumber') {
          blockRead += 1
          result = {
            number: anchorNumber,
            hash:
              blockRead === 1
                ? anchorHash
                : `0x${'d'.repeat(64)}`,
          }
        } else if (request.method === 'eth_chainId') {
          result = '0x164ce'
        } else if (request.method === 'eth_getCode') {
          result = '0x6000'
        } else {
          const call = request.params[0] as { data: string }
          if (call.data === '0xf10b5cc8') {
            result = encodeAddress(schemaRegistryAddress)
          } else if (call.data === '0x8150864d') {
            result = encodeAddress(easAddress)
          } else if (call.data === '0xf3de0506') {
            result = schemaUID
          } else if (call.data === '0x805dd454') {
            result = evidenceSchemaDigest
          } else {
            result = encodeAddress(reportRegistryProxyAddress)
          }
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    )
    const reader = new HttpReportAttestationDeploymentReader(config, {
      fetchImpl: fetchMock,
    })

    await expect(reader.read()).rejects.toThrow(
      'GIWA_REPORT_RPC_ANCHOR_CHANGED',
    )
  })
})
