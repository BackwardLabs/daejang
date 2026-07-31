import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createHash,
  randomBytes,
} from 'node:crypto'

import {
  GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND,
  type GiwaSepoliaReportAttestationRuntime,
  type Hex32,
  type PreparedReportInput,
  type PreparedSyntheticEvidence,
  type RedactedExecutionResult,
} from './types.js'
import type {
  ReportAttestationOperationAction,
  ReportAttestationOperationClaim,
  ReportAttestationOperationResultStatus,
  ReportAttestationOperationStore,
} from './postgres-operation-store.js'

const CONTRACTS_MODULE_SPECIFIER =
  '@backward-labs/daejang-contracts/giwa-sepolia-v1'
const CONTRACTS_FACTORY_EXPORT =
  'createGiwaSepoliaReportRuntimeV1'
const GIWA_SEPOLIA_CHAIN_ID = 91_342
const ZERO_BYTES32 =
  `0x${'00'.repeat(32)}` as Hex32
const WRITE_STATUSES = new Set([
  'CONFIRMED',
  'PENDING',
  'RETRY_REQUIRED',
  'RECONCILIATION_REQUIRED',
])

type UnknownRecord = Record<string, unknown>
type UnknownFunction = (...args: unknown[]) => unknown
type Hex = `0x${string}`

type RawPreparedReport = Readonly<{
  version: 1
  preparedRecordId: string
  deploymentBindingId: Hex32
  reportId: Hex32
  revision: number
  previousSubmissionUID: Hex32
  commitment: Hex32
  commitmentVersion: number
  evidenceSchemaDigest: Hex32
  derivationRuleDigest: Hex32
  safeManifestBytes: Hex
  nonce: Hex32
}>

type RawWriteResult = Readonly<{
  status:
    | 'CONFIRMED'
    | 'PENDING'
    | 'RETRY_REQUIRED'
    | 'RECONCILIATION_REQUIRED'
  operationKey: string
  fingerprint: Hex32
  transactionHash: Hex32 | null
  attestationUID: Hex32 | null
  reasonCode: string | null
}>

type RawRuntime = Readonly<{
  prepare(input: unknown): unknown
  preflight(): Promise<unknown>
  submit(prepared: unknown): Promise<unknown>
  decide(
    prepared: unknown,
    submissionUID: Hex32,
  ): Promise<unknown>
  reconcileDecision(
    prepared: unknown,
    submissionUID: Hex32,
    transactionHash: Hex32,
  ): Promise<unknown>
  readReport(
    reportId: Hex32,
    candidateUID?: Hex32,
  ): Promise<unknown>
  verify(input: unknown): Promise<unknown>
}>

export type GiwaSepoliaPreparedRecordProjection = Readonly<{
  preparedRecordId: string
  reportId: Hex32
  revision: number
  previousSubmissionUID: Hex32
  safeArtifactBytes: Uint8Array
  commitment: Hex32
  safeArtifactDigest: Hex32
  safeManifestDigest: Hex32
  derivationRuleDigest: Hex32
  commitmentNonce: Hex32
  submissionAttestationUID: Hex32 | null
}>

export interface GiwaSepoliaPreparedRecordSource {
  readPreparedRecord(
    preparedRecordId: string,
  ): Promise<GiwaSepoliaPreparedRecordProjection | undefined>
}

export interface GiwaSepoliaTrustedReviewDecisionSource {
  readAuthenticatedDecision(input: {
    preparedRecordId: string
    submissionUID: Hex32
    reportId: Hex32
    revision: number
    commitment: Hex32
    evidenceSchemaDigest: Hex32
    derivationRuleDigest: Hex32
  }): Promise<{
    outcome: 'APPROVE' | 'REJECT'
    reasonCode: string
  }>
}

export interface GiwaSepoliaTransactionSigner {
  getAddress(): Promise<string>
  sendTransaction(input: {
    chainId: number
    to: string
    data: string
    value: bigint
  }): Promise<unknown>
}

export type LoadGiwaSepoliaReportRuntimeOptions = Readonly<{
  deployment: unknown
  publicClient: unknown
  issuerSigner: GiwaSepoliaTransactionSigner
  reviewerSigner: GiwaSepoliaTransactionSigner
  operationStore: ReportAttestationOperationStore
  preparedRecordSource: GiwaSepoliaPreparedRecordSource
  reviewDecisionSource: GiwaSepoliaTrustedReviewDecisionSource
  /**
   * Optional deployment allowlist. When present, publications using any other
   * derivation policy fail before preparation or signing.
   */
  derivationRuleDigest?: Hex32
  verificationFinality?: 'safe' | 'finalized'
  /**
   * Additional receipt depth required before the durable operation is marked
   * CONFIRMED. The contracts runtime already verifies the receipt and
   * post-state at depth 1; this adapter can wait for a stricter deployment
   * policy without changing the signed request.
   */
  minimumConfirmations?: number
  now?: () => Date
  nonceSource?: () => Hex32
  close?: () => Promise<void>
  /**
   * Test seam only. Production callers leave this undefined so the verified
   * package export is dynamically loaded.
   */
  contractsModule?: unknown
}>

