import type { Pool } from 'pg'
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Address,
} from 'viem'

import type {
  ReportAttestationDeploymentConfig,
  ReportAttestationSyntheticTestnetConfig,
} from '../config.js'
import { loadEncryptedKeystoreSigner } from './encrypted-keystore-signer.js'
import {
  loadGiwaSepoliaReportAttestationRuntime,
  type GiwaSepoliaPreparedRecordProjection,
} from './giwa-sepolia-runtime-adapter.js'
import { PostgresReportAttestationOperationStore } from './postgres-operation-store.js'
import { PostgresReportAttestationStore } from './postgres-store.js'
import {
  SYNTHETIC_TESTNET_DERIVATION_RULE_DIGEST,
  SyntheticTestnetReportAttestationPublicationSource,
} from './synthetic-testnet-publication-source.js'
import {
  acquirePostgresAdvisoryLease,
  GIWA_REPORT_WRITER_LEASE_KEY,
  type PostgresAdvisoryLease,
} from './postgres-advisory-lease.js'
import type { Hex32 } from './types.js'

const GIWA_SEPOLIA_CHAIN_ID = 91_342

const giwaSepolia = (rpcUrl: string) =>
  defineChain({
    id: GIWA_SEPOLIA_CHAIN_ID,
    name: 'GIWA Sepolia',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: 'GIWA Sepolia Explorer',
        url: 'https://sepolia-explorer.giwa.io',
      },
    },
    testnet: true,
  })

const normalizeAddress = (value: string) =>
  getAddress(value.toLowerCase())

const deploymentInput = (
  deployment: ReportAttestationDeploymentConfig,
) => ({
  version: 1,
  chainId: GIWA_SEPOLIA_CHAIN_ID,
  eas: deployment.easAddress,
  schemaRegistry: deployment.schemaRegistryAddress,
  registryProxy: deployment.reportRegistryProxyAddress,
  consumer: deployment.reportConsumerAddress,
  schemaUID: deployment.schemaUID,
  expectedEvidenceSchemaDigest:
    deployment.evidenceSchemaDigest,
  governanceSafe: deployment.governanceSafeAddress,
})

const asPreparedProjection = (
  record:
    | Awaited<
        ReturnType<
          PostgresReportAttestationStore['getByPreparedRecordId']
        >
      >
    | undefined,
): GiwaSepoliaPreparedRecordProjection | undefined => {
  if (!record) return undefined
  const value = record.record
  if (
    !value.commitment ||
    !value.safeArtifactDigest ||
    !value.safeManifestDigest ||
    !value.derivationRuleDigest ||
    !value.commitmentNonce
  ) {
    throw new Error(
      'Persisted report attestation preparation is incomplete',
    )
  }
  const submissionAttestationUID =
    value.submission?.status === 'CONFIRMED'
      ? value.submission.attestationUID
      : null
  if (
    submissionAttestationUID !== null &&
    !/^0x[0-9a-fA-F]{64}$/u.test(
      submissionAttestationUID,
    )
  ) {
    throw new Error(
      'Persisted report submission UID is invalid',
    )
  }
  return {
    preparedRecordId: value.preparedRecordId,
    reportId: value.contractReportId,
    revision: value.revision,
    previousSubmissionUID: value.previousSubmissionUID,
    safeArtifactBytes: value.safeArtifactBytes.slice(),
    commitment: value.commitment,
    safeArtifactDigest: value.safeArtifactDigest,
    safeManifestDigest: value.safeManifestDigest,
    derivationRuleDigest: value.derivationRuleDigest,
    commitmentNonce: value.commitmentNonce,
    submissionAttestationUID:
      submissionAttestationUID as Hex32 | null,
  }
}

