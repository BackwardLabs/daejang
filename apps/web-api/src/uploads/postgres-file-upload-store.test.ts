import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink as unlinkFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Pool } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

import { PostgresFileUploadStore } from './postgres-file-upload-store.js'
import type { UploadSession } from './upload-store.js'

type UploadRowFixture = {
  id: string
  user_id: string
  provider: 'UPBIT'
  object_key: string
  original_filename: string
  media_type: 'application/pdf'
  expected_bytes: string
  state: UploadSession['state']
  idempotency_key: string
  expires_at: Date
  verified_digest: string | null
  verified_bytes: string | null
  confirmed_at: Date | null
}

const userId = '11111111-1111-4111-8111-111111111111'
const uploadId = '22222222-2222-4222-8222-222222222222'
const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

const cloneRow = (row: UploadRowFixture): UploadRowFixture => ({ ...row })

const uploadRow = (
  contents: Buffer,
  state: UploadSession['state'],
  expiresAt = new Date('2027-01-01T00:15:00Z'),
): UploadRowFixture => ({
  id: uploadId,
  user_id: userId,
  provider: 'UPBIT',
  object_key: `upbit/${userId}/${uploadId}.pdf`,
  original_filename: 'statement.pdf',
  media_type: 'application/pdf',
  expected_bytes: String(contents.length),
  state,
  idempotency_key: 'upload-intent',
  expires_at: expiresAt,
  verified_digest: state === 'CONFIRMED'
    ? createHash('sha256').update(contents).digest('hex')
    : null,
  verified_bytes: state === 'CONFIRMED' ? String(contents.length) : null,
  confirmed_at: state === 'CONFIRMED' ? new Date('2027-01-01T00:00:00Z') : null,
})

class StatefulPool {
  row: UploadRowFixture
  commitCount = 0
  failNextCommit: 'committed' | 'rolled_back' | undefined
  failReconciliationQuery = false
  confirmBeforeReconciliation = false

  readonly #pauseFirstLock: boolean
  readonly #firstLockReached: Promise<void>
  readonly #releaseFirstLock: Promise<void>
  #resolveFirstLockReached!: () => void
  #resolveReleaseFirstLock!: () => void
  #lockOwner: StatefulClient | undefined
  #lockWaiters: Array<{ client: StatefulClient; resolve: () => void }> = []
  #lockCount = 0

