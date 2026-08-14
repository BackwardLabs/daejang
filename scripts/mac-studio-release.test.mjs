import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const releaseScript = await readFile(
  new URL('./mac-studio-release.sh', import.meta.url),
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