export interface ProductionGiwaSepoliaReportRuntime
  extends GiwaSepoliaReportAttestationRuntime {
  preflight(): Promise<void>
}

type OperationContext = {
  preparedRecordId: string
  broadcastAllowed: boolean
  action: ReportAttestationOperationAction | null
  claim: ReportAttestationOperationClaim | null
  requestOperationKey: string | null
  requestFingerprint: Hex32 | null
  observedTransactionHash: Hex32 | null
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value)

const hasExactKeys = (
  value: UnknownRecord,
  expected: readonly string[],
) => {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every(
      (key, index) => key === sortedExpected[index],
    )
  )
}

const isHex32 = (value: unknown): value is Hex32 =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{64}$/.test(value)

const isHex = (value: unknown): value is Hex =>
  typeof value === 'string' &&
  /^0x(?:[0-9a-fA-F]{2})*$/.test(value)

const normalizeHex32 = (
  value: unknown,
  label: string,
): Hex32 => {
  if (!isHex32(value)) {
    throw new Error(`${label} must be bytes32`)
  }
  return value.toLowerCase() as Hex32
}

const digest = (bytes: Uint8Array) =>
  `0x${createHash('sha256')
    .update(bytes)
    .digest('hex')}` as Hex32

const bytesFromHex = (value: Hex) =>
  Uint8Array.from(Buffer.from(value.slice(2), 'hex'))

const normalizePreparedRecordId = (
  value: unknown,
) => {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(value)
  ) {
    throw new Error('Prepared record ID is invalid')
  }
  return value
}

const validateRawPrepared = (
  value: unknown,
): RawPreparedReport => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'preparedRecordId',
      'deploymentBindingId',
      'reportId',
      'revision',
      'previousSubmissionUID',
      'commitment',
      'commitmentVersion',
      'evidenceSchemaDigest',
      'derivationRuleDigest',
      'safeManifestBytes',
      'nonce',
    ]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Number.isSafeInteger(value.commitmentVersion)
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  return {
    version: 1,
    preparedRecordId: normalizePreparedRecordId(
      value.preparedRecordId,
    ),
    deploymentBindingId: normalizeHex32(
      value.deploymentBindingId,
      'Deployment binding ID',
    ),
    reportId: normalizeHex32(value.reportId, 'Report ID'),
    revision: value.revision as number,
    previousSubmissionUID: normalizeHex32(
      value.previousSubmissionUID,
      'Previous submission UID',
    ),
    commitment: normalizeHex32(
      value.commitment,
      'Commitment',
    ),
    commitmentVersion: value.commitmentVersion as number,
    evidenceSchemaDigest: normalizeHex32(
      value.evidenceSchemaDigest,
      'Evidence schema digest',
    ),
    derivationRuleDigest: normalizeHex32(
      value.derivationRuleDigest,
      'Derivation rule digest',
    ),
    safeManifestBytes:
      isHex(value.safeManifestBytes) &&
      value.safeManifestBytes.length === 2 + 128 * 2
        ? (value.safeManifestBytes.toLowerCase() as Hex)
        : (() => {
            throw new GiwaSepoliaContractsRuntimeError(
              'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
            )
          })(),
    nonce: normalizeHex32(value.nonce, 'Commitment nonce'),
  }
}

const validateRawWriteResult = (
  value: unknown,
): RawWriteResult => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'status',
      'operationKey',
      'fingerprint',
      'transactionHash',
      'attestationUID',
      'reasonCode',
    ]) ||
    typeof value.status !== 'string' ||
    !WRITE_STATUSES.has(value.status) ||
    typeof value.operationKey !== 'string' ||
    value.operationKey.length < 1 ||
    value.operationKey.length > 1_024 ||
    !isHex32(value.fingerprint) ||
    (value.transactionHash !== null &&
      !isHex32(value.transactionHash)) ||
    (value.attestationUID !== null &&
      !isHex32(value.attestationUID)) ||
    (value.reasonCode !== null &&
      (typeof value.reasonCode !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(
          value.reasonCode,
        )))
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  if (
    value.status === 'CONFIRMED' &&
    (value.transactionHash === null ||
      value.attestationUID === null ||
      value.reasonCode !== null)
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  if (
    value.status !== 'CONFIRMED' &&
    value.reasonCode === null
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  return {
    status: value.status as RawWriteResult['status'],
    operationKey: value.operationKey,
    fingerprint: value.fingerprint.toLowerCase() as Hex32,
    transactionHash:
      value.transactionHash === null
        ? null
        : (value.transactionHash.toLowerCase() as Hex32),
    attestationUID:
      value.attestationUID === null
        ? null
        : (value.attestationUID.toLowerCase() as Hex32),
    reasonCode: value.reasonCode as string | null,
  }
}

const validateReviewDecision = (value: unknown) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['outcome', 'reasonCode']) ||
    (value.outcome !== 'APPROVE' &&
      value.outcome !== 'REJECT') ||
    typeof value.reasonCode !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reasonCode)
  ) {
    throw new Error(
      'Authenticated review decision is invalid',
    )
  }
  return {
    outcome: value.outcome,
    reasonCode: value.reasonCode,
  } as const
}