  constructor(row: UploadRowFixture, pauseFirstLock = false) {
    this.row = row
    this.#pauseFirstLock = pauseFirstLock
    this.#firstLockReached = new Promise((resolve) => {
      this.#resolveFirstLockReached = resolve
    })
    this.#releaseFirstLock = new Promise((resolve) => {
      this.#resolveReleaseFirstLock = resolve
    })
  }

  connect() {
    return new StatefulClient(this)
  }

  async query(sql: string, values: unknown[] = []) {
    if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM web_private.upload_sessions')) {
      if (this.failReconciliationQuery) {
        throw new Error('reconciliation database unavailable')
      }
      if (this.confirmBeforeReconciliation) {
        this.confirmBeforeReconciliation = false
        this.row.state = 'CONFIRMED'
        this.row.verified_digest = createHash('sha256')
          .update(validPdf)
          .digest('hex')
        this.row.verified_bytes = String(validPdf.length)
        this.row.confirmed_at = new Date('2027-01-01T00:00:01Z')
      }
      const [ownerId, id] = values as string[]
      const matches = this.row.user_id === ownerId && this.row.id === id
      return { rows: matches ? [cloneRow(this.row)] : [], rowCount: matches ? 1 : 0 }
    }

    if (sql.includes('WITH candidates AS')) {
      const now = values[0] as Date
      const abandoned = !this.row.object_key.startsWith('discarded/') && (
        this.row.state === 'FAILED' ||
        this.row.state === 'EXPIRED' ||
        (['PENDING', 'UPLOADED', 'CONFIRMED'].includes(this.row.state) &&
          this.row.expires_at <= now)
      )
      if (!abandoned) return { rows: [], rowCount: 0 }
      if (['PENDING', 'UPLOADED', 'CONFIRMED'].includes(this.row.state)) {
        this.row.state = 'EXPIRED'
      }
      this.row.verified_digest = null
      this.row.verified_bytes = null
      this.row.confirmed_at = null
      this.row.original_filename = 'discarded.pdf'
      return { rows: [cloneRow(this.row)], rowCount: 1 }
    }

    if (sql.includes('SET object_key=$3')) {
      const [id, ownerId, tombstone, expectedObjectKey] = values as string[]
      const matches = this.row.id === id &&
        this.row.user_id === ownerId &&
        this.row.object_key === expectedObjectKey &&
        ['FAILED', 'EXPIRED'].includes(this.row.state)
      if (matches) {
        this.row.object_key = tombstone as string
        this.row.original_filename = 'discarded.pdf'
      }
      return { rows: [], rowCount: matches ? 1 : 0 }
    }

    throw new Error(`Unexpected pool query: ${sql}`)
  }

  async waitForFirstLock() {
    await this.#firstLockReached
  }

  releaseFirstLock() {
    this.#resolveReleaseFirstLock()
  }

  async acquireLock(client: StatefulClient) {
    if (!this.#lockOwner) {
      this.#lockOwner = client
    } else {
      await new Promise<void>((resolve) => {
        this.#lockWaiters.push({ client, resolve })
      })
    }
    this.#lockCount += 1
    if (this.#lockCount === 1) {
      this.#resolveFirstLockReached()
      if (this.#pauseFirstLock) await this.#releaseFirstLock
    }
  }

  releaseLock(client: StatefulClient) {
    if (this.#lockOwner !== client) return
    const next = this.#lockWaiters.shift()
    if (next) {
      this.#lockOwner = next.client
      next.resolve()
    } else {
      this.#lockOwner = undefined
    }
  }
}

class StatefulClient {
  readonly #pool: StatefulPool
  #snapshot: UploadRowFixture | undefined
  #transactionOpen = false
  #lockHeld = false

  constructor(pool: StatefulPool) {
    this.#pool = pool
  }

  async query(sql: string, values: unknown[] = []) {
    if (sql === 'BEGIN') {
      this.#transactionOpen = true
      return { rows: [], rowCount: null }
    }
    if (sql === 'COMMIT') {
      const failure = this.#pool.failNextCommit
      this.#pool.failNextCommit = undefined
      if (failure === 'rolled_back' && this.#snapshot) {
        this.#pool.row = cloneRow(this.#snapshot)
      } else {
        this.#pool.commitCount += 1
      }
      this.#transactionOpen = false
      this.#snapshot = undefined
      this.#releaseLock()
      if (failure) throw new Error('ambiguous commit result')
      return { rows: [], rowCount: null }
    }
    if (sql === 'ROLLBACK') {
      if (this.#transactionOpen && this.#snapshot) {
        this.#pool.row = cloneRow(this.#snapshot)
      }
      this.#transactionOpen = false
      this.#snapshot = undefined
      this.#releaseLock()
      return { rows: [], rowCount: null }
    }

    if (sql.includes('FROM web_private.upload_sessions') && sql.includes('FOR UPDATE')) {
      await this.#pool.acquireLock(this)
      this.#lockHeld = true
      this.#snapshot = cloneRow(this.#pool.row)
      const [ownerId, id] = values as string[]
      const matches = this.#pool.row.user_id === ownerId && this.#pool.row.id === id
      return { rows: matches ? [cloneRow(this.#pool.row)] : [], rowCount: matches ? 1 : 0 }
    }

    const [id, ownerId] = values as string[]
    const matchesUpload = this.#pool.row.id === id && this.#pool.row.user_id === ownerId
    if (sql.includes("SET state='UPLOADED'")) {
      const matches = matchesUpload && this.#pool.row.state === 'PENDING'
      if (matches) this.#pool.row.state = 'UPLOADED'
      return { rows: matches ? [cloneRow(this.#pool.row)] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes("SET state='CONFIRMED'")) {
      const matches = matchesUpload && this.#pool.row.state === 'UPLOADED'
      if (matches) {
        this.#pool.row.state = 'CONFIRMED'
        this.#pool.row.verified_digest = values[2] as string
        this.#pool.row.verified_bytes = String(values[3])
        this.#pool.row.confirmed_at = values[4] as Date
      }
      return { rows: matches ? [cloneRow(this.#pool.row)] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes("SET state='FAILED'")) {
      const expectedState = (values[2] as UploadSession['state'] | undefined) ?? 'CONFIRMED'
      const matches = matchesUpload && this.#pool.row.state === expectedState
      if (matches) {
        this.#pool.row.state = 'FAILED'
        this.#pool.row.verified_digest = null
        this.#pool.row.verified_bytes = null
        this.#pool.row.confirmed_at = null
        this.#pool.row.original_filename = 'discarded.pdf'
      }
      return { rows: matches ? [cloneRow(this.#pool.row)] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes("SET state='EXPIRED'")) {
      const expectedState = (values[2] as UploadSession['state'] | undefined) ?? 'PENDING'
      const matches = matchesUpload && this.#pool.row.state === expectedState
      if (matches) {
        this.#pool.row.state = 'EXPIRED'
        this.#pool.row.verified_digest = null
        this.#pool.row.verified_bytes = null
        this.#pool.row.confirmed_at = null
        this.#pool.row.original_filename = 'discarded.pdf'
      }
      return { rows: [], rowCount: matches ? 1 : 0 }
    }

    throw new Error(`Unexpected client query: ${sql}`)
  }

  release() {
    this.#releaseLock()
  }

  #releaseLock() {
    if (!this.#lockHeld) return
    this.#lockHeld = false
    this.#pool.releaseLock(this)
  }
}

const temporaryRoots: string[] = []

const fixture = async (
  row: UploadRowFixture,
  options: {
    pauseFirstLock?: boolean
    unlink?: typeof unlinkFile
  } = {},
) => {
  const root = await mkdtemp(path.join(tmpdir(), 'daejang-upload-test-'))
  temporaryRoots.push(root)
  const pool = new StatefulPool(row, options.pauseFirstLock)
  const store = new PostgresFileUploadStore(
    pool as unknown as Pool,
    root,
    options.unlink ? { unlink: options.unlink } : {},
  )
  const objectPath = path.join(root, row.object_key)
  return { root, pool, store, objectPath, temporaryPath: `${objectPath}.pending` }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ))
})

describe('PostgresFileUploadStore state and file boundary', () => {
  it('recovers partial destination and temporary files through an atomic publish', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { store, objectPath, temporaryPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, Buffer.from('partial-final'))
    await writeFile(temporaryPath, Buffer.from('partial-temporary'))

    const session = await store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z'))

    expect(session?.state).toBe('UPLOADED')
    expect(await readFile(objectPath)).toEqual(validPdf)
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the uploaded session when an ambiguous write commit was applied', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store, objectPath } = await fixture(row)
    pool.failNextCommit = 'committed'

    await expect(
      store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z')),
    ).resolves.toMatchObject({ state: 'UPLOADED', objectKey: row.object_key })
    expect(pool.row.state).toBe('UPLOADED')
    expect(await readFile(objectPath)).toEqual(validPdf)
  })

  it('removes published bytes when an ambiguous write commit was rolled back', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store, objectPath, temporaryPath } = await fixture(row)
    pool.failNextCommit = 'rolled_back'

    await expect(
      store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z')),
    ).rejects.toThrow('ambiguous commit result')
    expect(pool.row.state).toBe('PENDING')
    await expect(access(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves published bytes when an applied commit cannot be reconciled', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store, objectPath } = await fixture(row)
    pool.failNextCommit = 'committed'
    pool.failReconciliationQuery = true

    await expect(
      store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z')),
    ).rejects.toThrow('published object preserved')
    expect(pool.row.state).toBe('UPLOADED')
    expect(await readFile(objectPath)).toEqual(validPdf)
  })

  it('accepts a concurrent confirmation after an ambiguous applied commit', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store, objectPath } = await fixture(row)
    pool.failNextCommit = 'committed'
    pool.confirmBeforeReconciliation = true

    await expect(
      store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z')),
    ).resolves.toMatchObject({ state: 'CONFIRMED', verifiedBytes: validPdf.length })
    expect(pool.row.state).toBe('CONFIRMED')
    expect(await readFile(objectPath)).toEqual(validPdf)
  })

  it('allows only one concurrent PUT to transition a pending upload', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store, objectPath } = await fixture(row, { pauseFirstLock: true })
    const competingContents = Buffer.from(validPdf.toString().replace('/Catalog', '/Example'))
    expect(competingContents.length).toBe(validPdf.length)

    const first = store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z'))
    await pool.waitForFirstLock()
    const second = store.write(userId, uploadId, competingContents, new Date('2027-01-01T00:00:00Z'))
    pool.releaseFirstLock()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult?.state).toBe('UPLOADED')
    expect(secondResult).toBeUndefined()
    expect(pool.row.state).toBe('UPLOADED')
    expect(await readFile(objectPath)).toEqual(validPdf)
  })

  it('serializes confirm after a concurrent PUT and verifies the complete object', async () => {
    const row = uploadRow(validPdf, 'PENDING')
    const { pool, store } = await fixture(row, { pauseFirstLock: true })

    const write = store.write(userId, uploadId, validPdf, new Date('2027-01-01T00:00:00Z'))
    await pool.waitForFirstLock()
    const confirm = store.confirm(userId, uploadId, new Date('2027-01-01T00:00:01Z'))
    pool.releaseFirstLock()
    const [written, confirmed] = await Promise.all([write, confirm])

    expect(written?.state).toBe('UPLOADED')
    expect(confirmed).toMatchObject({
      state: 'CONFIRMED',
      verifiedDigest: createHash('sha256').update(validPdf).digest('hex'),
      verifiedBytes: validPdf.length,
    })
    expect(pool.row.state).toBe('CONFIRMED')
  })

  it('confirms and retains an encrypted original for the private import boundary', async () => {
    const encryptedPdf = Buffer.from('%PDF-1.7\ntrailer\n<< /Encrypt 3 0 R >>\n%%EOF\n')
    const row = uploadRow(encryptedPdf, 'UPLOADED')
    const { pool, store, objectPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, encryptedPdf)

    const confirmed = await store.confirm(
      userId,
      uploadId,
      new Date('2027-01-01T00:00:00Z'),
    )
    expect(confirmed).toMatchObject({
      state: 'CONFIRMED',
      verifiedDigest: createHash('sha256').update(encryptedPdf).digest('hex'),
      verifiedBytes: encryptedPdf.length,
    })
    expect(pool.row.state).toBe('CONFIRMED')
    await expect(store.readConfirmed(userId, uploadId)).resolves.toMatchObject({
      session: { state: 'CONFIRMED' },
      contents: encryptedPdf,
    })
    await expect(readFile(objectPath)).resolves.toEqual(encryptedPdf)
  })

  it('fails closed when a confirmed encrypted original changes on disk', async () => {
    const encryptedPdf = Buffer.from('%PDF-1.7\n<< /Encrypt 3 0 R >>\n%%EOF\n')
    const row = uploadRow(encryptedPdf, 'UPLOADED')
    const { pool, store, objectPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, encryptedPdf)

    await store.confirm(userId, uploadId, new Date('2027-01-01T00:00:00Z'))
    await writeFile(objectPath, Buffer.from('%PDF-1.7\nchanged\n%%EOF\n'))

    await expect(store.readConfirmed(userId, uploadId)).resolves.toBeUndefined()
    expect(pool.row.state).toBe('CONFIRMED')
  })

  it('cleans expired pending temporary files and tombstones their object key', async () => {
    const row = uploadRow(validPdf, 'PENDING', new Date('2027-01-01T00:00:00Z'))
    const { pool, store, objectPath, temporaryPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(temporaryPath, Buffer.from('abandoned-private-bytes'))

    await expect(
      store.cleanupAbandoned(new Date('2027-01-01T00:01:00Z')),
    ).resolves.toEqual({ examined: 1, removed: 1, missing: 0, retryPending: 0 })
    expect(pool.row.state).toBe('EXPIRED')
    expect(pool.row.object_key).toBe(`discarded/${uploadId}`)
    expect(pool.row.original_filename).toBe('discarded.pdf')
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('expires and removes an abandoned confirmed object instead of retaining it forever', async () => {
    const row = uploadRow(validPdf, 'CONFIRMED', new Date('2027-01-01T00:00:00Z'))
    const { pool, store, objectPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, validPdf)

    await expect(
      store.cleanupAbandoned(new Date('2027-01-01T00:01:00Z')),
    ).resolves.toEqual({ examined: 1, removed: 1, missing: 0, retryPending: 0 })
    expect(pool.row).toMatchObject({
      state: 'EXPIRED',
      object_key: `discarded/${uploadId}`,
      original_filename: 'discarded.pdf',
      verified_digest: null,
      verified_bytes: null,
      confirmed_at: null,
    })
    await expect(access(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('transitions a confirmed upload before deleting its raw object', async () => {
    const row = uploadRow(validPdf, 'CONFIRMED')
    let pool: StatefulPool
    const orderedUnlink: typeof unlinkFile = async (value) => {
      expect(pool.commitCount).toBeGreaterThan(0)
      await unlinkFile(value)
    }
    const fixtureValue = await fixture(row, { unlink: orderedUnlink })
    pool = fixtureValue.pool
    await mkdir(path.dirname(fixtureValue.objectPath), { recursive: true })
    await writeFile(fixtureValue.objectPath, validPdf)

    await expect(fixtureValue.store.discard(userId, uploadId)).resolves.toBe(true)
    expect(pool.row.state).toBe('FAILED')
    expect(pool.row.object_key).toBe(`discarded/${uploadId}`)
    expect(pool.row.original_filename).toBe('discarded.pdf')
    await expect(access(fixtureValue.objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes raw bytes on an ambiguous discard commit and invalidates a stale confirmed row', async () => {
    const row = uploadRow(validPdf, 'CONFIRMED')
    const { pool, store, objectPath } = await fixture(row)
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, validPdf)
    pool.failNextCommit = 'rolled_back'

    await expect(store.discard(userId, uploadId)).rejects.toThrow('ambiguous commit result')
    expect(pool.row.state).toBe('CONFIRMED')
    await expect(access(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(
      store.confirm(userId, uploadId, new Date('2027-01-01T00:01:00Z')),
    ).rejects.toMatchObject({ code: 'INVALID_PDF' })
    expect(pool.row.state).toBe('FAILED')
    expect(pool.row.object_key).toBe(`discarded/${uploadId}`)
    expect(pool.row.original_filename).toBe('discarded.pdf')
  })
})
