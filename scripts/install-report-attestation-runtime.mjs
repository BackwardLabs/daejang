import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import {
  isAbsolute,
  join,
  posix,
} from 'node:path'
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url'
import { spawn } from 'node:child_process'

const MAX_TARBALL_BYTES = 20 * 1024 * 1024
const MAX_ARCHIVE_LIST_BYTES = 1024 * 1024
const EXPECTED_PACKAGE_NAME =
  '@backward-labs/daejang-contracts'
const EXPECTED_RUNTIME_EXPORT =
  './dist/public/giwaSepoliaV1.js'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REPOSITORY_DIRECTORY = fileURLToPath(
  new URL('../', import.meta.url),
)
const PACKAGE_PARENT_DIRECTORY = join(
  REPOSITORY_DIRECTORY,
  'node_modules',
  '@backward-labs',
)
const INSTALLED_PACKAGE_DIRECTORY = join(
  PACKAGE_PARENT_DIRECTORY,
  'daejang-contracts',
)
const installedRuntimeEntry = (packageDirectory) =>
  join(
    packageDirectory,
    'dist',
    'public',
    'giwaSepoliaV1.js',
  )
const INSTALLED_RUNTIME_ENTRY = installedRuntimeEntry(
  INSTALLED_PACKAGE_DIRECTORY,
)
export const reportAttestationRuntimeInstallDirectory =
  INSTALLED_PACKAGE_DIRECTORY

const archiveCommand = (
  arguments_,
  captureOutput = false,
) =>
  new Promise((resolve, reject) => {
    const child = spawn('tar', arguments_, {
      stdio: captureOutput
        ? ['ignore', 'pipe', 'pipe']
        : 'inherit',
    })
    let output = ''
    let errorOutput = ''
    if (captureOutput) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        output += chunk
        if (Buffer.byteLength(output) > MAX_ARCHIVE_LIST_BYTES) {
          child.kill()
        }
      })
      child.stderr?.on('data', (chunk) => {
        errorOutput += chunk
      })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (
        code === 0 &&
        Buffer.byteLength(output) <= MAX_ARCHIVE_LIST_BYTES
      ) {
        resolve(output)
        return
      }
      reject(
        new Error(
          `Runtime package archive command failed (${signal ?? code}): ${
            errorOutput.trim() || 'invalid archive'
          }`,
        ),
      )
    })
  })

export const validateReportAttestationRuntimeArchiveEntries = (
  namesOutput,
  verboseOutput,
) => {
  const names = namesOutput
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
  const verbose = verboseOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    names.length === 0 ||
    verbose.length !== names.length ||
    verbose.some(
      (line) => line[0] !== '-' && line[0] !== 'd',
    )
  ) {
    throw new Error(
      'The contracts tarball contains unsupported archive entries',
    )
  }
  for (const name of names) {
    const withoutTrailingSlash = name.endsWith('/')
      ? name.slice(0, -1)
      : name
    const normalized = posix.normalize(withoutTrailingSlash)
    if (
      name.includes('\\') ||
      name.includes('\u0000') ||
      (name !== 'package' && !name.startsWith('package/')) ||
      normalized !== withoutTrailingSlash ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('/../')
    ) {
      throw new Error(
        'The contracts tarball contains an unsafe path',
      )
    }
  }
}

const inspectExtractedPackage = async (
  packageDirectory,
) => {
  let totalBytes = 0
  const visit = async (directory) => {
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(
          'The contracts tarball extracted a symbolic link',
        )
      }
      if (metadata.isDirectory()) {
        await visit(path)
      } else if (metadata.isFile()) {
        totalBytes += metadata.size
        if (totalBytes > MAX_TARBALL_BYTES) {
          throw new Error(
            'The extracted contracts package is too large',
          )
        }
      } else {
        throw new Error(
          'The contracts tarball extracted an unsupported file',
        )
      }
    }
  }
  await visit(packageDirectory)

  const manifest = JSON.parse(
    await readFile(
      join(packageDirectory, 'package.json'),
      'utf8',
    ),
  )
  if (
    manifest?.name !== EXPECTED_PACKAGE_NAME ||
    manifest?.exports?.['./giwa-sepolia-v1']?.import !==
      EXPECTED_RUNTIME_EXPORT
  ) {
    throw new Error(
      'The contracts tarball package manifest is incompatible',
    )
  }
  const runtimeModule = await import(
    `${pathToFileURL(
      installedRuntimeEntry(packageDirectory),
    ).href}?installation=${Date.now()}`
  )
  if (
    typeof runtimeModule.createGiwaSepoliaReportRuntimeV1 !==
    'function'
  ) {
    throw new Error(
      'Installed contracts package does not expose the GIWA Sepolia runtime',
    )
  }
}