const validateRuntime = (value: unknown): RawRuntime => {
  if (
    !isRecord(value) ||
    typeof value.prepare !== 'function' ||
    typeof value.preflight !== 'function' ||
    typeof value.submit !== 'function' ||
    typeof value.decide !== 'function' ||
    typeof value.reconcileDecision !== 'function' ||
    typeof value.readReport !== 'function' ||
    typeof value.verify !== 'function'
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  return value as unknown as RawRuntime
}

const validatePreparedProjection = (
  value: unknown,
): GiwaSepoliaPreparedRecordProjection => {
  if (
    !isRecord(value) ||
    !(value.safeArtifactBytes instanceof Uint8Array) ||
    value.safeArtifactBytes.byteLength < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.submissionAttestationUID !== null &&
      !isHex32(value.submissionAttestationUID))
  ) {
    throw new Error(
      'Persisted prepared report projection is invalid',
    )
  }
  return {
    preparedRecordId: normalizePreparedRecordId(
      value.preparedRecordId,
    ),
    reportId: normalizeHex32(value.reportId, 'Report ID'),
    revision: value.revision as number,
    previousSubmissionUID: normalizeHex32(
      value.previousSubmissionUID,
      'Previous submission UID',
    ),
    safeArtifactBytes: value.safeArtifactBytes.slice(),
    commitment: normalizeHex32(
      value.commitment,
      'Commitment',
    ),
    safeArtifactDigest: normalizeHex32(
      value.safeArtifactDigest,
      'Safe artifact digest',
    ),
    safeManifestDigest: normalizeHex32(
      value.safeManifestDigest,
      'Safe manifest digest',
    ),
    derivationRuleDigest: normalizeHex32(
      value.derivationRuleDigest,
      'Derivation rule digest',
    ),
    commitmentNonce: normalizeHex32(
      value.commitmentNonce,
      'Commitment nonce',
    ),
    submissionAttestationUID:
      value.submissionAttestationUID === null
        ? null
        : (value.submissionAttestationUID.toLowerCase() as Hex32),
  }
}

const validateAddress = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value)
  ) {
    throw new Error('Signer address is invalid')
  }
  return value
}

