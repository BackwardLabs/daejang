#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

const projectRoot = process.env.GIWA_DAEJANG_ROOT ?? '/Users/Shared/Projects/01_Daejang'
const releaseRoot = process.env.GIWA_RELEASE_ROOT ?? join(projectRoot, 'releases')
const publisherStateFile =
  process.env.DAEJANG_PUBLISHER_STATE_FILE ??
  '/Users/Shared/DaejangRegistry/publisher/state.json'

const repositories = [
  ['evm-indexer', 'evm-indexer'],
  ['DeFi-Label', 'DeFi-Label'],
  ['daejang', 'daejang'],
  ['daejang-db', 'daejang-db'],
  ['daejang-jit-engine', 'daejang-jit-engine'],
  ['daejang-posting-service', 'daejang-posting-service'],
  ['daejang-reviewroom', 'daejang-reviewroom'],
  ['daejang-tax-engine', 'daejang-tax-engine'],
  ['pdf-parser', 'pdf-parser'],
  ['schema', 'schema'],
]

const imageRepositories = new Set([
  'daejang',
  'daejang-jit-engine',
  'daejang-posting-service',
  'daejang-tax-engine',
])
const requiredImages = new Set([
  'web-api',
  'engine',
  'pdf-parser',
  'jit-engine',
  'posting-service',
  'tax-engine',
  'tax-engine-dev-e2e',
])

const repositoryDirectory = (name) => {
  const entry = repositories.find(([candidate]) => candidate === name)
  if (!entry) throw new Error(`알 수 없는 저장소입니다: ${name}`)
  return join(projectRoot, entry[1])
}

const git = (name, args) =>
  execFileSync('git', ['-C', repositoryDirectory(name), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660 })

const currentReleaseDirectory = () => {
  const current = join(releaseRoot, 'current')
  try {
    if (!lstatSync(current).isSymbolicLink()) return null
    return realpathSync(current)
  } catch {
    return null
  }
}

const currentManifest = () => {
  const current = currentReleaseDirectory()
  if (!current) return null
  try {
    return {
      release: readJson(join(current, 'release.json')),
      images: readJson(join(current, 'images.lock.json')),
    }
  } catch {
    return null
  }
}

