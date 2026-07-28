import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

import { argon2id, hash, verify } from 'argon2'
import { Resend } from 'resend'

import type { EmailAuthConfig } from '../config.js'
import {
  accountAlreadyExists,
  emailDeliveryFailed,
  invalidCredentials,
  invalidEmailVerification,
  invalidPassword,
} from '../errors.js'
import type {
  AccountAuthStore,
  AccountUser,
  EmailChallengePurpose,
} from './account-auth-store.js'

export interface VerificationEmailSender {
  sendVerificationCode(input: {
    to: string
    code: string
    expiresInMinutes: number
  }): Promise<void>
}

export interface EmailAuthObserver {
  challengeAbandonFailed(input: {
    challengeId: string
    error: unknown
  }): void
}

const silentEmailAuthObserver: EmailAuthObserver = {
  challengeAbandonFailed: () => {},
}

export class ResendVerificationEmailSender
  implements VerificationEmailSender
{
  readonly #client: Resend

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.#client = new Resend(apiKey)
  }

  async sendVerificationCode(input: {
    to: string
    code: string
    expiresInMinutes: number
  }) {
    const result = await this.#client.emails.send({
      from: this.from,
      to: input.to,
      subject: '[GIWA] 이메일 인증번호',
      text: [
        `GIWA 이메일 인증번호는 ${input.code}입니다.`,
        `인증번호는 ${input.expiresInMinutes}분 동안 유효합니다.`,
        '직접 요청하지 않았다면 이 메일을 무시해 주세요.',
      ].join('\n'),
    })
    if (result.error) {
      throw emailDeliveryFailed()
    }
  }
}

export class DisabledVerificationEmailSender
  implements VerificationEmailSender
{
  async sendVerificationCode() {
    throw emailDeliveryFailed()
  }
}

const containsUnsafeEmailCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return /\s/u.test(character) || codePoint < 32 || codePoint === 127
  })

export const normalizeEmail = (value: string) => {
  const normalized = value.trim().toLocaleLowerCase('en-US')
  const parts = normalized.split('@')
  if (
    normalized.length > 320 ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1]?.includes('.') ||
    containsUnsafeEmailCharacter(normalized)
  ) {
    throw invalidEmailVerification()
  }
  return normalized
}

