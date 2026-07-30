import type { Pool } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ReportAttestationDeploymentConfig,
  ReportAttestationSyntheticTestnetConfig,
} from '../config.js'

const mocks = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  leaseReadiness: vi.fn(),
  leaseClose: vi.fn(),
  loadSigner: vi.fn(),
  issuerDestroy: vi.fn(),
  reviewerDestroy: vi.fn(),
  loadRuntime: vi.fn(),
  runtimePreflight: vi.fn(),
  runtimeClose: vi.fn(),
  getBalance: vi.fn(),
}))

vi.mock('./postgres-advisory-lease.js', () => ({
  GIWA_REPORT_WRITER_LEASE_KEY:
    'giwa.report-attestation.writer.eip155:91342.v1',
  acquirePostgresAdvisoryLease: mocks.acquireLease,
}))

vi.mock('./encrypted-keystore-signer.js', () => ({
  loadEncryptedKeystoreSigner: mocks.loadSigner,
}))

vi.mock('./giwa-sepolia-runtime-adapter.js', () => ({
  loadGiwaSepoliaReportAttestationRuntime: mocks.loadRuntime,
}))

vi.mock('viem', () => ({
  createPublicClient: () => ({
    getBalance: mocks.getBalance,
  }),
  defineChain: (input: unknown) => input,
  getAddress: (input: string) => input.toLowerCase(),
  http: () => ({}),
}))

import { createGiwaSepoliaReportAttestationServerRuntime } from './giwa-sepolia-server-runtime.js'

const ISSUER = '0x1111111111111111111111111111111111111111'
const REVIEWER = '0x2222222222222222222222222222222222222222'

const deployment: ReportAttestationDeploymentConfig = {
  network: 'eip155:91342',
  rpcUrl: 'https://sepolia-rpc.giwa.io',
  easAddress: '0x4200000000000000000000000000000000000021',
  schemaRegistryAddress:
    '0x4200000000000000000000000000000000000020',
  reportRegistryProxyAddress:
    '0x3333333333333333333333333333333333333333',
  reportConsumerAddress:
    '0x4444444444444444444444444444444444444444',
  governanceSafeAddress:
    '0x5555555555555555555555555555555555555555',
  schemaUID: `0x${'6'.repeat(64)}`,
  evidenceSchemaDigest: `0x${'7'.repeat(64)}`,
}

const writer: ReportAttestationSyntheticTestnetConfig = {
  identityHmacKey: Buffer.alloc(32, 1),
  issuerAddress: ISSUER,
  issuerKeystorePath: '/run/secrets/issuer.json',
  issuerPasswordFile: '/run/secrets/issuer-password',
  reviewerAddress: REVIEWER,
  reviewerKeystorePath: '/run/secrets/reviewer.json',
  reviewerPasswordFile: '/run/secrets/reviewer-password',
  minimumConfirmations: 1,
  dailyWriteLimits: {
    user: 2,
    ip: 4,
    global: 100,
  },
  explorerBaseUrl: 'https://sepolia-explorer.giwa.io',
  reviewOutcome: 'APPROVE',
}

const pool = {} as Pool

describe('GIWA Sepolia server runtime writer lease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.acquireLease.mockResolvedValue({
      readiness: mocks.leaseReadiness,
      close: mocks.leaseClose,
    })
    mocks.leaseReadiness.mockResolvedValue(undefined)
    mocks.leaseClose.mockResolvedValue(undefined)
    mocks.loadSigner.mockImplementation(
      async ({ keystorePath }: { keystorePath: string }) =>
        keystorePath.includes('issuer')
          ? {
              address: ISSUER,
              signer: { role: 'issuer' },
              provider: { destroy: mocks.issuerDestroy },
            }
          : {
              address: REVIEWER,
              signer: { role: 'reviewer' },
              provider: { destroy: mocks.reviewerDestroy },
            },
    )
    mocks.runtimePreflight.mockResolvedValue(undefined)
    let runtimeClosePromise: Promise<void> | undefined
    mocks.loadRuntime.mockImplementation(
      async (input: { close: () => Promise<void> }) => {
        mocks.runtimeClose.mockImplementation(() => {
          runtimeClosePromise ??= input.close()
          return runtimeClosePromise
        })
        return {
          preflight: mocks.runtimePreflight,
          close: mocks.runtimeClose,
        }
      },
    )
    mocks.getBalance.mockResolvedValue(1n)
  })

  it('checks the lease for preflight and readiness and releases it through runtime close', async () => {
    const resources =
      await createGiwaSepoliaReportAttestationServerRuntime({
        pool,
        deployment,
        writer,
      })

    await resources.preflight()
    await resources.readiness()
    await resources.close()
    await resources.close()

    expect(mocks.acquireLease).toHaveBeenCalledOnce()
    expect(mocks.acquireLease).toHaveBeenCalledWith(
      pool,
      'giwa.report-attestation.writer.eip155:91342.v1',
    )
    expect(mocks.leaseReadiness).toHaveBeenCalledTimes(2)
    expect(mocks.runtimePreflight).toHaveBeenCalledOnce()
    expect(mocks.getBalance).toHaveBeenCalledTimes(4)
    expect(mocks.leaseClose).toHaveBeenCalledOnce()
    expect(mocks.issuerDestroy).toHaveBeenCalledOnce()
    expect(mocks.reviewerDestroy).toHaveBeenCalledOnce()
  })

  it('releases the lease when startup fails after acquisition', async () => {
    mocks.loadSigner
      .mockResolvedValueOnce({
        address: ISSUER,
        signer: { role: 'issuer' },
        provider: { destroy: mocks.issuerDestroy },
      })
      .mockRejectedValueOnce(new Error('reviewer keystore unavailable'))

    await expect(
      createGiwaSepoliaReportAttestationServerRuntime({
        pool,
        deployment,
        writer,
      }),
    ).rejects.toThrow('reviewer keystore unavailable')

    expect(mocks.leaseClose).toHaveBeenCalledOnce()
    expect(mocks.issuerDestroy).toHaveBeenCalledOnce()
    expect(mocks.loadRuntime).not.toHaveBeenCalled()
  })
})
