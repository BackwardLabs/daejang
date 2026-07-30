import { constants } from 'node:fs'
import {
  open,
} from 'node:fs/promises'

import {
  JsonRpcProvider,
  NonceManager,
  Wallet,
} from 'ethers'

const MAX_KEYSTORE_BYTES = 1024 * 1024
const MAX_PASSWORD_BYTES = 4 * 1024

export class GiwaReportSignerConfigurationError extends Error {
  constructor(
    readonly code:
      | 'SIGNER_FILE_UNAVAILABLE'
      | 'SIGNER_FILE_PERMISSIONS'
      | 'SIGNER_FILE_INVALID'
      | 'SIGNER_KEYSTORE_DECRYPTION_FAILED',
  ) {
    super(code)
    this.name = 'GiwaReportSignerConfigurationError'
  }
}

const readProtectedFile = async (
  path: string,
  maximumBytes: number,
) => {
  let handle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ELOOP'
    ) {
      throw new GiwaReportSignerConfigurationError(
        'SIGNER_FILE_INVALID',
      )
    }
    throw new GiwaReportSignerConfigurationError(
      'SIGNER_FILE_UNAVAILABLE',
    )
  }
  try {
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new GiwaReportSignerConfigurationError(
        'SIGNER_FILE_INVALID',
      )
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new GiwaReportSignerConfigurationError(
        'SIGNER_FILE_PERMISSIONS',
      )
    }
    const bytes = await handle.readFile()
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > maximumBytes
    ) {
      throw new GiwaReportSignerConfigurationError(
        'SIGNER_FILE_INVALID',
      )
    }
    return bytes
  } catch (error) {
    if (error instanceof GiwaReportSignerConfigurationError) {
      throw error
    }
    throw new GiwaReportSignerConfigurationError(
      'SIGNER_FILE_UNAVAILABLE',
    )
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const removeOneLineEnding = (value: string) =>
  value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value

export const loadEncryptedKeystoreSigner = async (input: {
  rpcUrl: string
  keystorePath: string
  passwordFile: string
}) => {
  const [keystoreBytes, passwordBytes] = await Promise.all([
    readProtectedFile(input.keystorePath, MAX_KEYSTORE_BYTES),
    readProtectedFile(input.passwordFile, MAX_PASSWORD_BYTES),
  ])
  const password = removeOneLineEnding(
    passwordBytes.toString('utf8'),
  )
  if (password.length === 0 || password.includes('\u0000')) {
    throw new GiwaReportSignerConfigurationError(
      'SIGNER_FILE_INVALID',
    )
  }

  let wallet: Awaited<ReturnType<typeof Wallet.fromEncryptedJson>>
  try {
    wallet = await Wallet.fromEncryptedJson(
      keystoreBytes.toString('utf8'),
      password,
    )
  } catch {
    throw new GiwaReportSignerConfigurationError(
      'SIGNER_KEYSTORE_DECRYPTION_FAILED',
    )
  }
  const provider = new JsonRpcProvider(
    input.rpcUrl,
    91_342,
    { staticNetwork: true },
  )
  const signer = new NonceManager(wallet.connect(provider))
  return Object.freeze({
    address: await signer.getAddress(),
    signer,
    provider,
  })
}
