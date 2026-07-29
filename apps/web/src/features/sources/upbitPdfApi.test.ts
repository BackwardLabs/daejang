import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRegisterUpbitPdfApi } from './upbitPdfApi.ts'
import type { UpbitPdfRegistrationRequest } from './upbitPdfRegistration.ts'

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const request = (
  overrides: Partial<UpbitPdfRegistrationRequest> = {},
): UpbitPdfRegistrationRequest => ({
  file: new File(['%PDF-1.7 original encrypted'], 'statement.pdf', {
    type: 'application/pdf',
  }),
  intentKey: 'upbit-intent',
  password: 'synthetic-password',
  coverageStart: '2027-01-01',
  coverageEnd: '2027-12-31',
  onStageChange: () => undefined,
  signal: new AbortController().signal,
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Upbit PDF direct import', () => {
  it('uploads the encrypted original and sends an ephemeral password envelope to the import boundary', async () => {
    const encodedPassword = new TextEncoder().encode('synthetic-password')
    const encodePassword = vi.fn(() => encodedPassword)
    const responses = [
      jsonResponse({
        uploadId: '00000000-0000-4000-8000-000000000010',
        uploadUrl: '/api/v1/uploads/00000000-0000-4000-8000-000000000010/content',
        state: 'PENDING',
      }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({
        source: { id: '00000000-0000-4000-8000-000000000020' },
        job: { id: '00000000-0000-4000-8000-000000000030', state: 'SUCCEEDED' },
        evidenceTerminalStatus: 'PARTIAL',
        sourceRecordCount: 12,
        normalizedRecordCount: 0,
      }, 201),
    ]
    let passwordEnvelope: ArrayBuffer | undefined
    let passwordSnapshot: Uint8Array | undefined
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST' && init.headers && init.body instanceof ArrayBuffer) {
        passwordEnvelope = init.body
        passwordSnapshot = new Uint8Array(init.body.slice(0))
      }
      return responses.shift() as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const stages: string[] = []

    await expect(createRegisterUpbitPdfApi(encodePassword)(request({
      onStageChange: (stage) => stages.push(stage),
    }))).resolves.toEqual({
      ok: true,
      sourceId: '00000000-0000-4000-8000-000000000020',
      sourceStatus: 'UPLOADED',
      evidenceTerminalStatus: 'PARTIAL',
      sourceRecordCount: 12,
      normalizedRecordCount: 0,
    })

    expect(stages).toEqual([
      'DOCUMENT_PREPARING',
      'DOCUMENT_UPLOADING',
      'SOURCE_SUBMITTING',
      'DOCUMENT_PROCESSING',
    ])
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeInstanceOf(File)
    expect(passwordSnapshot?.[0]).toBe(1)
    expect(new TextDecoder().decode(passwordSnapshot!.subarray(1))).toBe('synthetic-password')
    expect(encodedPassword.every((value) => value === 0)).toBe(true)
    expect(passwordEnvelope && [...new Uint8Array(passwordEnvelope)].every((value) => value === 0)).toBe(true)
  })

  it('continues the same confirmed encrypted-original upload on an idempotent retry', async () => {
    const responses = [
      jsonResponse({
        uploadId: '00000000-0000-4000-8000-000000000010',
        uploadUrl: '/api/v1/uploads/00000000-0000-4000-8000-000000000010/content',
        state: 'CONFIRMED',
      }, 201),
      jsonResponse({
        source: { id: '00000000-0000-4000-8000-000000000020' },
        job: { id: '00000000-0000-4000-8000-000000000030', state: 'SUCCEEDED' },
        evidenceTerminalStatus: 'PARTIAL', sourceRecordCount: 1, normalizedRecordCount: 0,
      }, 201),
    ]
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift() as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await createRegisterUpbitPdfApi()(request())
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it.each([
    ['PDF_PASSWORD_INVALID', 422, 'PASSWORD_INVALID'],
    ['VERIFIED_IDENTITY_REQUIRED', 403, 'IDENTITY_VERIFICATION_REQUIRED'],
    ['SUBJECT_MISMATCH', 422, 'SUBJECT_MISMATCH'],
    ['IMPORT_IN_PROGRESS', 409, 'PROCESSING_TIMEOUT'],
  ])('maps the server %s boundary to a fixed UI recovery code', async (
    serverCode,
    status,
    expectedCode,
  ) => {
    const responses = [
      jsonResponse({
        uploadId: '00000000-0000-4000-8000-000000000010',
        uploadUrl: '/api/v1/uploads/00000000-0000-4000-8000-000000000010/content',
        state: 'CONFIRMED',
      }, 201),
      jsonResponse({ error: { code: serverCode, message: 'safe public error' } }, status),
    ]
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => responses.shift() as Response))

    const result = await createRegisterUpbitPdfApi()(request())

    expect(result).toEqual({
      ok: false,
      error: { code: expectedCode, requestId: serverCode },
    })
  })
})