export const createGiwaSepoliaReportAttestationServerRuntime =
  async (input: {
    pool: Pool
    deployment: ReportAttestationDeploymentConfig
    writer: ReportAttestationSyntheticTestnetConfig
  }) => {
    const publicationSource =
      new SyntheticTestnetReportAttestationPublicationSource()
    const store = new PostgresReportAttestationStore(
      input.pool,
      publicationSource,
      input.deployment,
    )
    const operationStore =
      new PostgresReportAttestationOperationStore(input.pool)
    const expectedIssuer = normalizeAddress(
      input.writer.issuerAddress,
    )
    const expectedReviewer = normalizeAddress(
      input.writer.reviewerAddress,
    )

    let issuer:
      | Awaited<ReturnType<typeof loadEncryptedKeystoreSigner>>
      | undefined
    let reviewer:
      | Awaited<ReturnType<typeof loadEncryptedKeystoreSigner>>
      | undefined
    let writerLease: PostgresAdvisoryLease | undefined
    try {
      const heldWriterLease = await acquirePostgresAdvisoryLease(
        input.pool,
        GIWA_REPORT_WRITER_LEASE_KEY,
      )
      writerLease = heldWriterLease
      issuer = await loadEncryptedKeystoreSigner({
        rpcUrl: input.deployment.rpcUrl,
        keystorePath: input.writer.issuerKeystorePath,
        passwordFile: input.writer.issuerPasswordFile,
      })
      reviewer = await loadEncryptedKeystoreSigner({
        rpcUrl: input.deployment.rpcUrl,
        keystorePath: input.writer.reviewerKeystorePath,
        passwordFile: input.writer.reviewerPasswordFile,
      })
      if (
        normalizeAddress(issuer.address) !== expectedIssuer ||
        normalizeAddress(reviewer.address) !== expectedReviewer ||
        expectedIssuer === expectedReviewer
      ) {
        throw new Error(
          'GIWA report signer address does not match its pinned role',
        )
      }

      const publicClient = createPublicClient({
        chain: giwaSepolia(input.deployment.rpcUrl),
        transport: http(input.deployment.rpcUrl, {
          timeout: 10_000,
        }),
      })
      const checkSignerBalances = async () => {
        const [issuerBalance, reviewerBalance] =
          await Promise.all([
            publicClient.getBalance({
              address: expectedIssuer as Address,
              blockTag: 'safe',
            }),
            publicClient.getBalance({
              address: expectedReviewer as Address,
              blockTag: 'safe',
            }),
          ])
        if (issuerBalance <= 0n || reviewerBalance <= 0n) {
          throw new Error(
            'GIWA report signer balance is unavailable',
          )
        }
      }
      const runtime =
        await loadGiwaSepoliaReportAttestationRuntime({
          deployment: deploymentInput(input.deployment),
          publicClient,
          issuerSigner: issuer.signer,
          reviewerSigner: reviewer.signer,
          operationStore,
          preparedRecordSource: {
            readPreparedRecord: async (preparedRecordId) =>
              asPreparedProjection(
                await store.getByPreparedRecordId(
                  preparedRecordId,
                ),
              ),
          },
          reviewDecisionSource: {
            readAuthenticatedDecision: async () => ({
              outcome: input.writer.reviewOutcome,
              reasonCode: 'SYNTHETIC_POLICY_PASS',
            }),
          },
          derivationRuleDigest:
            SYNTHETIC_TESTNET_DERIVATION_RULE_DIGEST,
          verificationFinality: 'safe',
          minimumConfirmations:
            input.writer.minimumConfirmations,
          close: async () => {
            try {
              issuer?.provider.destroy()
              reviewer?.provider.destroy()
            } finally {
              await heldWriterLease.close()
            }
          },
        })

      return Object.freeze({
        runtime,
        store,
        publicationSource,
        identityKey: input.writer.identityHmacKey,
        reviewOutcome: input.writer.reviewOutcome,
        preflight: async () => {
          await heldWriterLease.readiness()
          await runtime.preflight()
          await checkSignerBalances()
        },
        readiness: async () => {
          await heldWriterLease.readiness()
          await checkSignerBalances()
        },
        close: () => runtime.close(),
      })
    } catch (error) {
      issuer?.provider.destroy()
      reviewer?.provider.destroy()
      await writerLease?.close().catch(() => undefined)
      throw error
    }
  }
