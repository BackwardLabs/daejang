import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dockerfile = await readFile(
  new URL('../apps/web-api/Dockerfile', import.meta.url),
  'utf8',
)
const publisher = await readFile(
  new URL(
    '../deploy/registry/scripts/build-core-images.sh',
    import.meta.url,
  ),
  'utf8',
)

test('production web-api image requires and verifies the pinned EAS runtime', () => {
  assert.match(
    dockerfile,
    /COPY \.docker-runtime\/daejang-contracts \/app\/node_modules\/@backward-labs\/daejang-contracts/,
  )
  assert.match(
    dockerfile,
    /GIWA_REPORT_ATTESTATION_RUNTIME_REQUIRED/,
  )
  assert.match(
    dockerfile,
    /createGiwaSepoliaReportRuntimeV1/,
  )
  assert.match(
    publisher,
    /expected_entry_sha256=d7a29f3ed606ed24897f6a7c292bfa7294be760466fba23d834b6c896f112acb/,
  )
  assert.match(
    publisher,
    /--build-arg GIWA_REPORT_ATTESTATION_RUNTIME_REQUIRED=true/,
  )
})
