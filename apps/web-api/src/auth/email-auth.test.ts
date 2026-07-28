import { describe, expect, it } from 'vitest'

import type { EmailAuthConfig } from '../config.js'
import { MemoryAccountAuthStore } from './account-auth-store.js'
import {
  EmailAuthService,
  type EmailAuthObserver,
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
  it('abandons a failed delivery and permits an immediate same-clock retry', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const sender = new FailOnceSender()
    const service = new EmailAuthService(
      new MemoryAccountAuthStore(),
      sender,
      config,
      () => now,
    )

    await expect(service.sendSignupCode('user@example.com')).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
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

  it('preserves the delivery error and reports compensation failure without sensitive fields', async () => {
    class FailingCompensationStore extends MemoryAccountAuthStore {
      override async abandonEmailChallenge(): Promise<boolean> {
        throw new Error('store unavailable')
      }
    }

    let observed: Parameters<EmailAuthObserver['challengeAbandonFailed']>[0] | undefined
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
          observed = input
        },
      },
    )

    await expect(service.sendSignupCode('private@example.com')).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
    })
    expect(observed).toMatchObject({
      challengeId: expect.any(String),
      error: expect.any(Error),
    })
    expect(Object.keys(observed ?? {}).sort()).toEqual(['challengeId', 'error'])
  })
})
