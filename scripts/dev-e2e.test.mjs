import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
const compose = readFileSync(join(repositoryRoot, 'deploy/compose.dev-e2e.yaml'), 'utf8')
const runner = readFileSync(join(repositoryRoot, 'scripts/dev-e2e.sh'), 'utf8')
const sourcePipelineTest = readFileSync(
  join(repositoryRoot, 'apps/web-api/src/sources/source-pipeline.e2e.test.ts'),
  'utf8',
)
const reviewResolutionTest = readFileSync(
  join(repositoryRoot, 'apps/web-api/src/reviews/review-resolution.e2e.test.ts'),
  'utf8',
)

test('dev E2E uses the configurable DB migration boundary', () => {
  assert.match(makefile, /^DAEJANG_TAXD_DB_MIGRATION_VERSION \?= 90$/m)
  assert.match(
    compose,
    /^\s+DAEJANG_TAXD_DB_MIGRATION_VERSION: \$\{DAEJANG_TAXD_DB_MIGRATION_VERSION\}$/m,
  )
  assert.doesNotMatch(
    compose,
    /^\s+DAEJANG_TAXD_DB_MIGRATION_VERSION: ["']?77["']?$/m,
  )
  assert.match(compose, /^\s+DAEJANG_TAX_DEV_E2E_SUFFIX: \$\{DAEJANG_E2E_SUFFIX\}$/m)
})

test('the selected product tax year reaches the fixture and both API verifiers', () => {
  assert.match(makefile, /^DAEJANG_TAX_DEV_E2E_TAX_YEAR \?= 2025$/m)
  assert.match(runner, /case "\$tax_year" in\n\s+2025\|2026\|2027\)/)
  assert.match(runner, /DAEJANG_TAX_DEV_E2E_TAX_YEAR=%s/)
  assert.match(runner, /actual ledger publication|실제 ledger publication|fixture Event는 아직 미래/)
  assert.equal(
    (compose.match(/DAEJANG_TAX_DEV_E2E_TAX_YEAR: \$\{DAEJANG_TAX_DEV_E2E_TAX_YEAR:-2025\}/g) ?? []).length,
    2,
  )
  for (const verifier of [sourcePipelineTest, reviewResolutionTest]) {
    assert.match(verifier, /\^\(2025\|2026\|2027\)\$/)
    assert.match(verifier, /configuredTaxYear/)
  }
  assert.doesNotMatch(sourcePipelineTest, /tax-reports\/2025\/current/)
  assert.match(reviewResolutionTest, /taxYear: configuredTaxYear/)
})

test('GIWA Review E2E is explicit, fail-closed, and does not load a checkout env file', () => {
  assert.match(runner, /test-review-giwa/)
  assert.match(runner, /RUN_REVIEW_RESOLUTION_E2E_TESTS=1/)
  for (const name of [
    'REVIEWROOM_INTERNAL_API_URL',
    'REVIEWROOM_APPLICATION_RECEIPT_TOKEN',
    'REVIEWROOM_RESOLUTION_INGEST_TOKEN',
    'REVIEWROOM_PROOF_VECTOR_TOKEN',
  ]) {
    assert.match(runner, new RegExp(`${name}.*required for test-review-giwa|${name}`))
  }
  assert.match(runner, /DOTENV_CONFIG_PATH=\/dev\/null/)
  assert.match(runner, /DAEJANG_DATABASE_URL="\$DAEJANG_E2E_EVENT_DATABASE_URL"/)
  assert.match(runner, /review-giwa-.*secrets\.token_hex\(4\)/)
  assert.match(runner, /\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$/)
  assert.match(runner, /src\/deliveryWorker\.ts/)
  assert.doesNotMatch(runner, /(?:^|\n)\s*(?:source|\.)\s+[^\n]*\.env(?:\s|$)/)
})

test('Tax and the authenticated verifier receive only their scoped ReviewRoom settings', () => {
  for (const name of [
    'REVIEWROOM_INTERNAL_API_URL',
    'REVIEWROOM_APPLICATION_RECEIPT_TOKEN',
    'REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT',
    'REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP',
    'RUN_REVIEW_RESOLUTION_E2E_TESTS',
    'REVIEWROOM_PROOF_VECTOR_TOKEN',
  ]) {
    assert.match(compose, new RegExp(`${name}: \\$\\{${name}\\}`))
  }
  assert.match(compose, /src\/reviews\/review-resolution\.e2e\.test\.ts/)
})

test('persistent source checks cannot add ledger data to the product Review subject', () => {
  assert.match(
    sourcePipelineTest,
    /productAccount = \{[\s\S]*id: '00000000-0000-4000-8000-00000000e2e1'/,
  )
  assert.match(
    sourcePipelineTest,
    /sourcePipelineAccount = \{[\s\S]*id: '00000000-0000-4000-8000-00000000e2f1'/,
  )
  assert.match(sourcePipelineTest, /const userId = sourcePipelineAccount\.id/)
  assert.match(
    sourcePipelineTest,
    /provisionEmailAccount\(ownerPool, sourcePipelineAccount\)/,
  )
  assert.match(sourcePipelineTest, /tax-reports\/\$\{configuredTaxYear\}\/current[\s\S]*productSessionCookie/)
})

test('each public command dispatches exactly one internal container mode', () => {
  assert.match(runner, /up\) container_action=--run-persistent ;;/)
  assert.match(
    runner,
    /test-review-giwa\) container_action=--run-review-container-tests ;;/,
  )
  assert.match(runner, /\*\) container_action=--run-container-tests ;;/)
  assert.match(runner, /-- "\$repo_root\/scripts\/dev-e2e\.sh" \\\n\s+"\$container_action"/)
  assert.doesNotMatch(runner, /\$\(\[\[ "\$action" == up \]\]/)
})