const configuredEasAddress = (deployment: unknown) => {
  if (
    !isRecord(deployment) ||
    typeof deployment.eas !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(deployment.eas)
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  return deployment.eas.toLowerCase()
}

const requestFingerprint = (request: {
  chainId: number
  to: string
  data: string
  value: bigint
}) =>
  `0x${createHash('sha256')
    .update('giwa.report-attestation.send-request.v1')
    .update('\u0000')
    .update(String(request.chainId))
    .update('\u0000')
    .update(request.to.toLowerCase())
    .update('\u0000')
    .update(request.data.toLowerCase())
    .update('\u0000')
    .update(request.value.toString())
    .digest('hex')}` as Hex32

const transactionHashFromResponse = (
  value: unknown,
): Hex32 => {
  if (isHex32(value)) {
    return value.toLowerCase() as Hex32
  }
  if (isRecord(value) && isHex32(value.hash)) {
    return value.hash.toLowerCase() as Hex32
  }
  throw new Error(
    'Signer did not return a transaction hash',
  )
}

const resultStatusForAction = (
  action: ReportAttestationOperationAction,
): ReportAttestationOperationResultStatus =>
  action === 'SUBMIT'
    ? 'SUBMITTED'
    : action === 'APPROVE'
      ? 'USABLE'
      : 'UNUSABLE'

export class GiwaSepoliaContractsRuntimeError extends Error {
  constructor(
    readonly code:
      | 'GIWA_CONTRACTS_MODULE_UNAVAILABLE'
      | 'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE'
      | 'GIWA_PREPARED_RECORD_UNAVAILABLE'
      | 'GIWA_PREPARED_RECORD_MISMATCH',
  ) {
    super(code)
    this.name = 'GiwaSepoliaContractsRuntimeError'
  }
}

class OnceOnlyAttestationSigner {
  constructor(
    private readonly signer: GiwaSepoliaTransactionSigner,
    private readonly operations:
      ReportAttestationOperationStore,
    private readonly context:
      AsyncLocalStorage<OperationContext>,
    private readonly defaultAction:
      | 'SUBMIT'
      | null,
    private readonly expectedEasAddress: string,
  ) {}

  getAddress() {
    return this.signer.getAddress().then(validateAddress)
  }

  async sendTransaction(requestValue: unknown) {
    const request = this.#validateRequest(requestValue)
    const context = this.context.getStore()
    if (context?.broadcastAllowed === false) {
      throw new Error(
        'Attestation broadcast is disabled during reconciliation',
      )
    }
    const action = this.defaultAction ?? context?.action
    if (!context || action === null || action === undefined) {
      throw new Error(
        'Attestation signer was called outside an authenticated operation',
      )
    }
    const fingerprint = requestFingerprint(request)
    const claim = await this.operations.claimForBroadcast({
      canonicalOperationKey: request.operationKey,
      preparedRecordId: context.preparedRecordId,
      action,
      planFingerprint: request.fingerprint,
      requestFingerprint: fingerprint,
    })
    context.claim = claim
    context.requestOperationKey = request.operationKey
    context.requestFingerprint = request.fingerprint

    if (claim.disposition === 'REPLAY_CONFIRMED') {
      return claim.transactionHash
    }
    if (claim.disposition !== 'CLAIMED') {
      throw new Error(
        'Attestation operation requires reconciliation',
      )
    }

    let transactionHash: Hex32 | null = null
    try {
      transactionHash = transactionHashFromResponse(
        await this.signer.sendTransaction({
          chainId: request.chainId,
          to: request.to,
          data: request.data,
          value: request.value,
        }),
      )
      context.observedTransactionHash = transactionHash
      await this.operations.recordTransactionHash({
        canonicalOperationKey: request.operationKey,
        planFingerprint: request.fingerprint,
        transactionHash,
      })
      return transactionHash
    } catch {
      try {
        await this.operations.requireReconciliation({
          canonicalOperationKey: request.operationKey,
          planFingerprint: request.fingerprint,
          transactionHash,
          reasonCode: 'BROADCAST_OUTCOME_UNKNOWN',
        })
      } catch {
        // The caller still receives a fail-closed unknown-broadcast result.
      }
      throw new Error('Attestation broadcast outcome is unknown')
    }
  }

  #validateRequest(value: unknown) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'operationKey',
        'fingerprint',
        'chainId',
        'to',
        'data',
        'value',
      ]) ||
      typeof value.operationKey !== 'string' ||
      value.operationKey.length < 1 ||
      value.operationKey.length > 1_024 ||
      !isHex32(value.fingerprint) ||
      value.chainId !== GIWA_SEPOLIA_CHAIN_ID ||
      typeof value.to !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.to) ||
      typeof value.data !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data) ||
      value.value !== 0n
    ) {
      throw new Error(
        'Contracts runtime produced an invalid send request',
      )
    }
    if (value.to.toLowerCase() !== this.expectedEasAddress) {
      throw new Error(
        'Contracts runtime send target does not match configured EAS',
      )
    }
    return {
      operationKey: value.operationKey,
      fingerprint: value.fingerprint.toLowerCase() as Hex32,
      chainId: GIWA_SEPOLIA_CHAIN_ID,
      to: value.to,
      data: value.data,
      value: 0n,
    }
  }
}

