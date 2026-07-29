import { randomUUID } from 'node:crypto'

import type { PoolClient } from 'pg'

export type VerifiedSubjectNameClaim = {
  value: string
  normalizedValue: string
  verificationMethod: 'MANUAL_KYC' | 'PROVIDER_KYC'
  assuranceLevel: 'BASIC' | 'SUBSTANTIAL' | 'HIGH'
  verifierReference: string
  verifiedAt: Date
}

export const normalizeSubjectName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ')

export const insertVerifiedSubjectNameClaim = async (
  client: PoolClient,
  userId: string,
  claim: VerifiedSubjectNameClaim,
) => {
  await client.query(
    `
      INSERT INTO web_private.subject_name_claims (
        claim_id,
        user_id,
        subject_name,
        normalized_name,
        verification_method,
        assurance_level,
        verifier_ref,
        verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      randomUUID(),
      userId,
      claim.value,
      claim.normalizedValue,
      claim.verificationMethod,
      claim.assuranceLevel,
      claim.verifierReference,
      claim.verifiedAt,
    ],
  )
}
