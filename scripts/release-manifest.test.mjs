import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const manifestTool = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url))
const repositoryNames = [
  'evm-indexer',
  'DeFi-Label',
  'daejang',
  'daejang-db',
  'daejang-jit-engine',
  'daejang-posting-service',
  'daejang-reviewroom',
  'daejang-tax-engine',
  'pdf-parser',
  'schema',
]

const git = (directory, ...args) =>
  execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const image = (repository, name, commit, digit) => {
  const digest = `sha256:${digit.repeat(64)}`
  const base = `registry.test/daejang/${name}`
  return {
    tag: `${base}:sha-${commit}`,
    digest,
    ref: `${base}@${digest}`,
  }
}

test('prepares and validates an immutable Release from Publisher commits', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'daejang-release-manifest-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const releases = join(root, 'releases')
  const commits = {}

  for (const name of repositoryNames) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    git(directory, 'init', '-q')
    git(directory, 'config', 'user.name', 'Release Test')
    git(directory, 'config', 'user.email', 'release@test.invalid')
    await writeFile(join(directory, 'README.md'), `${name}\n`)
    git(directory, 'add', 'README.md')
    git(directory, 'commit', '-qm', 'Initial fixture')
    commits[name] = git(directory, 'rev-parse', 'HEAD')
    git(directory, 'update-ref', 'refs/remotes/origin/main', commits[name])
  }

  const publisherState = join(root, 'publisher-state.json')
  await writeFile(
    publisherState,
    `${JSON.stringify({
      schemaVersion: 1,
      repositories: {
        daejang: {
          commit: commits.daejang,
          images: {
            'web-api': image('daejang', 'web-api', commits.daejang, '1'),
            engine: image('daejang', 'engine', commits.daejang, '2'),
            'pdf-parser': image('daejang', 'pdf-parser', commits.daejang, '3'),
          },
        },
        'daejang-jit-engine': {
          commit: commits['daejang-jit-engine'],
          images: {
            'jit-engine': image(
              'daejang-jit-engine',
              'jit-engine',
              commits['daejang-jit-engine'],
              '4',
            ),
          },
        },
        'daejang-posting-service': {
          commit: commits['daejang-posting-service'],
          images: {
            'posting-service': image(
              'daejang-posting-service',
              'posting-service',
              commits['daejang-posting-service'],
              '5',
            ),
          },
        },
        'daejang-reviewroom': {
          commit: commits['daejang-reviewroom'],
          images: {
            reviewroom: image(
              'daejang-reviewroom',
              'reviewroom',
              commits['daejang-reviewroom'],
              '8',
            ),
          },
        },
        'daejang-tax-engine': {
          commit: commits['daejang-tax-engine'],
          images: {
            'tax-engine': image(
              'daejang-tax-engine',
              'tax-engine',
              commits['daejang-tax-engine'],
              '6',
            ),
            'tax-engine-dev-e2e': image(
              'daejang-tax-engine',
              'tax-engine-dev-e2e',
              commits['daejang-tax-engine'],
              '7',
            ),
          },
        },
      },
    })}\n`,
  )

  const environment = {
    ...process.env,
    GIWA_DAEJANG_ROOT: root,
    GIWA_RELEASE_ROOT: releases,
    DAEJANG_PUBLISHER_STATE_FILE: publisherState,
  }
  execFileSync(
    process.execPath,
    [manifestTool, 'prepare', '20260815-test', '--publisher-main'],
    { env: environment },
  )
  const releaseDirectory = join(releases, '20260815-test')
  const digest = execFileSync(
    process.execPath,
    [manifestTool, 'validate', releaseDirectory],
    { encoding: 'utf8', env: environment },
  ).trim()
  const release = JSON.parse(await readFile(join(releaseDirectory, 'release.json')))
  const images = JSON.parse(await readFile(join(releaseDirectory, 'images.lock.json')))

  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(release.sources, commits)
  assert.equal(images.images['posting-service'].scope, 'production')
  assert.equal(images.images.reviewroom.scope, 'production')
  assert.equal(images.images['tax-engine-dev-e2e'].scope, 'verification')
  assert.equal(
    images.images['web-api'].commit,
    release.sources.daejang,
  )
  assert.equal(
    images.images.reviewroom.commit,
    release.sources['daejang-reviewroom'],
  )
})
