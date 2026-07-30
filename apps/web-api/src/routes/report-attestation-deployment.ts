import type { FastifyInstance } from 'fastify'

import type { ReportAttestationDeploymentConfig } from '../config.js'
import type {
  ReportAttestationDeploymentReader,
  ReportAttestationDeploymentSnapshot,
} from '../report-attestation-deployment/reader.js'

const network = 'eip155:91342' as const
const mode = 'READ_ONLY' as const

const reasonCodes = [
  'RPC_UNAVAILABLE',
  'CHAIN_ID_MISMATCH',
  'EAS_CODE_MISSING',
  'SCHEMA_REGISTRY_CODE_MISSING',
  'REPORT_REGISTRY_CODE_MISSING',
  'REPORT_CONSUMER_CODE_MISSING',
  'EAS_SCHEMA_REGISTRY_MISMATCH',
  'REGISTRY_EAS_MISMATCH',
  'REGISTRY_SCHEMA_UID_MISMATCH',
  'REGISTRY_EVIDENCE_SCHEMA_DIGEST_MISMATCH',
  'CONSUMER_REGISTRY_MISMATCH',
] as const

export type ReportAttestationDeploymentReasonCode =
  (typeof reasonCodes)[number]

type EnabledDeploymentStatus = 'CONNECTED' | 'UNAVAILABLE' | 'MISCONFIGURED'

export type ReportAttestationDeploymentResponse =
  | Readonly<{
      enabled: false
      network: typeof network
      mode: typeof mode
      status: 'NOT_CONFIGURED'
    }>
  | Readonly<{
      enabled: true
      network: typeof network
      mode: typeof mode
      status: EnabledDeploymentStatus
      reasonCode: ReportAttestationDeploymentReasonCode | null
      addresses: Readonly<{
        eas: string
        schemaRegistry: string
        reportRegistryProxy: string
        reportConsumer: string
      }>
      schemaUID: string
      evidenceSchemaDigest: string
    }>

type RouteOptions = Readonly<{
  config?: ReportAttestationDeploymentConfig
  reader?: ReportAttestationDeploymentReader
}>

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const hasNoRuntimeCode = (code: string) =>
  code === '0x' || /^0x0+$/u.test(code)

const assessSnapshot = (
  config: ReportAttestationDeploymentConfig,
  snapshot: ReportAttestationDeploymentSnapshot,
): Readonly<{
  status: 'CONNECTED' | 'MISCONFIGURED'
  reasonCode: ReportAttestationDeploymentReasonCode | null
}> => {
  if (snapshot.chainId !== 91_342n) {
    return { status: 'MISCONFIGURED', reasonCode: 'CHAIN_ID_MISMATCH' }
  }
  if (hasNoRuntimeCode(snapshot.code.eas)) {
    return { status: 'MISCONFIGURED', reasonCode: 'EAS_CODE_MISSING' }
  }
  if (hasNoRuntimeCode(snapshot.code.schemaRegistry)) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'SCHEMA_REGISTRY_CODE_MISSING',
    }
  }
  if (hasNoRuntimeCode(snapshot.code.reportRegistryProxy)) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'REPORT_REGISTRY_CODE_MISSING',
    }
  }
  if (hasNoRuntimeCode(snapshot.code.reportConsumer)) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'REPORT_CONSUMER_CODE_MISSING',
    }
  }
  if (
    !sameAddress(
      snapshot.easSchemaRegistryAddress,
      config.schemaRegistryAddress,
    )
  ) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'EAS_SCHEMA_REGISTRY_MISMATCH',
    }
  }
  if (!sameAddress(snapshot.registry.easAddress, config.easAddress)) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'REGISTRY_EAS_MISMATCH',
    }
  }
  if (
    snapshot.registry.schemaUID.toLowerCase() !==
    config.schemaUID.toLowerCase()
  ) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'REGISTRY_SCHEMA_UID_MISMATCH',
    }
  }
  if (
    snapshot.registry.evidenceSchemaDigest.toLowerCase() !==
    config.evidenceSchemaDigest.toLowerCase()
  ) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'REGISTRY_EVIDENCE_SCHEMA_DIGEST_MISMATCH',
    }
  }
  if (
    !sameAddress(
      snapshot.consumerReportRegistryAddress,
      config.reportRegistryProxyAddress,
    )
  ) {
    return {
      status: 'MISCONFIGURED',
      reasonCode: 'CONSUMER_REGISTRY_MISMATCH',
    }
  }
  return { status: 'CONNECTED', reasonCode: null }
}

const configuredResponse = (
  config: ReportAttestationDeploymentConfig,
  status: EnabledDeploymentStatus,
  reasonCode: ReportAttestationDeploymentReasonCode | null,
): Extract<ReportAttestationDeploymentResponse, { enabled: true }> => ({
  enabled: true,
  network,
  mode,
  status,
  reasonCode,
  addresses: {
    eas: config.easAddress,
    schemaRegistry: config.schemaRegistryAddress,
    reportRegistryProxy: config.reportRegistryProxyAddress,
    reportConsumer: config.reportConsumerAddress,
  },
  schemaUID: config.schemaUID,
  evidenceSchemaDigest: config.evidenceSchemaDigest,
})

export const registerReportAttestationDeploymentRoutes = async (
  app: FastifyInstance,
  options: RouteOptions,
) => {
  app.get(
    '/api/v1/report-attestations/deployment',
    {
      schema: {
        response: {
          200: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['enabled', 'network', 'mode', 'status'],
                properties: {
                  enabled: { type: 'boolean', const: false },
                  network: { type: 'string', const: network },
                  mode: { type: 'string', const: mode },
                  status: { type: 'string', const: 'NOT_CONFIGURED' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'enabled',
                  'network',
                  'mode',
                  'status',
                  'reasonCode',
                  'addresses',
                  'schemaUID',
                  'evidenceSchemaDigest',
                ],
                properties: {
                  enabled: { type: 'boolean', const: true },
                  network: { type: 'string', const: network },
                  mode: { type: 'string', const: mode },
                  status: {
                    type: 'string',
                    enum: ['CONNECTED', 'UNAVAILABLE', 'MISCONFIGURED'],
                  },
                  reasonCode: {
                    anyOf: [
                      { type: 'null' },
                      { type: 'string', enum: [...reasonCodes] },
                    ],
                  },
                  addresses: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'eas',
                      'schemaRegistry',
                      'reportRegistryProxy',
                      'reportConsumer',
                    ],
                    properties: {
                      eas: { type: 'string' },
                      schemaRegistry: { type: 'string' },
                      reportRegistryProxy: { type: 'string' },
                      reportConsumer: { type: 'string' },
                    },
                  },
                  schemaUID: { type: 'string' },
                  evidenceSchemaDigest: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
    async (_request, reply): Promise<ReportAttestationDeploymentResponse> => {
      reply.header('cache-control', 'private, no-store')
      if (!options.config) {
        return {
          enabled: false,
          network,
          mode,
          status: 'NOT_CONFIGURED',
        }
      }

      try {
        const snapshot = await options.reader?.read()
        if (!snapshot) {
          return configuredResponse(
            options.config,
            'UNAVAILABLE',
            'RPC_UNAVAILABLE',
          )
        }
        const assessment = assessSnapshot(options.config, snapshot)
        return configuredResponse(
          options.config,
          assessment.status,
          assessment.reasonCode,
        )
      } catch {
        return configuredResponse(
          options.config,
          'UNAVAILABLE',
          'RPC_UNAVAILABLE',
        )
      }
    },
  )
}
