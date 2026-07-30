import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseSyntheticReportAttestationSnapshot,
  syntheticReportAttestationApi,
} from './syntheticReportAttestationApi.ts'

const SUBMIT_TX = `0x${'1'.repeat(64)}`
const SUBMIT_UID = `0x${'2'.repeat(64)}`

const capability = {
  enabled: true,
  network: 'eip155:91342',
  mode: 'SYNTHETIC_TESTNET',
  explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
  reasonCode: null,
} as const

const fixture = {
  taxYear: 2025,
  transactionCount: 12,
  completeCount: 10,
  exceptionCount: 2,
  denomination: 'KRW',
} as const

const submitted = {
  lifecycle: 'SUBMITTED',
  failureCode: null,
  submission: {
    status: 'CONFIRMED',
    transactionHash: SUBMIT_TX,
    attestationUID: SUBMIT_UID,
    reasonCode: null,
  },
  review: null,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:01:00.000Z',
} as const

const emptySnapshot = {
  capability,
  fixture,
  status: null,
  verification: null,
} as const

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('synthetic report attestation API', () => {
  it('uses one authenticated GET and two empty POST endpoints', async () => {
    const submittedSnapshot = {
      ...emptySnapshot,
      status: submitted,
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(emptySnapshot))
      .mockResolvedValueOnce(jsonResponse(submittedSnapshot))
      .mockResolvedValueOnce(jsonResponse(submittedSnapshot))
    vi.stubGlobal('fetch', fetchMock)

    await syntheticReportAttestationApi.load()
    await syntheticReportAttestationApi.submit()
    await syntheticReportAttestationApi.review()

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/report-attestations/synthetic-publication',
      '/api/v1/report-attestations/synthetic-publication/submission',
      '/api/v1/report-attestations/synthetic-publication/review',
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ credentials: 'include' }),
    )
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(call[1]?.method).toBe('POST')
      expect(call[1]?.body).toBeUndefined()
      expect(new Headers(call[1]?.headers).has('content-type')).toBe(false)
    }
  })

  it('parses a disabled capability without claiming an onchain result', () => {
    expect(
      parseSyntheticReportAttestationSnapshot({
        capability: {
          enabled: false,
          network: 'eip155:91342',
          mode: 'SYNTHETIC_TESTNET',
          explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
          reasonCode: 'NOT_CONFIGURED',
        },
        fixture,
        status: null,
        verification: null,
      }),
    ).toEqual({
      capability: {
        enabled: false,
        network: 'eip155:91342',
        mode: 'SYNTHETIC_TESTNET',
        explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
        reasonCode: 'NOT_CONFIGURED',
      },
      fixture,
      status: null,
      verification: null,
    })
  })

  it('accepts the local Anvil capability only for the explicit local demo build', () => {
    const localSnapshot = {
      ...emptySnapshot,
      capability: {
        enabled: true,
        network: 'eip155:31337',
        mode: 'LOCAL_ANVIL',
        explorerBaseUrl: null,
        reasonCode: null,
      },
    } as const

    expect(() =>
      parseSyntheticReportAttestationSnapshot(localSnapshot),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')

    vi.stubEnv('VITE_GIWA28_LOCAL_DEMO', 'true')
    expect(
      parseSyntheticReportAttestationSnapshot(localSnapshot),
    ).toEqual(localSnapshot)
  })

  it('rejects internal identifiers and an untrusted explorer origin', () => {
    expect(() =>
      parseSyntheticReportAttestationSnapshot({
        ...emptySnapshot,
        contractReportId: `0x${'f'.repeat(64)}`,
      }),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')

    expect(() =>
      parseSyntheticReportAttestationSnapshot({
        ...emptySnapshot,
        capability: {
          ...capability,
          explorerBaseUrl: 'https://phishing.example',
        },
      }),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')

    expect(() =>
      parseSyntheticReportAttestationSnapshot({
        ...emptySnapshot,
        status: {
          ...submitted,
          reportId: 'private-user-derived-id',
        },
      }),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')
  })

  it('rejects contradictory verification and incomplete receipts', () => {
    expect(() =>
      parseSyntheticReportAttestationSnapshot({
        ...emptySnapshot,
        status: submitted,
        verification: {
          lifecycle: 'SUBMITTED',
          result: 'USABLE',
          reasonCode: null,
        },
      }),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')

    expect(() =>
      parseSyntheticReportAttestationSnapshot({
        ...emptySnapshot,
        status: {
          ...submitted,
          submission: {
            ...submitted.submission,
            transactionHash: null,
          },
        },
      }),
    ).toThrow('SYNTHETIC_REPORT_ATTESTATION_RESPONSE_INVALID')
  })
})
