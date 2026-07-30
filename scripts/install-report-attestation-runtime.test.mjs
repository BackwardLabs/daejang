import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  reportAttestationRuntimeInstallDirectory,
  validateReportAttestationRuntimeArchiveEntries,
  verifyReportAttestationRuntimeTarball,
} from './install-report-attestation-runtime.mjs'

test('installs into the root node_modules used by the host runtime', () => {
  assert.equal(
    reportAttestationRuntimeInstallDirectory,
    fileURLToPath(
      new URL(
        '../node_modules/@backward-labs/daejang-contracts',
        import.meta.url,
      ),
    ),
  )
})

test('accepts only an absolute regular tarball with the pinned SHA-256', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'giwa-contracts-runtime-'),
  )
  const tarball = join(directory, 'runtime.tgz')
  const bytes = Buffer.from('test runtime package')
  await writeFile(tarball, bytes, { mode: 0o600 })
  const sha256 = createHash('sha256')
    .update(bytes)
    .digest('hex')

  assert.equal(
    await verifyReportAttestationRuntimeTarball({
      tarball,
      sha256,
    }),
    sha256,
  )
  await assert.rejects(
    verifyReportAttestationRuntimeTarball({
      tarball,
      sha256: '0'.repeat(64),
    }),
    /does not match/u,
  )
  await assert.rejects(
    verifyReportAttestationRuntimeTarball({
      tarball: 'runtime.tgz',
      sha256,
    }),
    /invalid/u,
  )
})

test('allows only regular package-scoped archive entries', () => {
  assert.doesNotThrow(() =>
    validateReportAttestationRuntimeArchiveEntries(
      'package/package.json\npackage/dist/runtime.js\n',
      '-rw-r--r-- user group 1 Jan 1 00:00 package/package.json\n-rw-r--r-- user group 1 Jan 1 00:00 package/dist/runtime.js\n',
    ),
  )
  assert.throws(
    () =>
      validateReportAttestationRuntimeArchiveEntries(
        'package/../outside\n',
        '-rw-r--r-- user group 1 Jan 1 00:00 package/../outside\n',
      ),
    /unsafe path/u,
  )
  assert.throws(
    () =>
      validateReportAttestationRuntimeArchiveEntries(
        'package/runtime-link\n',
        'lrwxr-xr-x user group 0 Jan 1 00:00 package/runtime-link -> /tmp/runtime\n',
      ),
    /unsupported archive entries/u,
  )
})