const install = async (tarball) => {
  const [namesOutput, verboseOutput] = await Promise.all([
    archiveCommand(['-tzf', tarball], true),
    archiveCommand(['-tvzf', tarball], true),
  ])
  validateReportAttestationRuntimeArchiveEntries(
    namesOutput,
    verboseOutput,
  )

  await mkdir(PACKAGE_PARENT_DIRECTORY, {
    recursive: true,
    mode: 0o755,
  })
  const temporaryDirectory = await mkdtemp(
    join(PACKAGE_PARENT_DIRECTORY, '.runtime-install-'),
  )
  const backupContainer = await mkdtemp(
    join(PACKAGE_PARENT_DIRECTORY, '.runtime-backup-'),
  )
  const backupDirectory = join(backupContainer, 'package')
  let movedExistingPackage = false
  let installed = false
  let restoredExistingPackage = false
  try {
    await archiveCommand([
      '-xzf',
      tarball,
      '-C',
      temporaryDirectory,
      '--strip-components=1',
    ])
    await inspectExtractedPackage(temporaryDirectory)

    try {
      const existing = await lstat(INSTALLED_PACKAGE_DIRECTORY)
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(
          'The existing contracts runtime package is unsafe to replace',
        )
      }
      await rename(
        INSTALLED_PACKAGE_DIRECTORY,
        backupDirectory,
      )
      movedExistingPackage = true
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw error
      }
    }

    await rename(
      temporaryDirectory,
      INSTALLED_PACKAGE_DIRECTORY,
    )
    installed = true
    await inspectExtractedPackage(
      INSTALLED_PACKAGE_DIRECTORY,
    )
  } catch (error) {
    if (installed) {
      await rm(INSTALLED_PACKAGE_DIRECTORY, {
        recursive: true,
        force: true,
      })
      installed = false
    }
    if (movedExistingPackage) {
      await rename(
        backupDirectory,
        INSTALLED_PACKAGE_DIRECTORY,
      )
      restoredExistingPackage = true
    }
    throw error
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    })
    if (
      installed ||
      !movedExistingPackage ||
      restoredExistingPackage
    ) {
      await rm(backupContainer, {
        recursive: true,
        force: true,
      })
    }
  }
}

const verifyInstalledRuntime = async () => {
  const runtimeModule = await import(
    `${pathToFileURL(INSTALLED_RUNTIME_ENTRY).href}?verification=${
      Date.now()
    }`
  )
  if (
    typeof runtimeModule.createGiwaSepoliaReportRuntimeV1 !==
    'function'
  ) {
    throw new Error(
      'Installed contracts package does not expose the GIWA Sepolia runtime',
    )
  }
}

const parseArguments = (arguments_) => {
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      (name !== '--tarball' && name !== '--sha256') ||
      !value
    ) {
      throw new Error(
        'Usage: --tarball <absolute-path> --sha256 <hex>',
      )
    }
    values.set(name, value)
  }
  if (values.size !== 2) {
    throw new Error(
      'Usage: --tarball <absolute-path> --sha256 <hex>',
    )
  }
  return {
    tarball: values.get('--tarball'),
    sha256: values.get('--sha256')?.toLowerCase(),
  }
}

export const verifyReportAttestationRuntimeTarball =
  async ({ tarball, sha256 }) => {
    if (
      typeof tarball !== 'string' ||
      !isAbsolute(tarball) ||
      typeof sha256 !== 'string' ||
      !SHA256_PATTERN.test(sha256)
    ) {
      throw new Error(
        'The contracts tarball path or SHA-256 is invalid',
      )
    }
    const metadata = await lstat(tarball)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_TARBALL_BYTES
    ) {
      throw new Error('The contracts tarball is invalid')
    }
    const actual = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex')
    if (actual !== sha256) {
      throw new Error(
        'The contracts tarball SHA-256 does not match',
      )
    }
    return actual
  }

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const sha256 =
    await verifyReportAttestationRuntimeTarball(options)
  await install(options.tarball)
  await verifyInstalledRuntime()
  process.stdout.write(
    `${JSON.stringify({
      status: 'INSTALLED',
      package: '@backward-labs/daejang-contracts',
      sha256,
    })}\n`,
  )
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main()
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Runtime package installation failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
