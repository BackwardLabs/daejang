import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const releaseScript = await readFile(
  new URL('./mac-studio-release.sh', import.meta.url),
  'utf8',
)
const manifestTool = await readFile(
  new URL('./release-manifest.mjs', import.meta.url),
  'utf8',
)

const functionBody = (name) => {
  const start = releaseScript.indexOf(`${name}() {`)
  assert.notEqual(start, -1, `${name} is missing`)
  const nextFunction = releaseScript.indexOf('\n}\n\n', start)
  assert.notEqual(nextFunction, -1, `${name} is not terminated`)
  return releaseScript.slice(start, nextFunction + 3)
}

test('runs database migrations while the backend is stopped', () => {
  const body = functionBody('restart_backend_with_migrations')
  const stop = body.indexOf('run backend:stop')
  const migrate = body.indexOf('make database-up')
  const start = body.indexOf('run backend:start')
  const status = body.indexOf('run backend:status')

  assert.ok(stop > 0)
  assert.ok(migrate > stop)
  assert.ok(start > migrate)
  assert.ok(status > start)
})

test('all backend deployment paths use the migration gate', () => {
  for (const name of ['deploy_backend', 'deploy_all']) {
    const body = functionBody(name)
    assert.match(body, /restart_backend_with_migrations/)
    assert.doesNotMatch(body, /backend:restart/)
  }
})

test('deployment paths never move Production to origin/main', () => {
  for (const name of ['deploy_indexer', 'deploy_backend', 'deploy_all']) {
    const body = functionBody(name)
    assert.doesNotMatch(body, /sync_(?:sources|backend_sources|indexer_source)/)
    assert.doesNotMatch(body, /merge_repository/)
  }
})

test('promotion verifies the manifest before changing checkouts and pointers', () => {
  const body = functionBody('promote_release')
  const verify = body.indexOf('assert_release_verified')
  const checkout = body.indexOf('checkout_repository_set')
  const deploy = body.indexOf('deploy_all')
  const pointer = body.indexOf('atomic_release_link current')

  assert.ok(verify > 0)
  assert.ok(checkout > verify)
  assert.ok(deploy > checkout)
  assert.ok(pointer > deploy)
})

test('rollback restores recorded commits before moving the current pointer', () => {
  const body = functionBody('rollback_release')
  const checkout = body.indexOf('checkout_repository_set "$rollback_file"')
  const deploy = body.indexOf('deploy_all')
  const pointer = body.indexOf('atomic_release_link current')

  assert.ok(checkout > 0)
  assert.ok(deploy > checkout)
  assert.ok(pointer > deploy)
})

test('candidate manifests pin source commits and immutable image digests', () => {
  assert.match(manifestTool, /merge-base.*--is-ancestor/)
  assert.match(manifestTool, /image\.commit !== release\.sources/)
  assert.match(manifestTool, /image\.ref\?\.endsWith\(`@\$\{image\.digest\}`\)/)
  assert.match(manifestTool, /status: 'candidate'/)
})
