import { readFile } from 'node:fs/promises'

import { Pool } from 'pg'

import { provisionEmailAccount } from '../auth/provision-email-account.js'
import { assertWebAuthSchema } from '../database/preflight.js'

const required = (name: string) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const readPassword = async () => {
  const inlinePassword = process.env.PROVISION_ACCOUNT_PASSWORD
  const passwordFile = process.env.PROVISION_ACCOUNT_PASSWORD_FILE
  if (Boolean(inlinePassword) === Boolean(passwordFile)) {
    throw new Error(
      'Configure exactly one of PROVISION_ACCOUNT_PASSWORD or PROVISION_ACCOUNT_PASSWORD_FILE',
    )
  }
  if (passwordFile) {
    return (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/u, '')
  }
  return inlinePassword as string
}

const databaseUrl = required('DATABASE_URL')
const email = required('PROVISION_ACCOUNT_EMAIL')
if (required('PROVISION_ACCOUNT_CONFIRM_EMAIL') !== email) {
  throw new Error('PROVISION_ACCOUNT_CONFIRM_EMAIL must exactly match the target email')
}
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'daejang-account-provisioner',
  max: 1,
  statement_timeout: 10_000,
})

try {
  await assertWebAuthSchema(pool)
  const result = await provisionEmailAccount(pool, {
    id: required('PROVISION_ACCOUNT_USER_ID'),
    displayName: required('PROVISION_ACCOUNT_DISPLAY_NAME'),
    email,
    password: await readPassword(),
  })
  process.stdout.write(
    `${JSON.stringify({
      status: 'provisioned',
      userId: result.user.id,
    })}\n`,
  )
} catch {
  process.stderr.write(`${JSON.stringify({ status: 'failed' })}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
