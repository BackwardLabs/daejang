import { describe, expect, it } from 'vitest'

import { MemorySessionStore, SessionService } from './session.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002'
const PREVIOUS_USER_ID = '00000000-0000-4000-8000-000000000003'

const newSession = (userId = USER_ID) => ({
  user: { id: userId, displayName: '김대장' },
})

describe('SessionService', () => {
  it('creates a 32-byte opaque token with server-controlled expiry', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const service = new SessionService(new MemorySessionStore(), 100, 20, () => now)

    const { token, session } = await service.create(newSession())

    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(session.createdAt).toEqual(now)
    expect(session.lastSeenAt).toEqual(now)
    expect(session.absoluteExpiresAt.getTime()).toBe(now.getTime() + 100_000)
    expect(session.idleExpiresAt.getTime()).toBe(now.getTime() + 20_000)
  })

  it('touches idle expiry without extending absolute expiry', async () => {
    let now = new Date('2027-07-20T00:00:00.000Z')
    const service = new SessionService(new MemorySessionStore(), 100, 20, () => now)
    const { token, session: created } = await service.create(newSession())

    now = new Date(now.getTime() + 15_000)
    const touched = await service.resolve(token)

    expect(touched?.lastSeenAt).toEqual(now)
    expect(touched?.idleExpiresAt.getTime()).toBe(now.getTime() + 20_000)
    expect(touched?.absoluteExpiresAt).toEqual(created.absoluteExpiresAt)
  })

  it('rejects a session at the exact idle-expiry boundary', async () => {
    let now = new Date('2027-07-20T00:00:00.000Z')
    const service = new SessionService(new MemorySessionStore(), 100, 20, () => now)
    const { token } = await service.create(newSession())

    now = new Date(now.getTime() + 20_000)
    expect(await service.resolve(token)).toBeUndefined()
    expect(await service.resolve(token)).toBeUndefined()
  })

  it('never extends a session past its absolute expiry', async () => {
    let now = new Date('2027-07-20T00:00:00.000Z')
    const service = new SessionService(new MemorySessionStore(), 30, 20, () => now)
    const { token, session } = await service.create(newSession())

    now = new Date(now.getTime() + 15_000)
    const touched = await service.resolve(token)
    expect(touched?.idleExpiresAt).toEqual(session.absoluteExpiresAt)

    now = session.absoluteExpiresAt
    expect(await service.resolve(token)).toBeUndefined()
  })

  it('rotates a token while preserving its absolute lifetime', async () => {
    let now = new Date('2027-07-20T00:00:00.000Z')
    const service = new SessionService(new MemorySessionStore(), 100, 20, () => now)
    const created = await service.create(newSession())

    now = new Date(now.getTime() + 10_000)
    const rotated = await service.rotate(created.token)

    expect(rotated).toBeDefined()
    expect(rotated?.token).not.toBe(created.token)
    expect(rotated?.session.id).not.toBe(created.session.id)
    expect(rotated?.session.createdAt).toEqual(created.session.createdAt)
    expect(rotated?.session.absoluteExpiresAt).toEqual(created.session.absoluteExpiresAt)
    expect(await service.resolve(created.token)).toBeUndefined()
    expect(await service.resolve(rotated?.token ?? '')).toBeDefined()
  })

  it('revokes every current session for a user', async () => {
    const service = new SessionService(new MemorySessionStore(), 100, 20)
    const first = await service.create(newSession())
    const second = await service.create(newSession())
    const other = await service.create(newSession(OTHER_USER_ID))

    expect(await service.revokeUser(USER_ID)).toBe(2)
    expect(await service.resolve(first.token)).toBeUndefined()
    expect(await service.resolve(second.token)).toBeUndefined()
    expect(await service.resolve(other.token)).toBeDefined()

    const replacement = await service.create(newSession())
    expect(replacement.session.sessionEpoch).toBe(2)
  })

  it('destroys a previous browser session before issuing an authenticated session', async () => {
    const service = new SessionService(new MemorySessionStore(), 100, 20)
    const previous = await service.create(newSession(PREVIOUS_USER_ID))

    const authenticated = await service.replaceAfterAuthentication(
      previous.token,
      newSession(USER_ID),
    )

    expect(await service.resolve(previous.token)).toBeUndefined()
    expect(authenticated?.session.user.id).toBe(USER_ID)
  })

  it('allows authenticated replacement when the presented token is stale', async () => {
    const service = new SessionService(new MemorySessionStore(), 100, 20)

    const authenticated = await service.replaceAfterAuthentication(
      'stale-token',
      newSession(USER_ID),
    )

    expect(authenticated?.session.user.id).toBe(USER_ID)
    expect(await service.resolve(authenticated?.token ?? '')).toBeDefined()
  })

  it('invalidates the old token while allowing concurrent verified replacements', async () => {
    const service = new SessionService(new MemorySessionStore(), 100, 20)
    const previous = await service.create(newSession(PREVIOUS_USER_ID))

    const [first, second] = await Promise.all([
      service.replaceAfterAuthentication(previous.token, newSession(USER_ID)),
      service.replaceAfterAuthentication(previous.token, newSession(USER_ID)),
    ])

    expect(first?.session.user.id).toBe(USER_ID)
    expect(second?.session.user.id).toBe(USER_ID)
    expect(await service.resolve(previous.token)).toBeUndefined()
  })
})
