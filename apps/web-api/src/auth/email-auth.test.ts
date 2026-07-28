import { describe, expect, it } from 'vitest'

import type { EmailAuthConfig } from '../config.js'
import { MemoryAccountAuthStore } from './account-auth-store.js'
import {
  EmailAuthService,
  type EmailAuthObserver,
  type SignupCodeResponseTiming,
  type VerificationEmailSender,
} from './email-auth.js'

const config: EmailAuthConfig = {
  enabled: true,
  resendApiKey: 'test-resend-key',
  from: 'GIWA <test@example.com>',
  verificationHmacSecret: 'test-email-verification-secret',
  verificationTtlSeconds: 300,
  verificationTokenTtlSeconds: 600,
  resendAfterSeconds: 60,
}

const immediateResponseTiming: SignupCodeResponseTiming = {
  minimumDurationMilliseconds: 0,
  monotonicNow: () => 0,
  wait: async () => {},
}

class FailOnceSender implements VerificationEmailSender {
  readonly codes: string[] = []

  async sendVerificationCode(input: { code: string }) {
    this.codes.push(input.code)
    if (this.codes.length === 1) {
      throw new Error('sender unavailable')
    }
  }
}

describe('EmailAuthService', () => {
  it('returns the public acceptance response without creating or sending a code for an existing account', async () => {
    class ExistingAccountStore extends MemoryAccountAuthStore {
      challengeCreationAttempted = false

      override async findEmailCredential() {
        return {
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '기존 사용자',
            status: 'active' as const,
          },
          passwordHash: 'not-used',
        }
      }

      override async createEmailChallenge(
        ...args: Parameters<MemoryAccountAuthStore['createEmailChallenge']>
      ) {
        this.challengeCreationAttempted = true
        return super.createEmailChallenge(...args)
      }
    }

    const store = new ExistingAccountStore()
    let deliveryAttempted = false
    const waits: number[] = []
    const clockValues = [100, 250]
    const service = new EmailAuthService(
      store,
      {
        async sendVerificationCode() {
          deliveryAttempted = true
        },
      },
      config,
      () => new Date('2027-07-20T00:00:00.000Z'),
      undefined,
      {
        minimumDurationMilliseconds: 500,
        monotonicNow: () => clockValues.shift() ?? 250,
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
      },
    )

    await expect(service.sendSignupCode('user@example.com')).resolves.toEqual({
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    })
    expect(store.challengeCreationAttempted).toBe(false)
    expect(deliveryAttempted).toBe(false)
    expect(waits).toEqual([350])
  })

  it('abandons a failed delivery and permits an immediate same-clock retry', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const sender = new FailOnceSender()
    const service = new EmailAuthService(
      new MemoryAccountAuthStore(),
      sender,
      config,
      () => now,
      undefined,
      immediateResponseTiming,
    )

    await expect(service.sendSignupCode('user@example.com')).resolves.toEqual({
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    })
    await expect(service.sendSignupCode('user@example.com')).resolves.toMatchObject({
      resendAfterSeconds: 60,
    })
    expect(sender.codes).toHaveLength(2)

    await expect(
      service.verifySignupCode('user@example.com', sender.codes[0] as string),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL_VERIFICATION' })
    await expect(
      service.verifySignupCode('user@example.com', sender.codes[1] as string),
    ).resolves.toMatchObject({ verificationToken: expect.any(String) })
  })

  it('reports delivery and compensation failures without sensitive fields', async () => {
    class FailingCompensationStore extends MemoryAccountAuthStore {
      override async abandonEmailChallenge(): Promise<boolean> {
        throw new Error('store unavailable')
      }
    }

    let compensationObserved:
      | Parameters<EmailAuthObserver['challengeAbandonFailed']>[0]
      | undefined
    let deliveryObserved:
      | Parameters<EmailAuthObserver['verificationDeliveryFailed']>[0]
      | undefined
    const service = new EmailAuthService(
      new FailingCompensationStore(),
      {
        async sendVerificationCode() {
          throw new Error('sender unavailable')
        },
      },
      config,
      () => new Date('2027-07-20T00:00:00.000Z'),
      {
        challengeAbandonFailed(input) {
          compensationObserved = input
        },
        verificationDeliveryFailed(input) {
          deliveryObserved = input
        },
      },
      immediateResponseTiming,
    )

    await expect(service.sendSignupCode('private@example.com')).resolves.toEqual({
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    })
    expect(compensationObserved).toMatchObject({
      challengeId: expect.any(String),
      error: expect.any(Error),
    })
    expect(deliveryObserved).toMatchObject({
      challengeId: expect.any(String),
      error: expect.any(Error),
    })
    expect(Object.keys(compensationObserved ?? {}).sort()).toEqual([
      'challengeId',
      'error',
    ])
    expect(Object.keys(deliveryObserved ?? {}).sort()).toEqual([
      'challengeId',
      'error',
    ])
  })
})
