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

test('Release deployment pins ReviewRoom to the manifest digest and migrates before workers start', () => {
  const body = functionBody('deploy_reviewroom')
  const config = body.indexOf('config --quiet')
  const migrationConfig = body.indexOf('--profile migrate config --quiet')
  const pull = body.indexOf('pull')
  const migrate = body.indexOf('run --rm migrate')
  const start = body.indexOf('up --detach --wait api anchor-worker delivery-worker')

  assert.match(body, /reviewroom_image_reference/)
  assert.match(body, /reviewroom_compose/)
  assert.ok(config > 0)
  assert.ok(migrationConfig > config)
  assert.ok(pull > migrationConfig)
  assert.ok(migrate > pull)
  assert.ok(start > migrate)
  assert.doesNotMatch(body, /:latest/)
})

test('system verification includes the ReviewRoom canonical E2E worktree', () => {
  const body = functionBody('run_release_system_e2e')

  assert.match(body, /daejang-reviewroom/)
  assert.match(body, /reviewroom_image_reference/)
  assert.match(body, /run_reviewroom_release_e2e/)
})

test('ReviewRoom canonical E2E uses disposable PostgreSQL and Anvil', () => {
  const body = functionBody('run_reviewroom_release_e2e')

  assert.match(body, /postgres:18\.4-alpine3\.24/)
  assert.match(body, /anvil --host 127\.0\.0\.1/)
  assert.match(body, /npm --prefix .*test:e2e:canonical/)
  assert.match(body, /docker stop .*postgres_container/)
})

test('all Release deployments restore the corresponding ReviewRoom digest', () => {
  const promote = functionBody('promote_release')
  const rollback = functionBody('rollback_release')
  const deploy = functionBody('deploy_all')

  assert.match(deploy, /deploy_reviewroom "\$release_dir"/)
  assert.match(promote, /deploy_all "\$release_dir"/)
  assert.match(promote, /deploy_all "\$previous_target"/)
  assert.match(rollback, /deploy_all "\$previous_target"/)
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
  const deploy = body.indexOf('deploy_all "$release_dir"')
  const pointer = body.indexOf('atomic_release_link current')

  assert.ok(verify > 0)
  assert.ok(checkout > verify)
  assert.ok(deploy > checkout)
  assert.ok(pointer > deploy)
})

test('rollback restores recorded commits before moving the current pointer', () => {
  const body = functionBody('rollback_release')
  const checkout = body.indexOf('checkout_repository_set "$rollback_file"')
  const deploy = body.indexOf('deploy_all "$previous_target"')
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
  assert.match(
    manifestTool,
    /imageRepositories = new Set\(\[\s*'daejang',[\s\S]*'daejang-reviewroom'/,
  )
  assert.match(
    manifestTool,
    /requiredImages = new Set\(\[[\s\S]*'reviewroom'/,
  )
})
