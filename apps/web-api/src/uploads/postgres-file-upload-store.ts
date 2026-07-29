import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

import type { Pool, PoolClient } from 'pg'

import {
  UploadValidationError,
  type CreateUpload,
  type UploadCleanupResult,
  type UploadSession,
  type UploadStore,
} from './upload-store.js'
import { validatePdfContents } from './pdf-validation.js'
import {
  decryptPrivateObject,
  encryptPrivateObject,
  type PrivateObjectKeyring,
} from './private-object-crypto.js'

type UploadRow = {
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
}

const toSession = (row: UploadRow): UploadSession => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  objectKey: row.object_key,
  originalFilename: row.original_filename,
  mediaType: row.media_type,
  expectedBytes: Number(row.expected_bytes),
  state: row.state,
  idempotencyKey: row.idempotency_key,
  expiresAt: row.expires_at,
  ...(row.verified_digest ? { verifiedDigest: row.verified_digest } : {}),
  ...(row.verified_bytes ? { verifiedBytes: Number(row.verified_bytes) } : {}),
})

const selectUpload = `SELECT id::text,user_id::text,provider,object_key,original_filename,
  media_type,expected_bytes,state,idempotency_key,expires_at,verified_digest,verified_bytes
  FROM web_private.upload_sessions`

const uploadReturning = `RETURNING id::text,user_id::text,provider,object_key,
  original_filename,media_type,expected_bytes,state,idempotency_key,expires_at,
  verified_digest,verified_bytes`

const qualifiedUploadReturning = (alias: string) => `RETURNING
  ${alias}.id::text AS id,
  ${alias}.user_id::text AS user_id,
  ${alias}.provider,
  ${alias}.object_key,
  ${alias}.original_filename,
  ${alias}.media_type,
  ${alias}.expected_bytes,
  ${alias}.state,
  ${alias}.idempotency_key,
  ${alias}.expires_at,
  ${alias}.verified_digest,
  ${alias}.verified_bytes`

const safeFilename = (value: string) => {
  const base = path.basename(value.normalize('NFKC')).replaceAll(/[^\p{L}\p{N}._ -]/gu, '_')
  return base.slice(0, 255) || 'upbit-statement.pdf'
}

