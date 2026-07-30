import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import type {
  ReportAttestationDeploymentReader,
  ReportAttestationDeploymentSnapshot,
} from '../report-attestation-deployment/reader.js'

const userId = '00000000-0000-4000-8000-000000000028'
const easAddress = '0x4200000000000000000000000000000000000021'
const schemaRegistryAddress =
  '0x4200000000000000000000000000000000000020'
const reportRegistryProxyAddress =
  '0x1111111111111111111111111111111111111111'
const reportConsumerAddress =
  '0x2222222222222222222222222222222222222222'
const governanceSafeAddress =
  '0x3333333333333333333333333333333333333333'
const schemaUID = `0x${'a'.repeat(64)}`
const evidenceSchemaDigest = `0x${'b'.repeat(64)}`

const enabledConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    GIWA_REPORT_ATTESTATIONS_ENABLED: 'true',
    GIWA_REPORT_RPC_URL: 'https://sepolia-rpc.giwa.io/private',
    GIWA_REPORT_EAS_ADDRESS: easAddress,
    GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS: schemaRegistryAddress,
    GIWA_REPORT_REGISTRY_PROXY_ADDRESS: reportRegistryProxyAddress,
    GIWA_REPORT_CONSUMER_ADDRESS: reportConsumerAddress,
    GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS: governanceSafeAddress,
    GIWA_REPORT_SCHEMA_UID: schemaUID,
    GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST: evidenceSchemaDigest,
  })

const connectedSnapshot = (): ReportAttestationDeploymentSnapshot => ({
  chainId: 91_342n,
  code: {
    eas: '0x6000',
    schemaRegistry: '0x6001',
    reportRegistryProxy: '0x6002',
    reportConsumer: '0x6003',
  },
  easSchemaRegistryAddress: schemaRegistryAddress,
  registry: {
    easAddress,
    schemaUID,
    evidenceSchemaDigest,
  },
  consumerReportRegistryAddress: reportRegistryProxyAddress,
})

const readerFor = (
  result:
    | ReportAttestationDeploymentSnapshot
    | Promise<ReportAttestationDeploymentSnapshot>,
): ReportAttestationDeploymentReader => ({
  read: vi.fn(async () => result),
})

describe('GIWA report attestation deployment route', () => {
  const contexts: Awaited<ReturnType<typeof buildApp>>[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.app.close()))
  })

  const authenticatedHeaders = async (
    context: Awaited<ReturnType<typeof buildApp>>,
  ) => {
    const { token } = await context.sessionService.create({
      user: { id: userId, displayName: '김대장' },
    })
    return {
      cookie: `${context.config.sessionCookieName}=${token}`,
    }
  }

  it('keeps the authenticated capability visible and fail-closed when not configured', async () => {
    const context = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      logger: false,
    })
    contexts.push(context)

    const unauthorized = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-attestations/deployment',
    })
    expect(unauthorized.statusCode).toBe(401)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-attestations/deployment',
      headers: await authenticatedHeaders(context),
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      enabled: false,
      network: 'eip155:91342',
      mode: 'READ_ONLY',
      status: 'NOT_CONFIGURED',
    })
  })

  it('reports only the public deployment binding after minimal live reads pass', async () => {
    const context = await buildApp({
      config: enabledConfig(),
      logger: false,
      reportAttestationDeploymentReader: readerFor(connectedSnapshot()),
    })
    contexts.push(context)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-attestations/deployment',
      headers: await authenticatedHeaders(context),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
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
    })
    expect(response.body).not.toContain('sepolia-rpc.giwa.io')
  })

  it('does not call a missing-code deployment connected', async () => {
    const snapshot = connectedSnapshot()
    const context = await buildApp({
      config: enabledConfig(),
      logger: false,
      reportAttestationDeploymentReader: readerFor({
        ...snapshot,
        code: { ...snapshot.code, reportConsumer: '0x' },
      }),
    })
    contexts.push(context)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-attestations/deployment',
      headers: await authenticatedHeaders(context),
    })
    expect(response.json()).toMatchObject({
      enabled: true,
      status: 'MISCONFIGURED',
      reasonCode: 'REPORT_CONSUMER_CODE_MISSING',
    })
  })

  it('fails closed without leaking an RPC failure', async () => {
    const reader: ReportAttestationDeploymentReader = {
      read: vi.fn(async () => {
        throw new Error('private upstream detail')
      }),
    }
    const context = await buildApp({
      config: enabledConfig(),
      logger: false,
      reportAttestationDeploymentReader: reader,
    })
    contexts.push(context)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/report-attestations/deployment',
      headers: await authenticatedHeaders(context),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      enabled: true,
      status: 'UNAVAILABLE',
      reasonCode: 'RPC_UNAVAILABLE',
    })
    expect(response.body).not.toContain('private upstream detail')
  })
})
