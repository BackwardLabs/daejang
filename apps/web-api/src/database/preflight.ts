import type { Pool } from 'pg'

const webAuthContractDigest =
  'a70f036a58e79b949d9e07878bd5d9e8643e6579732e652c4ea11716fc0ff9ad'
const oauthEmailContractDigest =
  '19cb27f0bdae2d9d42419ae05b3253ecfee2aeaeddf8317bfe95073f6dfa97c1'

export const assertSubjectNameProvisionerSchema = async (pool: Pool) => {
  const result = await pool.query<{
    role_name: string
    contract_version: string | null
    migration_version: string | null
    users_table: string | null
    user_emails_table: string | null
    claims_table: string | null
    claims_guard: boolean
    web_usage: boolean
    meta_usage: boolean
    schema_create: boolean
    users_id_select: boolean
    users_status_select: boolean
    email_user_id_select: boolean
    email_normalized_select: boolean
    email_primary_select: boolean
    email_login_select: boolean
    email_verified_select: boolean
    claim_id_select: boolean
    claim_user_id_select: boolean
    claim_id_insert: boolean
    claim_user_id_insert: boolean
    claim_name_insert: boolean
    claim_normalized_insert: boolean
    claim_method_insert: boolean
    claim_assurance_insert: boolean
    claim_verifier_insert: boolean
    claim_verified_at_insert: boolean
    dangerous_table_write: boolean
  }>(`
    SELECT
      current_user AS role_name,
      (
        SELECT contract_version::text
        FROM daejang_meta.schema_contract
        WHERE component = 'web-subject-name-claim-provisioning'
      ) AS contract_version,
      (
        SELECT migration_version::text
        FROM daejang_meta.schema_contract
        WHERE component = 'web-subject-name-claim-provisioning'
      ) AS migration_version,
      to_regclass('web_private.users')::text AS users_table,
      to_regclass('web_private.user_emails')::text AS user_emails_table,
      to_regclass('web_private.subject_name_claims')::text AS claims_table,
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('web_private.subject_name_claims')
          AND tgname = 'subject_name_claims_append_only'
          AND tgenabled IN ('O', 'A')
          AND NOT tgisinternal
      ) AS claims_guard,
      has_schema_privilege(current_user, 'web_private', 'USAGE') AS web_usage,
      has_schema_privilege(current_user, 'daejang_meta', 'USAGE') AS meta_usage,
      has_schema_privilege(current_user, 'web_private', 'CREATE')
        OR has_schema_privilege(current_user, 'daejang_meta', 'CREATE') AS schema_create,
      has_column_privilege(current_user, 'web_private.users', 'id', 'SELECT') AS users_id_select,
      has_column_privilege(current_user, 'web_private.users', 'status', 'SELECT') AS users_status_select,
      has_column_privilege(current_user, 'web_private.user_emails', 'user_id', 'SELECT') AS email_user_id_select,
      has_column_privilege(current_user, 'web_private.user_emails', 'normalized_email', 'SELECT') AS email_normalized_select,
      has_column_privilege(current_user, 'web_private.user_emails', 'is_primary', 'SELECT') AS email_primary_select,
      has_column_privilege(current_user, 'web_private.user_emails', 'login_enabled', 'SELECT') AS email_login_select,
      has_column_privilege(current_user, 'web_private.user_emails', 'giwa_verified_at', 'SELECT') AS email_verified_select,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'claim_id', 'SELECT') AS claim_id_select,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'user_id', 'SELECT') AS claim_user_id_select,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'claim_id', 'INSERT') AS claim_id_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'user_id', 'INSERT') AS claim_user_id_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'subject_name', 'INSERT') AS claim_name_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'normalized_name', 'INSERT') AS claim_normalized_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'verification_method', 'INSERT') AS claim_method_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'assurance_level', 'INSERT') AS claim_assurance_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'verifier_ref', 'INSERT') AS claim_verifier_insert,
      has_column_privilege(current_user, 'web_private.subject_name_claims', 'verified_at', 'INSERT') AS claim_verified_at_insert,
      has_table_privilege(
        current_user,
        'web_private.subject_name_claims',
        'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR has_table_privilege(
        current_user,
        'web_private.users',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR has_table_privilege(
        current_user,
        'web_private.user_emails',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) AS dangerous_table_write
  `)
  const row = result.rows[0]
  if (
    row?.role_name !== 'daejang_identity_provisioner' ||
    row.contract_version !== '1' ||
    row.migration_version !== '30' ||
    row.users_table !== 'web_private.users' ||
    row.user_emails_table !== 'web_private.user_emails' ||
    row.claims_table !== 'web_private.subject_name_claims' ||
    !row.claims_guard ||
    !row.web_usage ||
    !row.meta_usage ||
    row.schema_create ||
    !row.users_id_select ||
    !row.users_status_select ||
    !row.email_user_id_select ||
    !row.email_normalized_select ||
    !row.email_primary_select ||
    !row.email_login_select ||
    !row.email_verified_select ||
    !row.claim_id_select ||
    !row.claim_user_id_select ||
    !row.claim_id_insert ||
    !row.claim_user_id_insert ||
    !row.claim_name_insert ||
    !row.claim_normalized_insert ||
    !row.claim_method_insert ||
    !row.claim_assurance_insert ||
    !row.claim_verifier_insert ||
    !row.claim_verified_at_insert ||
    row.dangerous_table_write
  ) {
    throw new Error('subject-name claim provisioner migration contract is invalid')
  }
}

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
    subject_name_claims_table: string | null
    subject_name_claim_migration_version: string | null
    subject_name_claim_guard: boolean
    subject_name_claim_select: boolean
    subject_name_claim_insert: boolean
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
        ) AS auth_identity_composite_guard,
        to_regclass('web_private.subject_name_claims')::text
          AS subject_name_claims_table,
        (
          SELECT migration_version
          FROM daejang_meta.schema_contract
          WHERE component = 'web-subject-name-claim-persistence'
            AND contract_version = 1
        ) AS subject_name_claim_migration_version,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = to_regclass('web_private.subject_name_claims')
            AND tgname = 'subject_name_claims_append_only'
            AND tgenabled IN ('O', 'A')
            AND NOT tgisinternal
        ) AS subject_name_claim_guard,
        has_table_privilege(
          current_user,
          'web_private.subject_name_claims',
          'SELECT'
        ) AS subject_name_claim_select,
        has_table_privilege(
          current_user,
          'web_private.subject_name_claims',
          'INSERT'
        ) OR has_any_column_privilege(
          current_user,
          'web_private.subject_name_claims',
          'INSERT'
        ) AS subject_name_claim_insert
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
    row.auth_identity_composite_guard !== true ||
    row.subject_name_claims_table !== 'web_private.subject_name_claims' ||
    row.subject_name_claim_migration_version !== '29' ||
    row.subject_name_claim_guard !== true ||
    row.subject_name_claim_select !== true ||
    row.subject_name_claim_insert
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
    contract_version: string | null
    migration_version: string | null
    reporting_usage: boolean
    reporting_create: boolean
    report_select: boolean
    report_write: boolean
    current_select: boolean
    current_write: boolean
  }>(`
    SELECT
      to_regclass('reporting.tax_report')::text AS report_table,
      to_regclass('reporting.current_tax_report')::text AS current_table,
      (SELECT contract_version::text FROM daejang_meta.schema_contract WHERE component='tax-report-persistence') AS contract_version,
      (SELECT migration_version::text FROM daejang_meta.schema_contract WHERE component='tax-report-persistence') AS migration_version,
      has_schema_privilege(current_user, 'reporting', 'USAGE') AS reporting_usage,
      has_schema_privilege(current_user, 'reporting', 'CREATE') AS reporting_create,
      has_table_privilege(current_user, 'reporting.tax_report', 'SELECT') AS report_select,
      has_table_privilege(current_user, 'reporting.tax_report', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS report_write,
      has_table_privilege(current_user, 'reporting.current_tax_report', 'SELECT') AS current_select,
      has_table_privilege(current_user, 'reporting.current_tax_report', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS current_write
  `)
  const row = result.rows[0]
  if (
    row?.report_table !== 'reporting.tax_report' ||
    row.current_table !== 'reporting.current_tax_report' ||
    row.contract_version !== '1' ||
    row.migration_version !== '24' ||
    !row.reporting_usage ||
    row.reporting_create ||
    !row.report_select ||
    row.report_write ||
    !row.current_select ||
    row.current_write
  ) {
    throw new Error('tax report persistence migration contract is invalid')
  }
}

