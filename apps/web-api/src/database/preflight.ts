import type { Pool } from 'pg'

const webAuthContractDigest =
  'a70f036a58e79b949d9e07878bd5d9e8643e6579732e652c4ea11716fc0ff9ad'
const oauthEmailContractDigest =
  '19cb27f0bdae2d9d42419ae05b3253ecfee2aeaeddf8317bfe95073f6dfa97c1'

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
    legal_document_contents_table: string | null
    legal_document_contents_hash_guard: boolean
    legal_document_contents_guard: boolean
    user_consents_guard: boolean
    signup_sessions_table: string | null
    oauth_transactions_table: string | null
    user_emails_table: string | null
    email_credentials_table: string | null
    email_challenges_table: string | null
    oauth_email_contract_version: number | null
    oauth_email_contract_digest: string | null
    oauth_email_migration_version: string | null
    oauth_consume_function: string | null
    user_email_source_guard: boolean
    email_credential_source_guard: boolean
    auth_identity_composite_guard: boolean
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
          WHERE component = 'web-auth-persistence' AND contract_version = 2
        ) AS migration_version,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.legal_documents')
            AND tgname = 'legal_documents_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS legal_documents_guard,
        to_regclass('web_private.legal_document_contents')::text
          AS legal_document_contents_table,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.legal_document_contents')
            AND tgname = 'legal_document_contents_validate_hash'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS legal_document_contents_hash_guard,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.legal_document_contents')
            AND tgname = 'legal_document_contents_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS legal_document_contents_guard,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.user_consents')
            AND tgname = 'user_consents_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS user_consents_guard,
        to_regclass('web_private.signup_sessions')::text AS signup_sessions_table,
        to_regclass('web_private.oauth_transactions')::text AS oauth_transactions_table,
        to_regclass('web_private.user_emails')::text AS user_emails_table,
        to_regclass('web_private.email_credentials')::text AS email_credentials_table,
        to_regclass('web_private.email_verification_challenges')::text
          AS email_challenges_table,
        (
          SELECT version
          FROM web_private.schema_contracts
          WHERE component = 'web-auth-oauth-email'
        ) AS oauth_email_contract_version,
        (
          SELECT digest
          FROM web_private.schema_contracts
          WHERE component = 'web-auth-oauth-email'
        ) AS oauth_email_contract_digest,
        (
          SELECT migration_version
          FROM daejang_meta.schema_contract
          WHERE component = 'web-auth-oauth-email-persistence'
            AND contract_version = 1
        ) AS oauth_email_migration_version,
        to_regprocedure('web_private.consume_oauth_transaction(text)')::text
          AS oauth_consume_function,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.user_emails')
            AND tgname = 'user_emails_validate_source'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS user_email_source_guard,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.email_credentials')
            AND tgname = 'email_credentials_validate_source'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS email_credential_source_guard,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = to_regclass('web_private.auth_identities')
            AND conname = 'auth_identities_id_user_id_unique'
            AND contype = 'u'
        ) AS auth_identity_composite_guard
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
    row.migration_version !== '11' ||
    row.legal_documents_guard !== true ||
    row.legal_document_contents_table !==
      'web_private.legal_document_contents' ||
    row.legal_document_contents_hash_guard !== true ||
    row.legal_document_contents_guard !== true ||
    row.user_consents_guard !== true ||
    row.signup_sessions_table !== 'web_private.signup_sessions' ||
    row.oauth_transactions_table !== 'web_private.oauth_transactions' ||
    row.user_emails_table !== 'web_private.user_emails' ||
    row.email_credentials_table !== 'web_private.email_credentials' ||
    row.email_challenges_table !==
      'web_private.email_verification_challenges' ||
    row.oauth_email_contract_version !== 1 ||
    row.oauth_email_contract_digest !== oauthEmailContractDigest ||
    row.oauth_email_migration_version !== '15' ||
    row.oauth_consume_function !==
      'web_private.consume_oauth_transaction(text)' ||
    row.user_email_source_guard !== true ||
    row.email_credential_source_guard !== true ||
    row.auth_identity_composite_guard !== true
  ) {
    throw new Error('web_private authentication migration contract is invalid')
  }

  const walletSource = await pool.query<{
    wallet_challenges_table: string | null
    upload_sessions_table: string | null
  }>(
    `
      SELECT
        to_regclass('web_private.wallet_ownership_challenges')::text AS wallet_challenges_table,
        to_regclass('web_private.upload_sessions')::text AS upload_sessions_table
    `,
  )
  const walletRow = walletSource.rows[0]
  if (
    walletRow?.wallet_challenges_table !==
      'web_private.wallet_ownership_challenges' ||
    walletRow.upload_sessions_table !== 'web_private.upload_sessions'
  ) {
    throw new Error('web_private wallet challenge migration contract is invalid')
  }
}

export const assertTaxReportSchema = async (pool: Pool) => {
  const result = await pool.query<{
    report_table: string | null
    current_table: string | null
    inventory_table: string | null
    estimate_table: string | null
    contract_version: string | null
    migration_version: string | null
  }>(`
    SELECT
      to_regclass('reporting.tax_report')::text AS report_table,
      to_regclass('reporting.current_tax_report')::text AS current_table,
      to_regclass('tax.inventory_run')::text AS inventory_table,
      to_regclass('tax.estimate')::text AS estimate_table,
      (SELECT contract_version::text FROM daejang_meta.schema_contract WHERE component='tax-report-persistence') AS contract_version,
      (SELECT migration_version::text FROM daejang_meta.schema_contract WHERE component='tax-report-persistence') AS migration_version
  `)
  const row = result.rows[0]
  if (
    row?.report_table !== 'reporting.tax_report' ||
    row.current_table !== 'reporting.current_tax_report' ||
    row.inventory_table !== 'tax.inventory_run' ||
    row.estimate_table !== 'tax.estimate' ||
    row.contract_version !== '1' ||
    row.migration_version !== '24'
  ) {
    throw new Error('tax report persistence migration contract is invalid')
  }
}
