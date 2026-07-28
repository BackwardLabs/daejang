import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { assertReportPaymentSchema, assertTaxReportSchema, assertWebAuthSchema } from './preflight.js'

const validWebAuthContract = {
  users_table: 'web_private.users',
  identities_table: 'web_private.auth_identities',
  sessions_table: 'web_private.sessions',
  legal_documents_table: 'web_private.legal_documents',
  user_consents_table: 'web_private.user_consents',
  rate_limit_table: 'web_private.auth_rate_limit_buckets',
  contract_version: 1,
  contract_digest:
    'a70f036a58e79b949d9e07878bd5d9e8643e6579732e652c4ea11716fc0ff9ad',
  migration_version: '11',
  legal_documents_guard: true,
  legal_document_contents_table: 'web_private.legal_document_contents',
  legal_document_contents_hash_guard: true,
  legal_document_contents_guard: true,
  user_consents_guard: true,
  signup_sessions_table: 'web_private.signup_sessions',
  oauth_transactions_table: 'web_private.oauth_transactions',
  user_emails_table: 'web_private.user_emails',
  email_credentials_table: 'web_private.email_credentials',
  email_challenges_table: 'web_private.email_verification_challenges',
  oauth_email_contract_version: 1,
  oauth_email_contract_digest:
    '19cb27f0bdae2d9d42419ae05b3253ecfee2aeaeddf8317bfe95073f6dfa97c1',
  oauth_email_migration_version: '15',
  oauth_consume_function: 'web_private.consume_oauth_transaction(text)',
  user_email_source_guard: true,
  email_credential_source_guard: true,
  auth_identity_composite_guard: true,
  wallet_challenges_table: 'web_private.wallet_ownership_challenges',
  upload_sessions_table: 'web_private.upload_sessions',
}

const validTaxReportContract = {
  report_table: 'reporting.tax_report',
  current_table: 'reporting.current_tax_report',
  inventory_table: 'tax.inventory_run',
  estimate_table: 'tax.estimate',
  contract_version: '1',
  migration_version: '24',
}

const validReportPaymentContract = {
  orders_table: 'web_private.report_payment_orders',
  authorizations_table: 'web_private.report_payment_authorizations',
  entitlements_table: 'web_private.report_payment_entitlements',
  contract_version: 1,
  contract_digest: '28f6894a953e6acc5c238b04e025662ee6bc7d3b5dbd31e783c40789b9e6dcf4',
  migration_version: '25',
}

function poolReturning<T>(row: T): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [row] }),
  } as unknown as Pool
}

describe('web authentication schema preflight', () => {
  it('accepts the canonical Web Auth contract at migration 11', async () => {
    await expect(
      assertWebAuthSchema(poolReturning(validWebAuthContract)),
    ).resolves.toBeUndefined()
  })

  it('rejects the superseded baseline-only migration number', async () => {
    await expect(
      assertWebAuthSchema(
        poolReturning({
          ...validWebAuthContract,
          migration_version: '8',
        }),
      ),
    ).rejects.toThrow('web_private authentication migration contract is invalid')
  })
})

describe('tax report schema preflight', () => {
  it('accepts the canonical tax report persistence contract at migration 24', async () => {
    await expect(
      assertTaxReportSchema(poolReturning(validTaxReportContract)),
    ).resolves.toBeUndefined()
  })

  it('rejects the superseded pre-merge migration number', async () => {
    await expect(
      assertTaxReportSchema(
        poolReturning({
          ...validTaxReportContract,
          migration_version: '19',
        }),
      ),
    ).rejects.toThrow('tax report persistence migration contract is invalid')
  })
})

describe('report payment schema preflight', () => {
  it('accepts the durable order, replay and entitlement contract', async () => {
    await expect(
      assertReportPaymentSchema(poolReturning(validReportPaymentContract)),
    ).resolves.toBeUndefined()
  })

  it('rejects a deployment without the nonce replay table', async () => {
    await expect(
      assertReportPaymentSchema(poolReturning({
        ...validReportPaymentContract,
        authorizations_table: null,
      })),
    ).rejects.toThrow('report x402 payment migration contract is invalid')
  })
})