const reportPaymentContractDigest =
  '28f6894a953e6acc5c238b04e025662ee6bc7d3b5dbd31e783c40789b9e6dcf4'
const reportAttestationContractDigest =
  'ff6eee9232fc6a2b1845b94829e8ac26047cc3b9162a2cf9bb890d250ae85561'

export const assertReportPaymentSchema = async (pool: Pool) => {
  const result = await pool.query<{
    orders_table: string | null
    authorizations_table: string | null
    entitlements_table: string | null
    contract_version: number | null
    contract_digest: string | null
    migration_version: string | null
  }>(`
    SELECT
      to_regclass('web_private.report_payment_orders')::text AS orders_table,
      to_regclass('web_private.report_payment_authorizations')::text AS authorizations_table,
      to_regclass('web_private.report_payment_entitlements')::text AS entitlements_table,
      (SELECT version FROM web_private.schema_contracts WHERE component='report-x402-payment') AS contract_version,
      (SELECT digest FROM web_private.schema_contracts WHERE component='report-x402-payment') AS contract_digest,
      (SELECT migration_version::text FROM daejang_meta.schema_contract WHERE component='report-x402-payment-persistence' AND contract_version=1) AS migration_version
  `)
  const row = result.rows[0]
  if (
    row?.orders_table !== 'web_private.report_payment_orders' ||
    row.authorizations_table !== 'web_private.report_payment_authorizations' ||
    row.entitlements_table !== 'web_private.report_payment_entitlements' ||
    row.contract_version !== 1 ||
    row.contract_digest !== reportPaymentContractDigest ||
    row.migration_version !== '35'
  ) {
    throw new Error('report x402 payment migration contract is invalid')
  }
}

