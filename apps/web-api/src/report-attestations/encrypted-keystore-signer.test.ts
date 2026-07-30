import {
  chmod,
  mkdtemp,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import {
  GiwaReportSignerConfigurationError,
  loadEncryptedKeystoreSigner,
} from './encrypted-keystore-signer.js'

const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

describe('encrypted GIWA report signer loader', () => {
  it('loads an encrypted Web3 keystore without exposing its password', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'giwa-report-signer-'),
    )
    const keystorePath = join(directory, 'issuer.json')
    const passwordFile = join(directory, 'issuer.password')
    const password = 'test-only-password'
    const encrypted = await new Wallet(
      TEST_PRIVATE_KEY,
    ).encrypt(password)
    await writeFile(keystorePath, encrypted, { mode: 0o600 })
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 })

    const loaded = await loadEncryptedKeystoreSigner({
      rpcUrl: 'https://sepolia-rpc.giwa.io',
      keystorePath,
      passwordFile,
    })
    expect(loaded.address).toBe(
      new Wallet(TEST_PRIVATE_KEY).address,
    )
  })

  it('rejects group-readable secret files with a stable redacted error', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'giwa-report-signer-mode-'),
    )
    const keystorePath = join(directory, 'issuer.json')
    const passwordFile = join(directory, 'issuer.password')
    await writeFile(keystorePath, '{}', { mode: 0o600 })
    await writeFile(passwordFile, 'secret', { mode: 0o600 })
    await chmod(passwordFile, 0o640)

    let failure: unknown
    try {
      await loadEncryptedKeystoreSigner({
        rpcUrl: 'https://sepolia-rpc.giwa.io',
        keystorePath,
        passwordFile,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(
      GiwaReportSignerConfigurationError,
    )
    expect(
      (failure as GiwaReportSignerConfigurationError).code,
    ).toBe('SIGNER_FILE_PERMISSIONS')
    expect(String(failure)).not.toContain('secret')
    expect(String(failure)).not.toContain(passwordFile)
  })

  it('rejects a symlinked secret file without following it', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'giwa-report-signer-symlink-'),
    )
    const keystorePath = join(directory, 'issuer.json')
    const passwordTarget = join(
      directory,
      'issuer.password.target',
    )
    const passwordFile = join(directory, 'issuer.password')
    await writeFile(keystorePath, '{}', { mode: 0o600 })
    await writeFile(passwordTarget, 'secret', { mode: 0o600 })
    await symlink(passwordTarget, passwordFile)

    let failure: unknown
    try {
      await loadEncryptedKeystoreSigner({
        rpcUrl: 'https://sepolia-rpc.giwa.io',
        keystorePath,
        passwordFile,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(
      GiwaReportSignerConfigurationError,
    )
    expect(
      (failure as GiwaReportSignerConfigurationError).code,
    ).toBe('SIGNER_FILE_INVALID')
    expect(String(failure)).not.toContain('secret')
    expect(String(failure)).not.toContain(passwordFile)
  })
})