const createRuntimeAdapter = async (
  options: LoadGiwaSepoliaReportRuntimeOptions,
  contractsModule: unknown,
): Promise<ProductionGiwaSepoliaReportRuntime> => {
  if (
    !isRecord(contractsModule) ||
    typeof contractsModule[CONTRACTS_FACTORY_EXPORT] !==
      'function'
  ) {
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }
  const configuredDerivationRuleDigest =
    options.derivationRuleDigest === undefined
      ? undefined
      : normalizeHex32(
          options.derivationRuleDigest,
          'Derivation rule digest',
        )
  const minimumConfirmations =
    options.minimumConfirmations ?? 1
  if (
    !Number.isSafeInteger(minimumConfirmations) ||
    minimumConfirmations < 1 ||
    minimumConfirmations > 1_000
  ) {
    throw new Error(
      'Minimum confirmations must be an integer between 1 and 1000',
    )
  }
  const confirmationClient =
    isRecord(options.publicClient) &&
    typeof options.publicClient.waitForTransactionReceipt ===
      'function'
      ? (options.publicClient
          .waitForTransactionReceipt as UnknownFunction)
      : undefined
  if (
    minimumConfirmations > 1 &&
    confirmationClient === undefined
  ) {
    throw new Error(
      'Public client cannot enforce minimum confirmations',
    )
  }
  const operationContext =
    new AsyncLocalStorage<OperationContext>()
  const expectedEasAddress = configuredEasAddress(
    options.deployment,
  )
  const issuerSigner = new OnceOnlyAttestationSigner(
    options.issuerSigner,
    options.operationStore,
    operationContext,
    'SUBMIT',
    expectedEasAddress,
  )
  const reviewerSigner = new OnceOnlyAttestationSigner(
    options.reviewerSigner,
    options.operationStore,
    operationContext,
    null,
    expectedEasAddress,
  )

  let rawRuntime: RawRuntime
  try {
    rawRuntime = validateRuntime(
      await (
        contractsModule[
          CONTRACTS_FACTORY_EXPORT
        ] as UnknownFunction
      )({
        deployment: options.deployment,
        publicClient: options.publicClient,
        issuerSigner,
        reviewerSigner,
        reviewDecisionSource: {
          readAuthenticatedDecision: async (
            requestValue: unknown,
          ) => {
            if (
              !isRecord(requestValue) ||
              !hasExactKeys(requestValue, [
                'preparedRecordId',
                'submissionUID',
                'reportId',
                'revision',
                'commitment',
                'evidenceSchemaDigest',
                'derivationRuleDigest',
              ])
            ) {
              throw new Error(
                'Contracts runtime review request is invalid',
              )
            }
            const request = {
              preparedRecordId: normalizePreparedRecordId(
                requestValue.preparedRecordId,
              ),
              submissionUID: normalizeHex32(
                requestValue.submissionUID,
                'Submission UID',
              ),
              reportId: normalizeHex32(
                requestValue.reportId,
                'Report ID',
              ),
              revision: requestValue.revision as number,
              commitment: normalizeHex32(
                requestValue.commitment,
                'Commitment',
              ),
              evidenceSchemaDigest: normalizeHex32(
                requestValue.evidenceSchemaDigest,
                'Evidence schema digest',
              ),
              derivationRuleDigest: normalizeHex32(
                requestValue.derivationRuleDigest,
                'Derivation rule digest',
              ),
            }
            if (
              !Number.isSafeInteger(request.revision) ||
              request.revision < 1
            ) {
              throw new Error(
                'Contracts runtime review revision is invalid',
              )
            }
            const decision = validateReviewDecision(
              await options.reviewDecisionSource
                .readAuthenticatedDecision(request),
            )
            const context = operationContext.getStore()
            if (
              !context ||
              context.preparedRecordId !==
                request.preparedRecordId
            ) {
              throw new Error(
                'Review decision escaped its operation context',
              )
            }
            context.action = decision.outcome
            return decision
          },
        },
        ...(options.verificationFinality === undefined
          ? {}
          : {
              verificationFinality:
                options.verificationFinality,
            }),
      }),
    )
  } catch (error) {
    if (error instanceof GiwaSepoliaContractsRuntimeError) {
      throw error
    }
    throw new GiwaSepoliaContractsRuntimeError(
      'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
    )
  }

  const nonceSource =
    options.nonceSource ??
    (() => `0x${randomBytes(32).toString('hex')}` as Hex32)
  const now = options.now ?? (() => new Date())
  let closePromise: Promise<void> | undefined

  const prepareRaw = (
    input: {
      preparedRecordId: string
      reportId: Hex32
      revision: number
      previousSubmissionUID: Hex32
      safeArtifactBytes: Uint8Array
      derivationRuleDigest: Hex32
      nonce: Hex32
    },
  ) =>
    validateRawPrepared(
      rawRuntime.prepare({
        preparedRecordId: input.preparedRecordId,
        reportId: input.reportId,
        revision: input.revision,
        previousSubmissionUID:
          input.previousSubmissionUID,
        safeArtifactBytes: input.safeArtifactBytes.slice(),
        derivationRuleDigest: input.derivationRuleDigest,
        nonce: input.nonce,
      }),
    )

  const readAndRebuild = async (
    preparedRecordIdValue: string,
  ) => {
    const preparedRecordId = normalizePreparedRecordId(
      preparedRecordIdValue,
    )
    const projectionValue =
      await options.preparedRecordSource.readPreparedRecord(
        preparedRecordId,
      )
    if (!projectionValue) {
      throw new GiwaSepoliaContractsRuntimeError(
        'GIWA_PREPARED_RECORD_UNAVAILABLE',
      )
    }
    const projection = validatePreparedProjection(
      projectionValue,
    )
    if (
      projection.preparedRecordId !== preparedRecordId ||
      (configuredDerivationRuleDigest !== undefined &&
        projection.derivationRuleDigest !==
          configuredDerivationRuleDigest) ||
      projection.safeArtifactDigest !==
        digest(projection.safeArtifactBytes)
    ) {
      throw new GiwaSepoliaContractsRuntimeError(
        'GIWA_PREPARED_RECORD_MISMATCH',
      )
    }
    const prepared = prepareRaw({
      preparedRecordId,
      reportId: projection.reportId,
      revision: projection.revision,
      previousSubmissionUID:
        projection.previousSubmissionUID,
      safeArtifactBytes: projection.safeArtifactBytes,
      derivationRuleDigest:
        projection.derivationRuleDigest,
      nonce: projection.commitmentNonce,
    })
    if (
      prepared.commitment !== projection.commitment ||
      digest(bytesFromHex(prepared.safeManifestBytes)) !==
        projection.safeManifestDigest
    ) {
      throw new GiwaSepoliaContractsRuntimeError(
        'GIWA_PREPARED_RECORD_MISMATCH',
      )
    }
    return { projection, prepared }
  }

  const settleClaimedOperation = async (
    context: OperationContext,
    result: RawWriteResult,
  ): Promise<RawWriteResult> => {
    if (
      context.claim?.disposition !== 'CLAIMED' ||
      context.action === null ||
      context.requestOperationKey === null ||
      context.requestFingerprint === null
    ) {
      return result
    }
    if (
      result.operationKey !==
        context.requestOperationKey ||
      result.fingerprint !==
        context.requestFingerprint
    ) {
      const transactionHash =
        result.transactionHash ??
        context.observedTransactionHash
      try {
        await options.operationStore.requireReconciliation({
          canonicalOperationKey:
            context.requestOperationKey,
          planFingerprint:
            context.requestFingerprint,
          transactionHash,
          reasonCode: 'RUNTIME_RESULT_BINDING_MISMATCH',
        })
      } catch {
        // Fail-closed response below remains authoritative.
      }
      return {
        ...result,
        status: 'RECONCILIATION_REQUIRED',
        transactionHash,
        attestationUID: null,
        reasonCode: 'RUNTIME_RESULT_BINDING_MISMATCH',
      }
    }
    if (
      result.status === 'CONFIRMED' &&
      result.transactionHash !== null &&
      result.attestationUID !== null
    ) {
      if (minimumConfirmations > 1) {
        try {
          await confirmationClient?.call(
            options.publicClient,
            {
              hash: result.transactionHash,
              confirmations: minimumConfirmations,
            },
          )
        } catch {
          try {
            await options.operationStore.requireReconciliation({
              canonicalOperationKey: result.operationKey,
              planFingerprint: result.fingerprint,
              transactionHash: result.transactionHash,
              reasonCode:
                'MINIMUM_CONFIRMATIONS_NOT_REACHED',
            })
          } catch {
            // The response still fails closed below.
          }
          return {
            ...result,
            status: 'RECONCILIATION_REQUIRED',
            attestationUID: null,
            reasonCode:
              'MINIMUM_CONFIRMATIONS_NOT_REACHED',
          }
        }
      }
      try {
        await options.operationStore.confirm({
          canonicalOperationKey: result.operationKey,
          preparedRecordId: context.preparedRecordId,
          action: context.action,
          planFingerprint: result.fingerprint,
          transactionHash: result.transactionHash,
          attestationUID: result.attestationUID,
          resultStatus: resultStatusForAction(
            context.action,
          ),
        })
        return result
      } catch {
        try {
          await options.operationStore.requireReconciliation({
            canonicalOperationKey: result.operationKey,
            planFingerprint: result.fingerprint,
            transactionHash: result.transactionHash,
            reasonCode:
              'OPERATION_CONFIRMATION_NOT_PERSISTED',
          })
        } catch {
          // The redacted reconciliation result is still returned.
        }
        return {
          ...result,
          status: 'RECONCILIATION_REQUIRED',
          attestationUID: null,
          reasonCode:
            'OPERATION_CONFIRMATION_NOT_PERSISTED',
        }
      }
    }
    const effectiveTransactionHash =
      result.transactionHash ??
      context.observedTransactionHash
    const reasonCode =
      result.status === 'RECONCILIATION_REQUIRED' &&
      result.reasonCode !== null
        ? result.reasonCode
        : 'POST_BROADCAST_RESULT_NOT_CONFIRMED'
    try {
      await options.operationStore.requireReconciliation({
        canonicalOperationKey: result.operationKey,
        planFingerprint: result.fingerprint,
        transactionHash: effectiveTransactionHash,
        reasonCode,
      })
    } catch {
      // Do not turn a reconciliation state into a retry.
    }
    return {
      ...result,
      status: 'RECONCILIATION_REQUIRED',
      transactionHash: effectiveTransactionHash,
      attestationUID: null,
      reasonCode,
    }
  }

  const runWrite = async (
    preparedRecordId: string,
    initialAction: ReportAttestationOperationAction | null,
    operation: (
      rebuilt: Awaited<ReturnType<typeof readAndRebuild>>,
    ) => Promise<unknown>,
  ): Promise<RedactedExecutionResult> => {
    const rebuilt = await readAndRebuild(preparedRecordId)
    const context: OperationContext = {
      preparedRecordId,
      broadcastAllowed: true,
      action: initialAction,
      claim: null,
      requestOperationKey: null,
      requestFingerprint: null,
      observedTransactionHash: null,
    }
    const raw = await operationContext.run(
      context,
      async () =>
        validateRawWriteResult(
          await operation(rebuilt),
        ),
    )
    const settled = await settleClaimedOperation(
      context,
      raw,
    )
    return {
      status: settled.status,
      transactionHash: settled.transactionHash,
      attestationUID: settled.attestationUID,
      reasonCode: settled.reasonCode,
    }
  }

  const reconcileReview = async (input: {
    preparedRecordId: string
    submissionUID: Hex32
    transactionHash: Hex32
  }): Promise<RedactedExecutionResult> => {
    const { prepared, projection } = await readAndRebuild(
      input.preparedRecordId,
    )
    const submissionUID = normalizeHex32(
      input.submissionUID,
      'Submission UID',
    )
    const transactionHash = normalizeHex32(
      input.transactionHash,
      'Transaction hash',
    )
    if (
      projection.submissionAttestationUID !== null &&
      projection.submissionAttestationUID !== submissionUID
    ) {
      throw new GiwaSepoliaContractsRuntimeError(
        'GIWA_PREPARED_RECORD_MISMATCH',
      )
    }

    const context: OperationContext = {
      preparedRecordId: input.preparedRecordId,
      broadcastAllowed: false,
      action: null,
      claim: null,
      requestOperationKey: null,
      requestFingerprint: null,
      observedTransactionHash: transactionHash,
    }
    const result = await operationContext.run(
      context,
      async () =>
        validateRawWriteResult(
          await rawRuntime.reconcileDecision(
            prepared,
            submissionUID,
            transactionHash,
          ),
        ),
    )
    if (
      context.action === null ||
      result.transactionHash !== transactionHash
    ) {
      return {
        status: 'RECONCILIATION_REQUIRED',
        transactionHash,
        attestationUID: null,
        reasonCode: 'RUNTIME_RESULT_BINDING_MISMATCH',
      }
    }

    try {
      await options.operationStore.verifyReconciliationBinding({
        canonicalOperationKey: result.operationKey,
        preparedRecordId: context.preparedRecordId,
        action: context.action,
        planFingerprint: result.fingerprint,
        transactionHash,
      })
    } catch {
      return {
        status: 'RECONCILIATION_REQUIRED',
        transactionHash,
        attestationUID: null,
        reasonCode: 'RUNTIME_RESULT_BINDING_MISMATCH',
      }
    }

    if (
      result.status !== 'CONFIRMED' ||
      result.attestationUID === null
    ) {
      return {
        status: result.status,
        transactionHash,
        attestationUID: null,
        reasonCode: result.reasonCode,
      }
    }

    if (minimumConfirmations > 1) {
      try {
        await confirmationClient?.call(
          options.publicClient,
          {
            hash: transactionHash,
            confirmations: minimumConfirmations,
          },
        )
      } catch {
        return {
          status: 'RECONCILIATION_REQUIRED',
          transactionHash,
          attestationUID: null,
          reasonCode: 'MINIMUM_CONFIRMATIONS_NOT_REACHED',
        }
      }
    }

    try {
      await options.operationStore.confirm({
        canonicalOperationKey: result.operationKey,
        preparedRecordId: context.preparedRecordId,
        action: context.action,
        planFingerprint: result.fingerprint,
        transactionHash,
        attestationUID: result.attestationUID,
        resultStatus: resultStatusForAction(context.action),
      })
    } catch {
      return {
        status: 'RECONCILIATION_REQUIRED',
        transactionHash,
        attestationUID: null,
        reasonCode: 'OPERATION_CONFIRMATION_NOT_PERSISTED',
      }
    }

    return {
      status: 'CONFIRMED',
      transactionHash,
      attestationUID: result.attestationUID,
      reasonCode: null,
    }
  }

  return {
    kind: GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND,
    issuerExecutor: {
      executeIssuer: ({ preparedRecordId }) =>
        runWrite(
          preparedRecordId,
          'SUBMIT',
          ({ prepared }) => rawRuntime.submit(prepared),
        ),
    },
    reviewerExecutor: {
      executeReviewer: ({
        preparedRecordId,
        submissionUID,
      }) =>
        runWrite(
          preparedRecordId,
          null,
          ({ prepared, projection }) => {
            if (
              projection.submissionAttestationUID !== null &&
              projection.submissionAttestationUID !==
                submissionUID.toLowerCase()
            ) {
              throw new GiwaSepoliaContractsRuntimeError(
                'GIWA_PREPARED_RECORD_MISMATCH',
              )
            }
            return rawRuntime.decide(
              prepared,
              normalizeHex32(
                submissionUID,
                'Submission UID',
              ),
            )
          },
        ),
    },
    reviewerReconciler: {
      reconcileReviewer: reconcileReview,
    },
    prepareSyntheticEvidence: async (
      input: PreparedReportInput,
    ): Promise<PreparedSyntheticEvidence> => {
      const derivationRuleDigest =
        input.derivationRuleDigest === undefined
          ? configuredDerivationRuleDigest
          : normalizeHex32(
              input.derivationRuleDigest,
              'Derivation rule digest',
            )
      if (
        derivationRuleDigest === undefined ||
        (configuredDerivationRuleDigest !== undefined &&
          derivationRuleDigest !==
            configuredDerivationRuleDigest)
      ) {
        throw new Error(
          'Derivation rule digest is unavailable or not allowlisted',
        )
      }
      const nonce = normalizeHex32(
        nonceSource(),
        'Commitment nonce',
      )
      const prepared = prepareRaw({
        preparedRecordId: normalizePreparedRecordId(
          input.preparedRecordId,
        ),
        reportId: normalizeHex32(
          input.reportId,
          'Report ID',
        ),
        revision: input.revision,
        previousSubmissionUID:
          input.previousSubmissionUID === undefined
            ? ZERO_BYTES32
            : normalizeHex32(
                input.previousSubmissionUID,
                'Previous submission UID',
              ),
        safeArtifactBytes: input.safeArtifactBytes,
        derivationRuleDigest,
        nonce,
      })
      return {
        preparedRecordId: prepared.preparedRecordId,
        reportId: prepared.reportId,
        revision: prepared.revision,
        commitment: prepared.commitment,
        safeArtifactDigest: digest(
          input.safeArtifactBytes,
        ),
        safeManifestDigest: digest(
          bytesFromHex(prepared.safeManifestBytes),
        ),
        derivationRuleDigest:
          prepared.derivationRuleDigest,
        commitmentNonce: prepared.nonce,
      }
    },
    isUsable: async (reportId, approvalUID) => {
      const result = await rawRuntime.readReport(
        normalizeHex32(reportId, 'Report ID'),
        normalizeHex32(approvalUID, 'Approval UID'),
      )
      if (
        !isRecord(result) ||
        typeof result.usable !== 'boolean'
      ) {
        throw new GiwaSepoliaContractsRuntimeError(
          'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
        )
      }
      return result.usable
    },
    verifyPreparedReport: async ({
      preparedRecordId,
      approvalUID,
      safeArtifactBytes,
    }) => {
      const { prepared, projection } =
        await readAndRebuild(preparedRecordId)
      if (
        digest(safeArtifactBytes) !==
          projection.safeArtifactDigest ||
        projection.submissionAttestationUID === null
      ) {
        return {
          result: 'UNUSABLE',
          reason: 'PREPARED_REPORT_MISMATCH',
        }
      }
      const verificationTime = BigInt(
        Math.floor(now().getTime() / 1_000),
      )
      if (verificationTime <= 0n) {
        throw new Error(
          'Verification time must be positive',
        )
      }
      const result = await rawRuntime.verify({
        prepared,
        submissionUID:
          projection.submissionAttestationUID,
        approvalUID: normalizeHex32(
          approvalUID,
          'Approval UID',
        ),
        safeArtifactBytes: safeArtifactBytes.slice(),
        verificationTime,
      })
      if (
        !isRecord(result) ||
        !hasExactKeys(result, ['result', 'reason']) ||
        (result.result !== 'USABLE' &&
          result.result !== 'UNUSABLE') ||
        typeof result.reason !== 'string'
      ) {
        throw new GiwaSepoliaContractsRuntimeError(
          'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
        )
      }
      return {
        result: result.result,
        reason: result.reason,
      }
    },
    preflight: async () => {
      const result = await rawRuntime.preflight()
      if (
        !isRecord(result) ||
        result.status !== 'PASS' ||
        result.chainId !== GIWA_SEPOLIA_CHAIN_ID ||
        typeof result.issuer !== 'string' ||
        typeof result.reviewer !== 'string'
      ) {
        throw new GiwaSepoliaContractsRuntimeError(
          'GIWA_CONTRACTS_RUNTIME_INCOMPATIBLE',
        )
      }
    },
    close: () => {
      if (!closePromise) {
        closePromise = options.close
          ? options.close()
          : Promise.resolve()
      }
      return closePromise
    },
  }
}

export const loadGiwaSepoliaReportAttestationRuntime =
  async (
    options: LoadGiwaSepoliaReportRuntimeOptions,
  ): Promise<ProductionGiwaSepoliaReportRuntime> => {
    let contractsModule = options.contractsModule
    if (contractsModule === undefined) {
      try {
        contractsModule = await import(
          CONTRACTS_MODULE_SPECIFIER
        )
      } catch {
        throw new GiwaSepoliaContractsRuntimeError(
          'GIWA_CONTRACTS_MODULE_UNAVAILABLE',
        )
      }
    }
    return createRuntimeAdapter(options, contractsModule)
  }