export const assertReportAttestationSchema = async (pool: Pool) => {
  const result = await pool.query<{
    records_table: string | null
    operations_table: string | null
    contract_version: number | null
    contract_digest: string | null
    migration_version: string | null
    record_guard: boolean
    operation_guard: boolean
    web_usage: boolean
    web_create: boolean
    records_select: boolean
    operations_select: boolean
    records_insert_identity: boolean
    records_update_state: boolean
    operations_insert_identity: boolean
    operations_update_state: boolean
    dangerous_write: boolean
  }>(`
    SELECT
      to_regclass('web_private.report_attestation_records')::text
        AS records_table,
      to_regclass('web_private.report_attestation_operations')::text
        AS operations_table,
      (
        SELECT version
        FROM web_private.schema_contracts
        WHERE component = 'report-attestation-persistence'
      ) AS contract_version,
      (
        SELECT digest
        FROM web_private.schema_contracts
        WHERE component = 'report-attestation-persistence'
      ) AS contract_digest,
      (
        SELECT migration_version::text
        FROM daejang_meta.schema_contract
        WHERE component = 'report-attestation-persistence'
          AND contract_version = 1
      ) AS migration_version,
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
          to_regclass('web_private.report_attestation_records')
          AND tgname =
            'report_attestation_records_validate_transition'
          AND tgenabled IN ('O', 'A')
          AND NOT tgisinternal
      ) AS record_guard,
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
          to_regclass('web_private.report_attestation_operations')
          AND tgname =
            'report_attestation_operations_validate_transition'
          AND tgenabled IN ('O', 'A')
          AND NOT tgisinternal
      ) AS operation_guard,
      has_schema_privilege(current_user, 'web_private', 'USAGE')
        AS web_usage,
      has_schema_privilege(current_user, 'web_private', 'CREATE')
        AS web_create,
      has_table_privilege(
        current_user,
        'web_private.report_attestation_records',
        'SELECT'
      ) AS records_select,
      has_table_privilege(
        current_user,
        'web_private.report_attestation_operations',
        'SELECT'
      ) AS operations_select,
      has_column_privilege(
        current_user,
        'web_private.report_attestation_records',
        'previous_submission_uid',
        'INSERT'
      ) AS records_insert_identity,
      has_column_privilege(
        current_user,
        'web_private.report_attestation_records',
        'state_version',
        'UPDATE'
      ) AS records_update_state,
      has_column_privilege(
        current_user,
        'web_private.report_attestation_operations',
        'operation_key',
        'INSERT'
      ) AS operations_insert_identity,
      has_column_privilege(
        current_user,
        'web_private.report_attestation_operations',
        'state_version',
        'UPDATE'
      ) AS operations_update_state,
      has_table_privilege(
        current_user,
        'web_private.report_attestation_records',
        'DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) OR has_table_privilege(
        current_user,
        'web_private.report_attestation_operations',
        'DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) AS dangerous_write
  `)
  const row = result.rows[0]
  if (
    row?.records_table !==
      'web_private.report_attestation_records' ||
    row.operations_table !==
      'web_private.report_attestation_operations' ||
    row.contract_version !== 1 ||
    row.contract_digest !== reportAttestationContractDigest ||
    row.migration_version !== '53' ||
    !row.record_guard ||
    !row.operation_guard ||
    !row.web_usage ||
    row.web_create ||
    !row.records_select ||
    !row.operations_select ||
    !row.records_insert_identity ||
    !row.records_update_state ||
    !row.operations_insert_identity ||
    !row.operations_update_state ||
    row.dangerous_write
  ) {
    throw new Error(
      'report attestation persistence migration contract is invalid',
    )
  }
}
