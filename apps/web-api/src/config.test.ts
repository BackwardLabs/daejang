import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { loadConfig } from './config.js'

describe('web api configuration', () => {
  it('documents every setting needed to activate signup and email authentication', () => {
    const example = readFileSync(
      new URL('../.env.example', import.meta.url),
      'utf8',
    )
    const documentedKeys = new Set(
      example
        .split(/\r?\n/u)
        .map((line) => /^([A-Z0-9_]+)=/u.exec(line)?.[1])
        .filter((key): key is string => key !== undefined),
    )

    expect([...documentedKeys]).toEqual(
      expect.arrayContaining([
        'SIGNUP_SESSION_TTL_SECONDS',
        'SIGNUP_ENABLED',
        'EMAIL_AUTH_ENABLED',
        'RESEND_API_KEY',
        'EMAIL_FROM',
        'EMAIL_VERIFICATION_HMAC_SECRET',
        'EMAIL_VERIFICATION_TTL_SECONDS',
        'EMAIL_VERIFICATION_TOKEN_TTL_SECONDS',
        'EMAIL_VERIFICATION_RESEND_AFTER_SECONDS',
        'IDENTITY_VERIFICATION_MODE',
        'UPBIT_PDF_IMPORT_ENABLED',
        'REPORTS_UI_MODE',
        'ENV_RPC_URL_ETHEREUM_MAINNET',
        'ENV_RPC_URL_OPTIMISM_MAINNET',
        'X402_REPORT_PAYMENTS_ENABLED',
        'X402_FACILITATOR_URL',
        'X402_ASSET_ADDRESS',
        'X402_PAY_TO_ADDRESS',
        'X402_AMOUNT_ATOMIC',
        'X402_MAX_TIMEOUT_SECONDS',
        'X402_TOKEN_NAME',
        'X402_TOKEN_VERSION',
        'GIWA_REPORT_ATTESTATIONS_ENABLED',
        'GIWA_REPORT_RPC_URL',
        'GIWA_REPORT_EAS_ADDRESS',
        'GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS',
        'GIWA_REPORT_REGISTRY_PROXY_ADDRESS',
        'GIWA_REPORT_CONSUMER_ADDRESS',
        'GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS',
        'GIWA_REPORT_SCHEMA_UID',
        'GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST',
        'GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED',
        'GIWA_REPORT_IDENTITY_HMAC_KEY',
        'GIWA_REPORT_ISSUER_ADDRESS',
        'GIWA_REPORT_ISSUER_KEYSTORE_PATH',
        'GIWA_REPORT_ISSUER_PASSWORD_FILE',
        'GIWA_REPORT_REVIEWER_ADDRESS',
        'GIWA_REPORT_REVIEWER_KEYSTORE_PATH',
        'GIWA_REPORT_REVIEWER_PASSWORD_FILE',
        'GIWA_REPORT_MIN_CONFIRMATIONS',
        'GIWA_REPORT_DAILY_USER_WRITE_LIMIT',
        'GIWA_REPORT_DAILY_IP_WRITE_LIMIT',
        'GIWA_REPORT_DAILY_GLOBAL_WRITE_LIMIT',
        'PRIVATE_OBJECT_ENCRYPTION_KEY',
        'PRIVATE_OBJECT_ENCRYPTION_KEY_ID',
        'PRIVATE_OBJECT_LEGACY_KEY_ID',
        'PRIVATE_OBJECT_DECRYPTION_KEYS',
        'ENGINE_ALLOW_INSECURE_LOOPBACK',
      ]),
    )
  })

  it('loads the two wallet signature verification RPC URLs', () => {
    expect(loadConfig({
      ENV_RPC_URL_ETHEREUM_MAINNET: 'https://eth-mainnet.g.alchemy.com/v2/test',
      ENV_RPC_URL_OPTIMISM_MAINNET: 'https://opt-mainnet.g.alchemy.com/v2/test',
    }).walletSignatureRpcUrls).toEqual(new Map([
      ['eip155:1', 'https://eth-mainnet.g.alchemy.com/v2/test'],
      ['eip155:10', 'https://opt-mainnet.g.alchemy.com/v2/test'],
    ]))
  })

  it('uses the product report surface by default and rejects unknown modes', () => {
    expect(loadConfig().reportsUiMode).toBe('product')
    expect(
      loadConfig({ REPORTS_UI_MODE: 'giwa28-demo' }).reportsUiMode,
    ).toBe('giwa28-demo')
    expect(() => loadConfig({ REPORTS_UI_MODE: 'demo' })).toThrow(
      'REPORTS_UI_MODE must be product or giwa28-demo',
    )
  })

  it('loads GIWA Sepolia report payment terms only when explicitly enabled', () => {
    expect(loadConfig().reportPayments).toBeUndefined()

    expect(loadConfig({
      X402_REPORT_PAYMENTS_ENABLED: 'true',
      X402_FACILITATOR_URL: 'http://localhost:4021',
      X402_ASSET_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_PAY_TO_ADDRESS: '0x2222222222222222222222222222222222222222',
      X402_AMOUNT_ATOMIC: '100000',
    }).reportPayments).toMatchObject({
      network: 'eip155:91342',
      amount: '100000',
      maxTimeoutSeconds: 300,
      tokenName: 'Mock USD',
    })

    expect(() => loadConfig({
      X402_REPORT_PAYMENTS_ENABLED: 'true',
      X402_FACILITATOR_URL: 'https://facilitator.example.com',
    })).toThrow('are required')
  })

  it('loads the GIWA report attestation deployment only as one complete binding', () => {
    expect(loadConfig().reportAttestationDeployment).toBeUndefined()

    const environment = {
      GIWA_REPORT_ATTESTATIONS_ENABLED: 'true',
      GIWA_REPORT_RPC_URL: 'https://sepolia-rpc.giwa.io',
      GIWA_REPORT_EAS_ADDRESS:
        '0x4200000000000000000000000000000000000021',
      GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS:
        '0x4200000000000000000000000000000000000020',
      GIWA_REPORT_REGISTRY_PROXY_ADDRESS:
        '0x1111111111111111111111111111111111111111',
      GIWA_REPORT_CONSUMER_ADDRESS:
        '0x2222222222222222222222222222222222222222',
      GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS:
        '0x3333333333333333333333333333333333333333',
      GIWA_REPORT_SCHEMA_UID: `0x${'a'.repeat(64)}`,
      GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST: `0x${'b'.repeat(64)}`,
    }

    expect(loadConfig(environment).reportAttestationDeployment).toEqual({
      network: 'eip155:91342',
      rpcUrl: 'https://sepolia-rpc.giwa.io',
      easAddress: '0x4200000000000000000000000000000000000021',
      schemaRegistryAddress:
        '0x4200000000000000000000000000000000000020',
      reportRegistryProxyAddress:
        '0x1111111111111111111111111111111111111111',
      reportConsumerAddress:
        '0x2222222222222222222222222222222222222222',
      governanceSafeAddress:
        '0x3333333333333333333333333333333333333333',
      schemaUID: `0x${'a'.repeat(64)}`,
      evidenceSchemaDigest: `0x${'b'.repeat(64)}`,
    })

    expect(() =>
      loadConfig({
        ...environment,
        GIWA_REPORT_CONSUMER_ADDRESS: undefined,
      }),
    ).toThrow('GIWA_REPORT_CONSUMER_ADDRESS')
    expect(() =>
      loadConfig({
        GIWA_REPORT_ATTESTATIONS_ENABLED: 'false',
        GIWA_REPORT_RPC_URL: environment.GIWA_REPORT_RPC_URL,
      }),
    ).toThrow('require GIWA_REPORT_ATTESTATIONS_ENABLED=true')
  })

  it('rejects a wrong network binding or zero deployment identifier', () => {
    const environment = {
      GIWA_REPORT_ATTESTATIONS_ENABLED: 'true',
      GIWA_REPORT_RPC_URL: 'https://sepolia-rpc.giwa.io',
      GIWA_REPORT_EAS_ADDRESS:
        '0x4200000000000000000000000000000000000021',
      GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS:
        '0x4200000000000000000000000000000000000020',
      GIWA_REPORT_REGISTRY_PROXY_ADDRESS:
        '0x1111111111111111111111111111111111111111',
      GIWA_REPORT_CONSUMER_ADDRESS:
        '0x2222222222222222222222222222222222222222',
      GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS:
        '0x3333333333333333333333333333333333333333',
      GIWA_REPORT_SCHEMA_UID: `0x${'a'.repeat(64)}`,
      GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST: `0x${'b'.repeat(64)}`,
    }

    expect(() =>
      loadConfig({
        ...environment,
        GIWA_REPORT_EAS_ADDRESS:
          '0x3333333333333333333333333333333333333333',
      }),
    ).toThrow('pinned GIWA Sepolia')
    expect(() =>
      loadConfig({
        ...environment,
        GIWA_REPORT_SCHEMA_UID: `0x${'0'.repeat(64)}`,
      }),
    ).toThrow('nonzero bytes32')
    expect(() =>
      loadConfig({
        ...environment,
        GIWA_REPORT_CONSUMER_ADDRESS:
          environment.GIWA_REPORT_REGISTRY_PROXY_ADDRESS,
      }),
    ).toThrow('must be distinct')
  })

  it('loads the synthetic GIWA writer only with complete server-side secrets', () => {
    const deployment = {
      GIWA_REPORT_ATTESTATIONS_ENABLED: 'true',
      GIWA_REPORT_RPC_URL: 'https://sepolia-rpc.giwa.io',
      GIWA_REPORT_EAS_ADDRESS:
        '0x4200000000000000000000000000000000000021',
      GIWA_REPORT_SCHEMA_REGISTRY_ADDRESS:
        '0x4200000000000000000000000000000000000020',
      GIWA_REPORT_REGISTRY_PROXY_ADDRESS:
        '0x1111111111111111111111111111111111111111',
      GIWA_REPORT_CONSUMER_ADDRESS:
        '0x2222222222222222222222222222222222222222',
      GIWA_REPORT_GOVERNANCE_SAFE_ADDRESS:
        '0x3333333333333333333333333333333333333333',
      GIWA_REPORT_SCHEMA_UID: `0x${'a'.repeat(64)}`,
      GIWA_REPORT_EVIDENCE_SCHEMA_DIGEST: `0x${'b'.repeat(64)}`,
    }
    const writer = {
      GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED: 'true',
      GIWA_REPORT_IDENTITY_HMAC_KEY:
        Buffer.alloc(32, 28).toString('base64'),
      GIWA_REPORT_ISSUER_ADDRESS:
        '0x4444444444444444444444444444444444444444',
      GIWA_REPORT_ISSUER_KEYSTORE_PATH: '/run/secrets/issuer.json',
      GIWA_REPORT_ISSUER_PASSWORD_FILE:
        '/run/secrets/issuer.password',
      GIWA_REPORT_REVIEWER_ADDRESS:
        '0x5555555555555555555555555555555555555555',
      GIWA_REPORT_REVIEWER_KEYSTORE_PATH:
        '/run/secrets/reviewer.json',
      GIWA_REPORT_REVIEWER_PASSWORD_FILE:
        '/run/secrets/reviewer.password',
    }
    expect(
      loadConfig({
        ...deployment,
        ...writer,
      }).reportAttestationSyntheticTestnet,
    ).toMatchObject({
      issuerAddress:
        '0x4444444444444444444444444444444444444444',
      issuerKeystorePath: '/run/secrets/issuer.json',
      reviewerAddress:
        '0x5555555555555555555555555555555555555555',
      reviewerKeystorePath: '/run/secrets/reviewer.json',
      minimumConfirmations: 1,
      dailyWriteLimits: {
        user: 4,
        ip: 20,
        global: 100,
      },
      reviewOutcome: 'APPROVE',
    })
    expect(() =>
      loadConfig({
        ...writer,
        GIWA_REPORT_ATTESTATIONS_ENABLED: 'false',
      }),
    ).toThrow('requires GIWA report attestation deployment')
    expect(() =>
      loadConfig({
        ...deployment,
        ...writer,
        GIWA_REPORT_IDENTITY_HMAC_KEY: 'not-a-key',
      }),
    ).toThrow('base64-encoded 32-byte key')
    expect(() =>
      loadConfig({
        ...deployment,
        ...writer,
        GIWA_REPORT_REVIEWER_KEYSTORE_PATH:
          writer.GIWA_REPORT_ISSUER_KEYSTORE_PATH,
      }),
    ).toThrow('must be distinct')
    expect(() =>
      loadConfig({
        ...deployment,
        ...writer,
        GIWA_REPORT_REVIEWER_ADDRESS:
          writer.GIWA_REPORT_ISSUER_ADDRESS,
      }),
    ).toThrow('addresses must be distinct')
    expect(() =>
      loadConfig({
        GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED: 'false',
        GIWA_REPORT_ISSUER_KEYSTORE_PATH:
          writer.GIWA_REPORT_ISSUER_KEYSTORE_PATH,
      }),
    ).toThrow('require GIWA_REPORT_SYNTHETIC_TESTNET_ENABLED=true')
  })

  it('uses a host-only secure cookie name in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      DATABASE_URL: 'postgresql://example.invalid/daejang',
      PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      ENGINE_GRPC_TARGET: 'jit-engine.internal:8443',
      ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
      ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
      ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
    })

    expect(config.sessionCookieName).toBe('__Host-daejang_session')
    expect(config.secureCookies).toBe(true)
    expect(config.runtimeMode).toBe('production')
  })

  it('rejects public origins containing a path', () => {
    expect(() =>
      loadConfig({ PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io/app' }),
    ).toThrow('PUBLIC_ORIGIN')
  })

  it('requires an explicit public origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('PUBLIC_ORIGIN')
  })

  it('requires an HTTPS public origin in production but allows HTTP localhost in development', () => {
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:5173' }).publicOrigin).toBe(
      'http://localhost:5173',
    )
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://daejang.backwardlabs.io',
      }),
    ).toThrow('https')
  })

  it('validates enabled OAuth providers and their independent encryption key', () => {
    expect(() =>
      loadConfig({ OAUTH_ENABLED_PROVIDERS: 'github' }),
    ).toThrow('unsupported provider')
    expect(() =>
      loadConfig({
        OAUTH_ENABLED_PROVIDERS: 'naver',
        NAVER_CLIENT_ID: 'client-id',
      }),
    ).toThrow('NAVER_CLIENT_SECRET')
    expect(() =>
      loadConfig({
        OAUTH_ENABLED_PROVIDERS: 'naver',
        NAVER_CLIENT_ID: 'client-id',
        NAVER_CLIENT_SECRET: 'client-secret',
        OAUTH_TRANSACTION_ENCRYPTION_KEY: 'not-a-32-byte-key',
      }),
    ).toThrow('base64-encoded 32-byte key')
  })

  it('requires durable PostgreSQL, rate-limit, and an Engine transport in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      }),
    ).toThrow('DATABASE_URL')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'short',
      }),
    ).toThrow('RATE_LIMIT_HMAC_SECRET')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      }),
    ).toThrow('ENGINE_GRPC_TARGET')
  })

  it('rejects an HTTP URL as an Engine gRPC target', () => {
    expect(() =>
      loadConfig({
        ENGINE_GRPC_TARGET: 'https://jit-engine.internal:8443',
        ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
        ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
        ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
      }),
    ).toThrow('gRPC authority')
  })

  it('allows plaintext Engine transport only on loopback', () => {
    expect(
      loadConfig({
        NODE_ENV: 'development',
        ENGINE_GRPC_INSECURE_TARGET: '127.0.0.1:50051',
      }).engineInsecureTarget,
    ).toBe('127.0.0.1:50051')

    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        ENGINE_GRPC_INSECURE_TARGET: 'engine.internal:50051',
      }),
    ).toThrow('loopback')
  })

  it('keeps Upbit PDF import default-off and requires encrypted production storage', () => {
    expect(loadConfig().upbitPdfImportEnabled).toBe(false)
    expect(
      loadConfig({
        NODE_ENV: 'development',
        UPBIT_PDF_IMPORT_ENABLED: 'true',
      }).upbitPdfImportEnabled,
    ).toBe(true)
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        UPBIT_PDF_IMPORT_ENABLED: 'true',
      }),
    ).toThrow('PRIVATE_OBJECT_ENCRYPTION_KEY')

    const key = Buffer.alloc(32, 7).toString('base64')
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      DATABASE_URL: 'postgresql://example.invalid/daejang',
      PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
      PRIVATE_OBJECT_ENCRYPTION_KEY: key,
      PRIVATE_OBJECT_ENCRYPTION_KEY_ID: 'primary',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      UPBIT_PDF_IMPORT_ENABLED: 'true',
      ENGINE_GRPC_TARGET: 'engine.internal:50051',
      ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
      ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
      ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
    })
    expect(config.upbitPdfImportEnabled).toBe(true)
    expect(config.privateObjectEncryptionKey).toEqual(Buffer.alloc(32, 7))
    expect(config.privateObjectEncryptionKeyId).toBe('primary')
  })

  it('allows a protected Unix socket but rejects plaintext TCP in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ENGINE_GRPC_INSECURE_TARGET: '127.0.0.1:50051',
      }),
    ).toThrow('plaintext TCP Engine transport is not allowed in production')

    expect(loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      DATABASE_URL: 'postgresql://example.invalid/daejang',
      PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      ENGINE_GRPC_INSECURE_TARGET: 'unix:/run/giwa/engine.sock',
    }).engineInsecureTarget).toBe('unix:/run/giwa/engine.sock')
  })

  it('rejects idle timeouts longer than the absolute timeout', () => {
    expect(() =>
      loadConfig({
        SESSION_ABSOLUTE_TTL_SECONDS: '60',
        SESSION_IDLE_TTL_SECONDS: '61',
      }),
    ).toThrow('must not exceed')
  })

  it('rejects unknown runtime modes', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow('NODE_ENV')
  })

  it('rejects mock identity verification in every runtime mode', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        IDENTITY_VERIFICATION_MODE: 'mock',
      }),
    ).toThrow('must be disabled')
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
        IDENTITY_VERIFICATION_MODE: 'mock',
      }),
    ).toThrow('must be disabled')
  })

  it('enables identity-disabled signup only with an explicit method', () => {
    const enabled = loadConfig({
      SIGNUP_ENABLED: 'true',
      EMAIL_AUTH_ENABLED: 'true',
      RESEND_API_KEY: 'test-resend-key',
      EMAIL_FROM: 'GIWA <test@example.com>',
      IDENTITY_VERIFICATION_MODE: 'disabled',
    })
    expect(enabled.signup).toEqual({
      enabled: true,
      identityVerificationRequired: false,
      methods: { email: true, oauthProviders: [] },
    })

    expect(loadConfig().signup).toEqual({
      enabled: false,
      identityVerificationRequired: false,
      methods: { email: false, oauthProviders: [] },
    })
    expect(() =>
      loadConfig({
        SIGNUP_ENABLED: 'true',
      }),
    ).toThrow('at least one configured signup method')
    expect(
      loadConfig({
        SIGNUP_ENABLED: 'true',
        EMAIL_AUTH_ENABLED: 'true',
        RESEND_API_KEY: 'test-resend-key',
        EMAIL_FROM: 'GIWA <test@example.com>',
        IDENTITY_VERIFICATION_MODE: 'disabled',
      }),
    ).toMatchObject({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: [] },
      },
    })
  })

  it('allows explicit production signup without an external identity provider', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
        ENGINE_GRPC_TARGET: 'jit-engine.internal:8443',
        ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
        ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
        ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
        SIGNUP_ENABLED: 'true',
        EMAIL_AUTH_ENABLED: 'true',
        RESEND_API_KEY: 'test-resend-key',
        EMAIL_FROM: 'GIWA <test@example.com>',
        IDENTITY_VERIFICATION_MODE: 'disabled',
      }),
    ).toMatchObject({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: [] },
      },
    })
  })
})
