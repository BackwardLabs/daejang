import type { Pool } from 'pg'

const webAuthContractDigest =
  'ece6dfe685b5318b112aa6c37854335edaa6028080fe3fdbe4bad866c7ffb4b6'

export const assertWebAuthSchema = async (pool: Pool) => {
  const preflight = await pool.query<{
    sessions_table: string | null
    rate_limit_table: string | null
    contract_version: number | null
    contract_digest: string | null
    migration_version: string | null
    membership_trigger: boolean
  }>(
    `
      SELECT
        to_regclass('web_private.sessions')::text AS sessions_table,
        to_regclass('web_private.auth_rate_limit_buckets')::text AS rate_limit_table,
        (
          SELECT version FROM web_private.schema_contracts WHERE component = 'web-auth'
        ) AS contract_version,
        (
          SELECT digest FROM web_private.schema_contracts WHERE component = 'web-auth'
        ) AS contract_digest,
        (
          SELECT migration_version
          FROM daejang_meta.schema_contract
          WHERE component = 'web-auth-persistence' AND contract_version = 1
        ) AS migration_version,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'web_private.workspace_memberships'::regclass
            AND tgname = 'workspace_membership_version_bump'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS membership_trigger
    `,
  )
  const row = preflight.rows[0]
  if (
    row?.sessions_table !== 'web_private.sessions' ||
    row.rate_limit_table !== 'web_private.auth_rate_limit_buckets' ||
    row.contract_version !== 1 ||
    row.contract_digest !== webAuthContractDigest ||
    row.migration_version !== '8' ||
    row.membership_trigger !== true
  ) {
    throw new Error('web_private authentication migration contract is invalid')
  }
}
