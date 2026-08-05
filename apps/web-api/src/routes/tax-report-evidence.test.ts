import { createHash } from 'node:crypto'

import { status as grpcStatus } from '@grpc/grpc-js'
import Fastify from 'fastify'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from '../auth/session.js'
import { EngineRpcError } from '../engine/rpc-error.js'
import { ApiError } from '../errors.js'
import type { SourceRequestContext } from '../sources/wallet-source-store.js'
import {
  TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
  type TaxEvidencePackReader,
} from '../tax-report/model-reader.js'
import { registerTaxReportEvidenceRoutes } from './tax-report-evidence.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const REPORT_ID = `tax-report:${'a'.repeat(64)}`

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`
}

const evidencePack = {
  schemaVersion: 'giwa.tax-evidence-pack.v1',
  manifestId: `tax-evidence-pack:${'9'.repeat(64)}`,
  reportId: REPORT_ID,
  subjectId: 'subject-private-value',
  residentId: 'resident-private-value',
  taxYear: 2027,
  taxInventoryRunId: 'tax-inventory-run-1',
  taxEstimateId: 'tax-estimate-1',
  lotRunId: 'lot-run-1',
  generationId: 'generation-1',
  schemaDigest: '1'.repeat(64),
  artifactRoots: [
    { kind: 'TAX_INVENTORY', digest: '2'.repeat(64) },
  ],
  evidenceCoordinates: [
    {
      kind: 'POSTING',
      eventId: 'event-1',
      revisionId: 'revision-1',
      legId: 'leg-1',
    },
  ],
  policy: {
    name: 'giwa-korea-tax-policy',
    version: '2027.1',
    artifactDigest: '3'.repeat(64),
  },
  engine: {
    name: 'giwa-tax-engine',
    version: '1.0.0',
    artifactDigest: '4'.repeat(64),
  },
  issuedAt: '2028-01-10T00:00:00Z',
}

const artifactFor = (value: unknown): TaxEvidencePackArtifact => {
  const bytes = Buffer.from(canonicalJson(value), 'utf8')
  return {
    reportId: REPORT_ID,
    artifactDigest: createHash('sha256').update(bytes).digest('hex'),
    mediaType: TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
    canonicalJson: bytes,
  }
}

class FakeTaxEvidencePackReader implements TaxEvidencePackReader {
  readonly durable = true
  calls: Array<{ context: SourceRequestContext; reportId: string }> = []
  value = artifactFor(evidencePack)
  failure: Error | undefined

  async getTaxEvidencePack(
    context: SourceRequestContext,
    reportId: string,
  ) {
    this.calls.push({ context, reportId })
    if (this.failure) throw this.failure
    return this.value
  }
}

const session: SessionRecord = {
  id: 'session-1',
  user: { id: USER_ID, displayName: '김대장' },
  sessionEpoch: 1,
  createdAt: new Date('2028-01-10T00:00:00Z'),
  lastSeenAt: new Date('2028-01-10T00:00:00Z'),
  absoluteExpiresAt: new Date('2028-01-11T00:00:00Z'),
  idleExpiresAt: new Date('2028-01-10T01:00:00Z'),
}

describe('tax report evidence route', () => {
  let app: ReturnType<typeof Fastify>
  let reader: FakeTaxEvidencePackReader

  beforeEach(async () => {
    app = Fastify({ logger: false })
    app.decorateRequest('authSession', undefined)
    app.addHook('onRequest', async (request: FastifyRequest) => {
      request.authSession =
        request.headers['x-test-unauthenticated'] === 'true'
          ? undefined
          : session
    })
    app.setErrorHandler((
      error: FastifyError,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message },
        })
      }
      throw error
    })
    reader = new FakeTaxEvidencePackReader()
    await registerTaxReportEvidenceRoutes(app, { reader })
  })

  afterEach(async () => app.close())

  it('uses the authenticated subject and strips private identities', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/evidence`,
    })

    expect(response.statusCode).toBe(200)
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toMatchObject({
      context: { userId: USER_ID, sessionId: session.id },
      reportId: REPORT_ID,
    })
    const projected = response.json().evidencePack
    expect(projected).toMatchObject({
      reportId: REPORT_ID,
      taxYear: 2027,
      methodology: {
        taxInventoryRunId: 'tax-inventory-run-1',
        generationId: 'generation-1',
      },
    })
    expect(projected).not.toHaveProperty('subjectId')
    expect(projected).not.toHaveProperty('residentId')
    expect(response.body).not.toContain(evidencePack.subjectId)
    expect(response.body).not.toContain(evidencePack.residentId)
  })

  it('does not query evidence without an authenticated session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/evidence`,
      headers: { 'x-test-unauthenticated': 'true' },
    })

    expect(response.statusCode).toBe(401)
    expect(reader.calls).toHaveLength(0)
  })

  it('conceals missing and cross-subject reports with the same 404', async () => {
    for (const grpcCode of [
      grpcStatus.NOT_FOUND,
      grpcStatus.PERMISSION_DENIED,
    ]) {
      reader.failure = new EngineRpcError(grpcCode)
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tax-reports/${REPORT_ID}/evidence`,
      })

      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({
        error: { code: 'RESOURCE_NOT_FOUND' },
      })
    }
  })

  it('maps upstream and local integrity failures to the same safe 503', async () => {
    reader.failure = new EngineRpcError(
      grpcStatus.DATA_LOSS,
      'private upstream details must not be returned',
    )
    const upstreamFailure = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/evidence`,
    })
    expect(upstreamFailure.statusCode).toBe(503)
    expect(upstreamFailure.json()).toMatchObject({
      error: { code: 'TAX_EVIDENCE_PACK_INCONSISTENT' },
    })
    expect(upstreamFailure.body).not.toContain('private upstream details')

    reader.failure = undefined
    reader.value = {
      ...artifactFor(evidencePack),
      artifactDigest: 'f'.repeat(64),
    }
    const localFailure = await app.inject({
      method: 'GET',
      url: `/api/v1/tax-reports/${REPORT_ID}/evidence`,
    })
    expect(localFailure.statusCode).toBe(503)
    expect(localFailure.json()).toMatchObject({
      error: { code: 'TAX_EVIDENCE_PACK_INCONSISTENT' },
    })
  })
})
