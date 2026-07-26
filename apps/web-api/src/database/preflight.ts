import type { Pool } from 'pg'

const webAuthContractDigest =
  'a70f036a58e79b949d9e07878bd5d9e8643e6579732e652c4ea11716fc0ff9ad'

export const assertWebAuthSchema = async (pool: Pool) => {
  const preflight = await pool.query<{
    users_table: string | null
    identities_table: string | null
    sessions_table: string | null
    legal_documents_table: string | null
    user_consents_table: string | null
    rate_limit_table: string | null
    contract_version: number | null
    contract_digest: string | null
    migration_version: string | null
    legal_documents_guard: boolean
    user_consents_guard: boolean
  }>(
    `
      SELECT
        to_regclass('web_private.users')::text AS users_table,
        to_regclass('web_private.auth_identities')::text AS identities_table,
        to_regclass('web_private.sessions')::text AS sessions_table,
        to_regclass('web_private.legal_documents')::text AS legal_documents_table,
        to_regclass('web_private.user_consents')::text AS user_consents_table,
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
          WHERE tgrelid = to_regclass('web_private.legal_documents')
            AND tgname = 'legal_documents_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS legal_documents_guard,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.user_consents')
            AND tgname = 'user_consents_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS user_consents_guard
    `,
  )
  const row = preflight.rows[0]
  if (
    row?.users_table !== 'web_private.users' ||
    row.identities_table !== 'web_private.auth_identities' ||
    row.sessions_table !== 'web_private.sessions' ||
    row.legal_documents_table !== 'web_private.legal_documents' ||
    row.user_consents_table !== 'web_private.user_consents' ||
    row.rate_limit_table !== 'web_private.auth_rate_limit_buckets' ||
    row.contract_version !== 1 ||
    row.contract_digest !== webAuthContractDigest ||
    row.migration_version !== '8' ||
    row.legal_documents_guard !== true ||
    row.user_consents_guard !== true
  ) {
    throw new Error('web_private authentication migration contract is invalid')
  }

  const walletSource = await pool.query<{
    wallet_sources_table: string | null
    wallet_chain_scopes_table: string | null
    wallet_challenges_table: string | null
    contract_version: string | null
    migration_version: string | null
  }>(
    `
      SELECT
        to_regclass('source_private.wallet_sources')::text AS wallet_sources_table,
        to_regclass('source_private.wallet_chain_scopes')::text AS wallet_chain_scopes_table,
        to_regclass('source_private.wallet_ownership_challenges')::text AS wallet_challenges_table,
        (
          SELECT contract_version
          FROM daejang_meta.schema_contract
          WHERE component = 'wallet-source-persistence'
        ) AS contract_version,
        (
          SELECT migration_version
          FROM daejang_meta.schema_contract
          WHERE component = 'wallet-source-persistence'
        ) AS migration_version
    `,
  )
  const walletRow = walletSource.rows[0]
  if (
    walletRow?.wallet_sources_table !== 'source_private.wallet_sources' ||
    walletRow.wallet_chain_scopes_table !== 'source_private.wallet_chain_scopes' ||
    walletRow.wallet_challenges_table !==
      'source_private.wallet_ownership_challenges' ||
    walletRow.contract_version !== '2' ||
    walletRow.migration_version !== '10'
  ) {
    throw new Error('source_private wallet migration contract is invalid')
  }
}
