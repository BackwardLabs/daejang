import type { Pool } from 'pg'

import { normalizeEmail } from './email-auth.js'
import {
  insertVerifiedSubjectNameClaim,
  type VerifiedSubjectNameClaim,
} from './subject-name-claim.js'

export const provisionSubjectNameClaim = async (
  pool: Pool,
  input: {
    userId: string
    email: string
    claim: VerifiedSubjectNameClaim
  },
) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `verified-subject-name:${input.userId}`,
    ])
    const target = await client.query<{ id: string }>(
      `
        SELECT user_record.id
        FROM web_private.users user_record
        JOIN web_private.user_emails user_email
          ON user_email.user_id = user_record.id
         AND user_email.is_primary
         AND user_email.login_enabled
         AND user_email.giwa_verified_at IS NOT NULL
        WHERE user_record.id = $1
          AND user_record.status = 'active'
          AND user_email.normalized_email = $2
      `,
      [input.userId, normalizeEmail(input.email)],
    )
    if (target.rows[0]?.id !== input.userId) {
      throw new Error('Active verified account target does not match')
    }
    await insertVerifiedSubjectNameClaim(client, input.userId, input.claim)
    await client.query('COMMIT')
    return { userId: input.userId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
