import { Pool } from 'pg'

import { provisionSubjectNameClaim } from '../auth/provision-subject-name-claim.js'
import { normalizeSubjectName } from '../auth/subject-name-claim.js'
import { assertSubjectNameProvisionerSchema } from '../database/preflight.js'

const required = (name: string) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const userId = required('PROVISION_SUBJECT_CLAIM_USER_ID')
if (required('PROVISION_SUBJECT_CLAIM_CONFIRM_USER_ID') !== userId) {
  throw new Error('PROVISION_SUBJECT_CLAIM_CONFIRM_USER_ID must exactly match the target')
}
const email = required('PROVISION_SUBJECT_CLAIM_EMAIL')
if (required('PROVISION_SUBJECT_CLAIM_CONFIRM_EMAIL') !== email) {
  throw new Error('PROVISION_SUBJECT_CLAIM_CONFIRM_EMAIL must exactly match the target')
}
const subjectName = required('PROVISION_SUBJECT_CLAIM_NAME')
if (required('PROVISION_SUBJECT_CLAIM_CONFIRM_NAME') !== subjectName) {
  throw new Error('PROVISION_SUBJECT_CLAIM_CONFIRM_NAME must exactly match the target')
}
if (subjectName.trim() !== subjectName || subjectName.length > 120) {
  throw new Error('PROVISION_SUBJECT_CLAIM_NAME must be trimmed and at most 120 characters')
}
const verificationMethod = required('PROVISION_SUBJECT_CLAIM_VERIFICATION_METHOD')
if (verificationMethod !== 'MANUAL_KYC' && verificationMethod !== 'PROVIDER_KYC') {
  throw new Error('PROVISION_SUBJECT_CLAIM_VERIFICATION_METHOD is invalid')
}
const assuranceLevel = required('PROVISION_SUBJECT_CLAIM_ASSURANCE_LEVEL')
if (!['BASIC', 'SUBSTANTIAL', 'HIGH'].includes(assuranceLevel)) {
  throw new Error('PROVISION_SUBJECT_CLAIM_ASSURANCE_LEVEL is invalid')
}
const verifierReference = required('PROVISION_SUBJECT_CLAIM_VERIFIER_REFERENCE')
if (verifierReference.trim() !== verifierReference || verifierReference.length > 512) {
  throw new Error('PROVISION_SUBJECT_CLAIM_VERIFIER_REFERENCE is invalid')
}
const verifiedAt = new Date(required('PROVISION_SUBJECT_CLAIM_VERIFIED_AT'))
if (Number.isNaN(verifiedAt.getTime()) || verifiedAt.getTime() > Date.now()) {
  throw new Error('PROVISION_SUBJECT_CLAIM_VERIFIED_AT must be a valid non-future timestamp')
}

const pool = new Pool({
  connectionString: required('IDENTITY_PROVISIONER_DATABASE_URL'),
  application_name: 'daejang-subject-claim-provisioner',
  max: 1,
  statement_timeout: 10_000,
})

try {
  await assertSubjectNameProvisionerSchema(pool)
  const result = await provisionSubjectNameClaim(pool, {
    userId,
    email,
    claim: {
      value: subjectName,
      normalizedValue: normalizeSubjectName(subjectName),
      verificationMethod,
      assuranceLevel: assuranceLevel as 'BASIC' | 'SUBSTANTIAL' | 'HIGH',
      verifierReference,
      verifiedAt,
    },
  })
  process.stdout.write(`${JSON.stringify({ status: 'provisioned', userId: result.userId })}\n`)
} catch {
  process.stderr.write(`${JSON.stringify({ status: 'failed' })}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