export const assertPrivateObjectRoot = async (objectRoot: string) => {
  const root = path.resolve(objectRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const metadata = await stat(root)
  if (!metadata.isDirectory()) {
    throw new Error('PRIVATE_OBJECT_ROOT must be a directory')
  }
  await access(root, constants.R_OK | constants.W_OK)
}

export class PostgresFileUploadStore implements UploadStore {
  readonly durable = true
  readonly #pool: Pool
  readonly #objectRoot: string
  readonly #renameFile: typeof rename
  readonly #unlinkFile: typeof unlink
  readonly #keyring: PrivateObjectKeyring | undefined

  constructor(
    pool: Pool,
    objectRoot: string,
    options: {
      rename?: typeof rename
      unlink?: typeof unlink
      encryptionKey?: Buffer
      encryptionKeyId?: string
      decryptionKeys?: ReadonlyMap<string, Buffer>
    } = {},
  ) {
    this.#pool = pool
    this.#objectRoot = path.resolve(objectRoot)
    this.#renameFile = options.rename ?? rename
    this.#unlinkFile = options.unlink ?? unlink
    if (options.encryptionKey) {
      const currentKeyId = options.encryptionKeyId ?? 'primary'
      this.#keyring = {
        currentKeyId,
        keys: new Map([
          ...(options.decryptionKeys?.entries() ?? []),
          [currentKeyId, options.encryptionKey],
        ]),
      }
    }
  }

  async create(input: CreateUpload) {
    const id = randomUUID()
    const filename = safeFilename(input.originalFilename)
    const objectKey = path.posix.join('upbit', input.userId, `${id}.pdf`)
    const expiresAt = new Date(input.now.getTime() + 15 * 60_000)
    const result = await this.#pool.query<UploadRow>(
      `INSERT INTO web_private.upload_sessions(
        id,user_id,provider,object_key,original_filename,media_type,expected_bytes,
        idempotency_key,expires_at
      ) VALUES($1::uuid,$2::uuid,'UPBIT',$3,$4,$5,$6,$7,$8)
      ON CONFLICT(user_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING id::text,user_id::text,provider,object_key,original_filename,media_type,
        expected_bytes,state,idempotency_key,expires_at,verified_digest,verified_bytes`,
      [id, input.userId, objectKey, filename, input.mediaType, input.expectedBytes,
        input.idempotencyKey, expiresAt],
    )
    return toSession(result.rows[0] as UploadRow)
  }

  async write(userId: string, uploadId: string, contents: Buffer, now: Date) {
    const client = await this.#pool.connect()
    let destination: string | undefined
    let temporary: string | undefined
    let publishedObject = false
    let commitFailed = false
    let commitError: unknown
    let updatedSession: UploadSession | undefined
    try {
      await client.query('BEGIN')
      const session = await this.#getLocked(client, userId, uploadId)
      if (!session || session.state !== 'PENDING') {
        await client.query('COMMIT')
        return undefined
      }
      if (session.expiresAt <= now) {
        await client.query(
          `UPDATE web_private.upload_sessions SET state='EXPIRED',
             original_filename='discarded.pdf'
           WHERE id=$1::uuid AND user_id=$2::uuid AND state='PENDING'`,
          [uploadId, userId],
        )
        await client.query('COMMIT')
        await this.#removeAndTombstone(session)
        return undefined
      }
      if (contents.length !== session.expectedBytes || contents.length > 20 * 1024 * 1024) {
        await client.query('COMMIT')
        return undefined
      }

      try {
        destination = this.#path(session.objectKey)
        temporary = this.#temporaryPath(destination)
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        const staleTemporaryRemoval = await this.#unlinkPath(temporary)
        if (staleTemporaryRemoval === 'retry') {
          throw new Error('temporary cleanup failed')
        }
        const storedContents = this.#keyring
          ? encryptPrivateObject(contents, this.#keyring, session.objectKey)
          : contents
        await writeFile(temporary, storedContents, { mode: 0o600, flag: 'wx' })
        await this.#renameFile(temporary, destination)
        publishedObject = true
      } catch {
        throw new Error('Private upload object publish failed')
      }

      const result = await client.query<UploadRow>(
        `UPDATE web_private.upload_sessions SET state='UPLOADED'
         WHERE id=$1::uuid AND user_id=$2::uuid AND state='PENDING'
         ${uploadReturning}`,
        [uploadId, userId],
      )
      if (!result.rows[0]) {
        await client.query('ROLLBACK')
        await this.#unlinkObject(session)
        return undefined
      }
      updatedSession = toSession(result.rows[0])
      try {
        await client.query('COMMIT')
      } catch (error) {
        commitFailed = true
        commitError = error
      }
      if (!commitFailed) return updatedSession
    } catch (error) {
      await this.#rollback(client)
      if (publishedObject && destination) {
        await this.#unlinkPath(destination)
      }
      if (temporary) await this.#unlinkPath(temporary)
      throw error
    } finally {
      client.release(commitFailed ? (commitError instanceof Error ? commitError : true) : undefined)
    }

    if (!updatedSession || !destination) {
      throw new Error('Upload commit reconciliation invariant failed')
    }
    if (temporary) await this.#unlinkPath(temporary)
    const reconciliation = await this.#reconcileWriteCommit(
      userId,
      uploadId,
      updatedSession,
      contents,
    )
    if (reconciliation.status === 'applied') return reconciliation.session
    if (reconciliation.status === 'unknown') {
      throw new Error(
        'Upload commit result remains ambiguous; published object preserved',
        { cause: commitError },
      )
    }

    const cleanup = await this.#unlinkPath(destination)
    if (cleanup === 'retry') {
      throw new Error('Private upload object cleanup failed after ambiguous commit', {
        cause: commitError,
      })
    }
    throw commitError
  }

  async confirm(userId: string, uploadId: string, now: Date) {
    const client = await this.#pool.connect()
    let rejected: { session: UploadSession; failure: 'ENCRYPTED_PDF' | 'INVALID_PDF' } | undefined
    let expired: UploadSession | undefined
    try {
      await client.query('BEGIN')
      const session = await this.#getLocked(client, userId, uploadId)
      if (!session || !['UPLOADED', 'CONFIRMED'].includes(session.state)) {
        await client.query('COMMIT')
        return undefined
      }
      if (session.expiresAt <= now) {
        const result = await client.query(
          `UPDATE web_private.upload_sessions SET state='EXPIRED',
             original_filename='discarded.pdf',
             verified_digest=NULL,verified_bytes=NULL,confirmed_at=NULL
           WHERE id=$1::uuid AND user_id=$2::uuid AND state=$3`,
          [uploadId, userId, session.state],
        )
        if (result.rowCount !== 1) throw new Error('Upload expiration CAS failed')
        expired = session
        await client.query('COMMIT')
      } else {
        let contents: Buffer
        try {
          contents = await this.#readObject(session.objectKey)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error('Private upload object read failed')
          }
          contents = Buffer.alloc(0)
        }
        const digest = createHash('sha256').update(contents).digest('hex')
        const validationResult = validatePdfContents(contents)
        const validationFailure = (
          contents.length !== session.expectedBytes ||
          (session.state === 'CONFIRMED' && (
            contents.length !== session.verifiedBytes || digest !== session.verifiedDigest
          ))
        )
          ? 'INVALID_PDF'
          : validationResult === 'ENCRYPTED_PDF'
            ? undefined
            : validationResult
        if (validationFailure) {
          const result = await client.query<UploadRow>(
            `UPDATE web_private.upload_sessions
             SET state='FAILED',original_filename='discarded.pdf',
               verified_digest=NULL,verified_bytes=NULL,confirmed_at=NULL
             WHERE id=$1::uuid AND user_id=$2::uuid AND state=$3
             ${uploadReturning}`,
            [uploadId, userId, session.state],
          )
          if (!result.rows[0]) throw new Error('Upload rejection CAS failed')
          rejected = { session: toSession(result.rows[0]), failure: validationFailure }
          await client.query('COMMIT')
        } else if (session.state === 'CONFIRMED') {
          await client.query('COMMIT')
          return session
        } else {
          const result = await client.query<UploadRow>(
            `UPDATE web_private.upload_sessions SET state='CONFIRMED',verified_digest=$3,
              verified_bytes=$4,confirmed_at=$5
             WHERE id=$1::uuid AND user_id=$2::uuid AND state='UPLOADED'
             ${uploadReturning}`,
            [uploadId, userId, digest, contents.length, now],
          )
          if (!result.rows[0]) throw new Error('Upload confirmation CAS failed')
          await client.query('COMMIT')
          return toSession(result.rows[0])
        }
      }
    } catch (error) {
      await this.#rollback(client)
      throw error
    } finally {
      client.release()
    }

    if (expired) {
      await this.#removeAndTombstone(expired)
      return undefined
    }
    if (rejected) {
      await this.#removeAndTombstone(rejected.session)
      throw new UploadValidationError(rejected.failure)
    }
    return undefined
  }

  async readConfirmed(userId: string, uploadId: string) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const session = await this.#getLocked(client, userId, uploadId)
      if (
        !session ||
        session.state !== 'CONFIRMED' ||
        !session.verifiedDigest ||
        session.verifiedBytes === undefined
      ) {
        await client.query('COMMIT')
        return undefined
      }
      const contents = await this.#readObject(session.objectKey)
      const digest = createHash('sha256').update(contents).digest('hex')
      if (
        contents.byteLength !== session.verifiedBytes ||
        digest !== session.verifiedDigest
      ) {
        await client.query('ROLLBACK')
        return undefined
      }
      await client.query('COMMIT')
      return { session, contents }
    } catch (error) {
      await this.#rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async discard(userId: string, uploadId: string) {
    const client = await this.#pool.connect()
    let session: UploadSession | undefined
    let discardingConfirmed = false
    try {
      await client.query('BEGIN')
      session = await this.#getLocked(client, userId, uploadId)
      if (!session) {
        await client.query('COMMIT')
        return false
      }
      if (session.state === 'FAILED' || session.state === 'EXPIRED') {
        await client.query('COMMIT')
      } else if (session.state !== 'CONFIRMED') {
        await client.query('COMMIT')
        return false
      } else {
        discardingConfirmed = true
        const result = await client.query<UploadRow>(
          `UPDATE web_private.upload_sessions
           SET state='FAILED',original_filename='discarded.pdf',
             verified_digest=NULL,verified_bytes=NULL,confirmed_at=NULL
           WHERE id=$1::uuid AND user_id=$2::uuid AND state='CONFIRMED'
           ${uploadReturning}`,
          [uploadId, userId],
        )
        if (!result.rows[0]) throw new Error('Upload discard CAS failed')
        session = toSession(result.rows[0])
        await client.query('COMMIT')
      }
    } catch (error) {
      await this.#rollback(client)
      if (discardingConfirmed && session) {
        await this.#unlinkObject(session)
      }
      throw error
    } finally {
      client.release()
    }
    await this.#removeAndTombstone(session)
    return true
  }

  async cleanupAbandoned(now: Date, limit = 100): Promise<UploadCleanupResult> {
    const result = await this.#pool.query<UploadRow>(
      `WITH candidates AS (
         SELECT id
         FROM web_private.upload_sessions
         WHERE object_key NOT LIKE 'discarded/%'
           AND (
             state IN ('FAILED','EXPIRED')
             OR (state IN ('PENDING','UPLOADED','CONFIRMED') AND expires_at <= $1)
           )
         ORDER BY expires_at,id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE web_private.upload_sessions AS uploads
       SET state=CASE
         WHEN uploads.state IN ('PENDING','UPLOADED','CONFIRMED') THEN 'EXPIRED'
         ELSE uploads.state
       END,
       verified_digest=NULL,
       verified_bytes=NULL,
       confirmed_at=NULL,
       original_filename='discarded.pdf'
       FROM candidates
       WHERE uploads.id=candidates.id
       ${qualifiedUploadReturning('uploads')}`,
      [now, Math.max(1, Math.min(limit, 1_000))],
    )
    const cleanup: UploadCleanupResult = {
      examined: result.rows.length,
      removed: 0,
      missing: 0,
      retryPending: 0,
    }
    for (const row of result.rows) {
      const outcome = await this.#removeAndTombstone(toSession(row))
      if (outcome === 'removed') cleanup.removed += 1
      else if (outcome === 'missing') cleanup.missing += 1
      else cleanup.retryPending += 1
    }
    return cleanup
  }

  async #getLocked(client: PoolClient, userId: string, uploadId: string) {
    const result = await client.query<UploadRow>(
      `${selectUpload} WHERE user_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [userId, uploadId],
    )
    return result.rows[0] ? toSession(result.rows[0]) : undefined
  }

  async #reconcileWriteCommit(
    userId: string,
    uploadId: string,
    expectedSession: UploadSession,
    expectedContents: Buffer,
  ) {
    let current: UploadSession | undefined
    try {
      const result = await this.#pool.query<UploadRow>(
        `${selectUpload} WHERE user_id=$1::uuid AND id=$2::uuid`,
        [userId, uploadId],
      )
      current = result.rows[0] ? toSession(result.rows[0]) : undefined
    } catch {
      return { status: 'unknown' as const }
    }
    if (!current) {
      return { status: 'not_applied' as const }
    }
    const matchesPublishedObject =
      current.objectKey === expectedSession.objectKey &&
      current.expectedBytes === expectedSession.expectedBytes
    if (current.state === 'PENDING' && matchesPublishedObject) {
      return { status: 'not_applied' as const }
    }
    if (
      !matchesPublishedObject ||
      !['UPLOADED', 'CONFIRMED'].includes(current.state)
    ) {
      return { status: 'unknown' as const }
    }
    try {
      const publishedContents = await this.#readObject(current.objectKey)
      return publishedContents.equals(expectedContents)
        ? { status: 'applied' as const, session: current }
        : { status: 'unknown' as const }
    } catch {
      return { status: 'unknown' as const }
    }
  }

  async #removeAndTombstone(session: UploadSession) {
    const outcome = await this.#unlinkObject(session)
    if (outcome === 'retry') return outcome
    await this.#pool.query(
      `UPDATE web_private.upload_sessions SET object_key=$3,
         original_filename='discarded.pdf'
       WHERE id=$1::uuid AND user_id=$2::uuid
         AND object_key=$4 AND state IN ('FAILED','EXPIRED')`,
      [session.id, session.userId, this.#tombstoneKey(session.id), session.objectKey],
    )
    return outcome
  }

  async #unlinkObject(session: UploadSession) {
    const destination = this.#path(session.objectKey)
    const destinationOutcome = await this.#unlinkPath(destination)
    const temporaryOutcome = await this.#unlinkPath(this.#temporaryPath(destination))
    if (destinationOutcome === 'retry' || temporaryOutcome === 'retry') return 'retry'
    if (destinationOutcome === 'removed' || temporaryOutcome === 'removed') return 'removed'
    return 'missing'
  }

  async #unlinkPath(value: string): Promise<'missing' | 'removed' | 'retry'> {
    try {
      await this.#unlinkFile(value)
      return 'removed'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'retry'
    }
  }

  async #rollback(client: PoolClient) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original transaction error remains authoritative.
    }
  }

  #tombstoneKey(uploadId: string) {
    return path.posix.join('discarded', uploadId)
  }

  #temporaryPath(destination: string) {
    return `${destination}.pending`
  }

  async #readObject(objectKey: string) {
    const storedContents = await readFile(this.#path(objectKey))
    return this.#keyring
      ? decryptPrivateObject(storedContents, this.#keyring, objectKey)
      : storedContents
  }

  #path(objectKey: string) {
    const value = path.resolve(this.#objectRoot, objectKey)
    if (!value.startsWith(`${this.#objectRoot}${path.sep}`)) {
      throw new Error('Upload object key escapes the configured root')
    }
    return value
  }
}