export const validatePassword = (password: string) => {
  if (
    password.length < 8 ||
    password.length > 128 ||
    !/[A-Za-z]/u.test(password) ||
    !/[0-9]/u.test(password) ||
    !/[!-/:-@[-`{-~]/u.test(password)
  ) {
    throw invalidPassword()
  }
}

type VerificationTokenPayload = {
  challengeId: string
  email: string
  purpose: EmailChallengePurpose
  expiresAt: number
}

const encodePayload = (payload: VerificationTokenPayload) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

const signature = (secret: string, encodedPayload: string) =>
  createHmac('sha256', secret).update(encodedPayload).digest('base64url')

const digestCode = (
  secret: string,
  challengeId: string,
  email: string,
  code: string,
) =>
  createHmac('sha256', secret)
    .update(`${challengeId}\0${email}\0${code}`)
    .digest('base64url')

const parseVerificationToken = (
  token: string,
  secret: string,
  now: Date,
): VerificationTokenPayload => {
  const [encodedPayload, suppliedSignature, extra] = token.split('.')
  if (!encodedPayload || !suppliedSignature || extra !== undefined) {
    throw invalidEmailVerification()
  }
  const expected = signature(secret, encodedPayload)
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const suppliedBuffer = Buffer.from(suppliedSignature, 'utf8')
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    throw invalidEmailVerification()
  }
  let payload: unknown
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    )
  } catch {
    throw invalidEmailVerification()
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('challengeId' in payload) ||
    typeof payload.challengeId !== 'string' ||
    !('email' in payload) ||
    typeof payload.email !== 'string' ||
    !('purpose' in payload) ||
    !['signup', 'verify_email', 'password_reset'].includes(
      String(payload.purpose),
    ) ||
    !('expiresAt' in payload) ||
    typeof payload.expiresAt !== 'number' ||
    payload.expiresAt <= now.getTime()
  ) {
    throw invalidEmailVerification()
  }
  return payload as VerificationTokenPayload
}

export class EmailAuthService {
  readonly #dummyPasswordHash: Promise<string>

  constructor(
    private readonly store: AccountAuthStore,
    private readonly sender: VerificationEmailSender,
    private readonly config: EmailAuthConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly observer: EmailAuthObserver = silentEmailAuthObserver,
  ) {
    this.#dummyPasswordHash = hash(
      'GIWA-dummy-password-for-timing-only-1!',
      {
        type: argon2id,
      },
    )
  }

  async sendSignupCode(rawEmail: string) {
    const email = normalizeEmail(rawEmail)
    const now = this.now()
    const latest = await this.store.getEligibleEmailChallenge(
      email,
      'signup',
      now,
    )
    if (latest && latest.resendAfter.getTime() > now.getTime()) {
      return {
        expiresInSeconds: Math.max(
          1,
          Math.ceil((latest.expiresAt.getTime() - now.getTime()) / 1_000),
        ),
        resendAfterSeconds: Math.max(
          1,
          Math.ceil((latest.resendAfter.getTime() - now.getTime()) / 1_000),
        ),
      }
    }

    const pending = await this.store.findOrCreatePendingDirectEmail(email)
    if (pending.loginEnabled) {
      return {
        expiresInSeconds: this.config.verificationTtlSeconds,
        resendAfterSeconds: this.config.resendAfterSeconds,
      }
    }
    const challengeId = randomUUID()
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    const expiresAt = new Date(
      now.getTime() + this.config.verificationTtlSeconds * 1_000,
    )
    const resendAfter = new Date(
      now.getTime() + this.config.resendAfterSeconds * 1_000,
    )
    await this.store.createEmailChallenge({
      id: challengeId,
      userEmailId: pending.userEmailId,
      email,
      purpose: 'signup',
      codeDigest: digestCode(
        this.config.verificationHmacSecret,
        challengeId,
        email,
        code,
      ),
      createdAt: now,
      expiresAt,
      resendAfter,
      attempts: 0,
      maxAttempts: 5,
      consumedAt: undefined,
    })
    try {
      await this.sender.sendVerificationCode({
        to: email,
        code,
        expiresInMinutes: Math.ceil(this.config.verificationTtlSeconds / 60),
      })
    } catch {
      try {
        const abandoned = await this.store.abandonEmailChallenge({
          challengeId,
          now,
        })
        if (!abandoned) {
          throw new Error('Email challenge could not be abandoned')
        }
      } catch (error) {
        this.observer.challengeAbandonFailed({ challengeId, error })
      }
      throw emailDeliveryFailed()
    }
    return {
      expiresInSeconds: this.config.verificationTtlSeconds,
      resendAfterSeconds: this.config.resendAfterSeconds,
    }
  }

  async verifySignupCode(rawEmail: string, code: string) {
    const email = normalizeEmail(rawEmail)
    if (!/^[0-9]{6}$/u.test(code)) {
      throw invalidEmailVerification()
    }
    const now = this.now()
    const latest = await this.store.getEligibleEmailChallenge(
      email,
      'signup',
      now,
    )
    if (!latest) {
      throw invalidEmailVerification()
    }
    const verified = await this.store.verifyEmailChallenge({
      email,
      purpose: 'signup',
      codeDigest: digestCode(
        this.config.verificationHmacSecret,
        latest.id,
        email,
        code,
      ),
      now,
    })
    if (!verified?.consumedAt) {
      throw invalidEmailVerification()
    }
    const expiresAt =
      now.getTime() + this.config.verificationTokenTtlSeconds * 1_000
    const encodedPayload = encodePayload({
      challengeId: verified.id,
      email,
      purpose: 'signup',
      expiresAt,
    })
    return {
      verificationToken: `${encodedPayload}.${signature(
        this.config.verificationHmacSecret,
        encodedPayload,
      )}`,
      expiresInSeconds: this.config.verificationTokenTtlSeconds,
    }
  }

  async signup(input: {
    rawEmail: string
    password: string
    passwordConfirmation: string
    verificationToken: string
  }) {
    if (input.password !== input.passwordConfirmation) {
      throw invalidPassword()
    }
    validatePassword(input.password)
    const email = normalizeEmail(input.rawEmail)
    const payload = parseVerificationToken(
      input.verificationToken,
      this.config.verificationHmacSecret,
      this.now(),
    )
    if (payload.email !== email || payload.purpose !== 'signup') {
      throw invalidEmailVerification()
    }
    const challenge = await this.store.getConsumedEmailChallenge(
      payload.challengeId,
      email,
      'signup',
    )
    if (!challenge) {
      throw invalidEmailVerification()
    }
    const existing = await this.store.findEmailCredential(email)
    if (existing) {
      throw accountAlreadyExists()
    }
    const passwordHash = await hash(input.password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    })
    return this.store.createEmailCredential({
      challengeId: challenge.id,
      email,
      passwordHash,
      now: this.now(),
    })
  }

  async authenticate(rawEmail: string, password: string): Promise<AccountUser> {
    const email = normalizeEmail(rawEmail)
    const credential = await this.store.findEmailCredential(email)
    const passwordHash = credential?.passwordHash ?? (await this.#dummyPasswordHash)
    let valid = false
    try {
      valid = await verify(passwordHash, password)
    } catch {
      valid = false
    }
    if (!credential || !valid) {
      throw invalidCredentials()
    }
    return credential.user
  }
}