const normalizeCommit = (name, revision) => {
  let commit
  try {
    commit = git(name, ['rev-parse', '--verify', `${revision}^{commit}`])
  } catch {
    throw new Error(`${name}: commit을 찾을 수 없습니다: ${revision}`)
  }
  try {
    git(name, ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'])
  } catch {
    throw new Error(`${name}: ${commit}은 origin/main에 포함된 commit이 아닙니다.`)
  }
  return commit
}

const manifestDigest = (directory) => {
  const hash = createHash('sha256')
  hash.update(readFileSync(join(directory, 'release.json')))
  hash.update(readFileSync(join(directory, 'images.lock.json')))
  return `sha256:${hash.digest('hex')}`
}

const validateRelease = (directory) => {
  const release = readJson(join(directory, 'release.json'))
  const imageLock = readJson(join(directory, 'images.lock.json'))

  if (release.schemaVersion !== 1 || release.releaseId !== basename(directory)) {
    throw new Error('release.json의 schemaVersion 또는 releaseId가 올바르지 않습니다.')
  }
  for (const [name] of repositories) {
    if (!/^[0-9a-f]{40}$/.test(release.sources?.[name] ?? '')) {
      throw new Error(`release.json에 ${name}의 정확한 commit SHA가 없습니다.`)
    }
  }
  if (imageLock.schemaVersion !== 1 || typeof imageLock.images !== 'object') {
    throw new Error('images.lock.json 형식이 올바르지 않습니다.')
  }
  for (const imageName of requiredImages) {
    if (!imageLock.images[imageName]) {
      throw new Error(`images.lock.json에 필수 image가 없습니다: ${imageName}`)
    }
  }
  for (const [imageName, image] of Object.entries(imageLock.images)) {
    if (!imageRepositories.has(image.sourceRepository)) {
      throw new Error(`${imageName}: 알 수 없는 sourceRepository입니다.`)
    }
    if (image.commit !== release.sources[image.sourceRepository]) {
      throw new Error(`${imageName}: source commit과 Release commit이 다릅니다.`)
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(image.digest ?? '')) {
      throw new Error(`${imageName}: OCI digest가 올바르지 않습니다.`)
    }
    if (!image.ref?.endsWith(`@${image.digest}`)) {
      throw new Error(`${imageName}: immutable image ref가 digest와 다릅니다.`)
    }
  }
  return { release, imageLock, digest: manifestDigest(directory) }
}

const prepare = (releaseId, options) => {
  if (!/^[0-9]{8}(?:-[a-z0-9][a-z0-9.-]*)?$/.test(releaseId ?? '')) {
    throw new Error('Release ID는 YYYYMMDD-name 형식이어야 합니다.')
  }

  const target = join(releaseRoot, releaseId)
  const temporary = join(releaseRoot, `.${releaseId}.prepare-${process.pid}`)
  try {
    lstatSync(target)
    throw new Error(`이미 존재하는 Release입니다: ${target}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const publisherMain = options.includes('--publisher-main')
  const overrides = new Map()
  for (const option of options.filter((value) => value !== '--publisher-main')) {
    const separator = option.indexOf('=')
    if (separator < 1) throw new Error(`저장소 override 형식이 아닙니다: ${option}`)
    const name = option.slice(0, separator)
    repositoryDirectory(name)
    overrides.set(name, option.slice(separator + 1))
  }

  const publisher = readJson(publisherStateFile)
  const previous = currentManifest()
  const sources = {}

  for (const [name] of repositories) {
    let revision = previous?.release.sources?.[name] ?? git(name, ['rev-parse', 'HEAD'])
    if (publisherMain && imageRepositories.has(name)) {
      revision = publisher.repositories?.[name]?.commit
      if (!revision) throw new Error(`${name}: Publisher 성공 commit이 없습니다.`)
    }
    if (overrides.has(name)) revision = overrides.get(name)
    sources[name] = normalizeCommit(name, revision)
  }

  const images = {}
  for (const repositoryName of imageRepositories) {
    const commit = sources[repositoryName]
    let repositoryImages = null
    if (publisher.repositories?.[repositoryName]?.commit === commit) {
      repositoryImages = publisher.repositories[repositoryName].images
    } else if (previous) {
      repositoryImages = Object.fromEntries(
        Object.entries(previous.images.images).filter(
          ([, image]) =>
            image.sourceRepository === repositoryName && image.commit === commit,
        ),
      )
    }
    if (!repositoryImages || Object.keys(repositoryImages).length === 0) {
      throw new Error(
        `${repositoryName}@${commit}: 보존된 Publisher image가 없습니다. ` +
          '해당 main image 발행을 확인하거나 --publisher-main을 사용하세요.',
      )
    }
    for (const [imageName, metadata] of Object.entries(repositoryImages)) {
      images[imageName] = {
        sourceRepository: repositoryName,
        commit,
        scope: imageName.endsWith('-dev-e2e') ? 'verification' : 'production',
        tag: metadata.tag,
        digest: metadata.digest,
        ref: metadata.ref,
      }
    }
  }

  mkdirSync(releaseRoot, { recursive: true, mode: 0o2770 })
  mkdirSync(temporary, { mode: 0o2770 })
  try {
    writeJson(join(temporary, 'release.json'), {
      schemaVersion: 1,
      releaseId,
      createdAt: new Date().toISOString(),
      status: 'candidate',
      sources,
    })
    writeJson(join(temporary, 'images.lock.json'), {
      schemaVersion: 1,
      platform: 'linux/arm64',
      generatedAt: new Date().toISOString(),
      images,
    })
    const digest = manifestDigest(temporary)
    writeJson(join(temporary, 'verification.json'), {
      schemaVersion: 1,
      status: 'pending',
      manifestDigest: digest,
      checks: [],
    })
    renameSync(temporary, target)
    process.stdout.write(`${target}\n`)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

const [command, ...args] = process.argv.slice(2)

try {
  if (command === 'prepare') {
    prepare(args[0], args.slice(1))
  } else if (command === 'validate') {
    process.stdout.write(`${validateRelease(args[0]).digest}\n`)
  } else {
    throw new Error(
      'usage: release-manifest.mjs prepare <release-id> [--publisher-main] [repo=sha ...] | validate <release-directory>',
    )
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
