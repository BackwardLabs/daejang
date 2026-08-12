import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDirectory = resolve(
  process.argv[2] ?? join(repositoryRoot, 'apps/web/dist/assets'),
)
const mode = process.env.VITE_REPORTS_UI_MODE ?? 'product'
const profiles = {
  product: {
    required: [
      'TAX LEDGER',
      '신고 준비 자료 PDF',
      '검토용 PDF',
      '장부 revision',
    ],
    forbidden: [
      'SYNTHETIC · GIWA SEPOLIA TESTNET',
      '/report-attestations/synthetic-publication',
      'SYNTHETIC_POLICY_PASS',
      '/report-payments/capabilities',
      'FINAL 현재 세금 결과 내려받기',
    ],
  },
  'giwa28-demo': {
    required: [
      'SYNTHETIC · GIWA SEPOLIA TESTNET',
      '/report-attestations/synthetic-publication',
    ],
    forbidden: [
      'TAX LEDGER',
      '/tax-reports/',
      '신고 준비 자료 PDF',
      '검토용 PDF',
      '장부 revision',
      '/report-payments/capabilities',
      'FINAL 현재 세금 결과 내려받기',
    ],
  },
}
const profile = profiles[mode]

if (!profile) {
  throw new Error(`Unsupported report surface mode: ${mode}`)
}

const files = (await readdir(assetsDirectory))
  .filter((file) => file.endsWith('.js'))
  .sort()
const bundle = (
  await Promise.all(
    files.map((file) => readFile(join(assetsDirectory, file), 'utf8')),
  )
).join('\n')
const missing = profile.required.filter((marker) => !bundle.includes(marker))
const leaked = profile.forbidden.filter((marker) => bundle.includes(marker))

if (missing.length > 0 || leaked.length > 0) {
  if (missing.length > 0) {
    console.error(`Missing ${mode} report markers: ${missing.join(', ')}`)
  }
  if (leaked.length > 0) {
    console.error(`Forbidden ${mode} report markers: ${leaked.join(', ')}`)
  }
  process.exitCode = 1
} else {
  console.log(`Verified ${mode} report surface bundle isolation.`)
}
