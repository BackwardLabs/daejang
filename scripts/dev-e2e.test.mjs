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

test('the product fixture and both API verifiers remain fixed to 2025', () => {
  assert.doesNotMatch(makefile, /DAEJANG_TAX_DEV_E2E_TAX_YEAR/)
  assert.doesNotMatch(runner, /DAEJANG_TAX_DEV_E2E_TAX_YEAR|tax_year/)
  assert.equal(
    (compose.match(/DAEJANG_TAX_DEV_E2E_TAX_YEAR: "2025"/g) ?? []).length,
    1,
  )
  for (const verifier of [sourcePipelineTest, reviewResolutionTest]) {
    assert.match(verifier, /const fixtureTaxYear = 2025 as const/)
    assert.doesNotMatch(verifier, /configuredTaxYear|DAEJANG_TAX_DEV_E2E_TAX_YEAR/)
  }
  assert.match(sourcePipelineTest, /tax-reports\/\$\{fixtureTaxYear\}\/current/)
  assert.match(reviewResolutionTest, /taxYear: fixtureTaxYear/)
  assert.match(reviewResolutionTest, /expectedFilingAction = 'FILING_NOT_APPLICABLE'/)
})

test('the connected source pipeline verifies exact report evidence and rendered PDF integrity', () => {
  assert.match(sourcePipelineTest, /tax-reports\/\$\{encodeURIComponent\(current\.report\.reportId\)\}\/evidence/)
  assert.match(sourcePipelineTest, /tax-reports\/\$\{encodeURIComponent\(current\.report\.reportId\)\}\/artifacts\/pdf/)
  assert.match(sourcePipelineTest, /application\/pdf/)
  assert.match(sourcePipelineTest, /%PDF-/)
  assert.match(sourcePipelineTest, /createHash\('sha256'\)/)
})

test('the Review flow verifies a causally newer report, evidence, and rendered PDF', () => {
  assert.match(reviewResolutionTest, /post-Review Tax report generation outcome/)
  assert.match(reviewResolutionTest, /state === 'REVIEW_REQUIRED'/)
  assert.match(reviewResolutionTest, /pointerVersion > initialGeneration\.pointerVersion/)
  assert.match(reviewResolutionTest, /outcome === 'REPORT'/)
  assert.match(reviewResolutionTest, /blockedReasonCode === 'REVIEW_REQUIRED'/)
  assert.match(reviewResolutionTest, /hasCurrentReport === true/)
  assert.match(reviewResolutionTest, /current\.reportId !== initialCurrent\.reportId/)
  assert.match(reviewResolutionTest, /giwa\.tax-report-model\.v2/)
  assert.match(reviewResolutionTest, /giwa\.tax-evidence-pack\.v2/)
  assert.match(reviewResolutionTest, /Post-Review rendered PDF/)
  assert.match(reviewResolutionTest, /taxReportModelReader: engine/)
  assert.match(reviewResolutionTest, /taxEvidencePackReader: engine/)
  assert.match(reviewResolutionTest, /current_tax_report_generation_status_read_v2/)
  assert.match(reviewResolutionTest, /current_tax_report_read_v2/)
  assert.match(reviewResolutionTest, /stableGeneration\.generationId === reportGeneration\.generationId/)
  assert.match(reviewResolutionTest, /stableCurrent\.reportId === current\.reportId/)
})

test('connected report verification runs before the mutating Review flow', () => {
  const service = compose.match(
    /^  web-api-tests:\n[\s\S]*?(?=^  web-api:\n)/m,
  )?.[0]
  assert.ok(service)
  const sourceCommand =
    'npm run test --workspace @daejang/web-api -- src/sources/source-pipeline.e2e.test.ts'
  const reviewCommand =
    'npm run test --workspace @daejang/web-api -- src/reviews/review-resolution.e2e.test.ts'
  assert.match(service, /command:\n\s+- \/bin\/sh\n\s+- -ec\n\s+- \|/)
  assert.equal(
    (service.match(/npm run test --workspace @daejang\/web-api --/g) ?? []).length,
    2,
  )
  assert.notEqual(service.indexOf(sourceCommand), -1)
  assert.notEqual(service.indexOf(reviewCommand), -1)
  assert.ok(service.indexOf(sourceCommand) < service.indexOf(reviewCommand))
  assert.doesNotMatch(service, /--no-file-parallelism/)
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
  assert.match(sourcePipelineTest, /tax-reports\/\$\{fixtureTaxYear\}\/current[\s\S]*productSessionCookie/)
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

test('production engine carries every store env the dev-e2e engine uses', async () => {
  // 같은 image 라도 배선(env)은 compose 파일마다 따로 적힌다. dev 에서 잘
  // 보이는데 production 에서 저장소 하나가 조용히 빠지는 drift(예: tax
  // report artifact 누락 — 보고서 상세만 UNAVAILABLE)를 머지 전에 잡는다.
  const { readFile } = await import('node:fs/promises')
  const engineEnvKeys = (compose) => {
    const match = compose.match(/^  engine:\n(?:.|\n)*?^ {4}environment:\n((?: {6}.*\n)+)/m)
    if (!match) throw new Error('engine environment block not found')
    return new Set(
      match[1].split('\n')
        .map((line) => line.trim().split(':')[0])
        .filter((key) => key.startsWith('DAEJANG_')),
    )
  }
  const devE2E = engineEnvKeys(await readFile(new URL('../deploy/compose.dev-e2e.yaml', import.meta.url), 'utf8'))
  const production = engineEnvKeys(await readFile(new URL('../deploy/compose.production.yaml', import.meta.url), 'utf8'))
  const missing = [...devE2E].filter((key) => !production.has(key))
  assert.deepEqual(missing, [], `production engine is missing store env keys: ${missing.join(', ')}`)
})
