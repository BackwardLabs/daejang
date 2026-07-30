import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  giwaExplorerAddressUrl,
  loadReportAttestationDeployment,
  parseReportAttestationDeployment,
} from './reportAttestationDeploymentApi.ts'

const easAddress = '0x4200000000000000000000000000000000000021'
const schemaRegistryAddress =
  '0x4200000000000000000000000000000000000020'
const reportRegistryProxyAddress =
  '0x1111111111111111111111111111111111111111'
const reportConsumerAddress =
  '0x2222222222222222222222222222222222222222'
const schemaUID = `0x${'a'.repeat(64)}`
const evidenceSchemaDigest = `0x${'b'.repeat(64)}`

const connectedDeployment = {
  enabled: true,
  network: 'eip155:91342',
  mode: 'READ_ONLY',
  status: 'CONNECTED',
  reasonCode: null,
  addresses: {
    eas: easAddress,
    schemaRegistry: schemaRegistryAddress,
    reportRegistryProxy: reportRegistryProxyAddress,
    reportConsumer: reportConsumerAddress,
  },
  schemaUID,
  evidenceSchemaDigest,
} as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('report attestation deployment API', () => {
  it('loads the authenticated read-only capability', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          enabled: false,
          network: 'eip155:91342',
          mode: 'READ_ONLY',
          status: 'NOT_CONFIGURED',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadReportAttestationDeployment()).resolves.toEqual({
      enabled: false,
      network: 'eip155:91342',
      mode: 'READ_ONLY',
      status: 'NOT_CONFIGURED',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/report-attestations/deployment',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('accepts exact public deployment evidence and builds official explorer links', () => {
    expect(parseReportAttestationDeployment(connectedDeployment)).toEqual(
      connectedDeployment,
    )
    expect(giwaExplorerAddressUrl(reportRegistryProxyAddress)).toBe(
      `https://sepolia-explorer.giwa.io/address/${reportRegistryProxyAddress}`,
    )
  })

  it('rejects leaked server settings and contradictory status claims', () => {
    expect(() =>
      parseReportAttestationDeployment({
        ...connectedDeployment,
        rpcUrl: 'https://private-rpc.example.com/key',
      }),
    ).toThrow('REPORT_ATTESTATION_DEPLOYMENT_RESPONSE_INVALID')
    expect(() =>
      parseReportAttestationDeployment({
        ...connectedDeployment,
        status: 'CONNECTED',
        reasonCode: 'CHAIN_ID_MISMATCH',
      }),
    ).toThrow('REPORT_ATTESTATION_DEPLOYMENT_RESPONSE_INVALID')
    expect(() =>
      parseReportAttestationDeployment({
        ...connectedDeployment,
        addresses: {
          ...connectedDeployment.addresses,
          reportConsumer: '0x0000000000000000000000000000000000000000',
        },
      }),
    ).toThrow('REPORT_ATTESTATION_DEPLOYMENT_RESPONSE_INVALID')
  })
})
