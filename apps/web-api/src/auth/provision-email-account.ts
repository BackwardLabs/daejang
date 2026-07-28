import { argon2id, hash } from 'argon2'
import type { Pool } from 'pg'

import { normalizeEmail, validatePassword } from './email-auth.js'
import { PostgresUserStore } from './postgres-user-store.js'

export type ProvisionEmailAccountInput = {
  id: string
  displayName: string
  email: string
  password: string
}

export const provisionEmailAccount = async (
  pool: Pool,
  input: ProvisionEmailAccountInput,
  now: Date = new Date(),
) => {
  const email = normalizeEmail(input.email)
  validatePassword(input.password)
  const passwordHash = await hash(input.password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  })
  const user = await new PostgresUserStore(pool).provisionEmailAccount({
    id: input.id,
    displayName: input.displayName,
    email,
    passwordHash,
    now,
  })
  return { user }
}
