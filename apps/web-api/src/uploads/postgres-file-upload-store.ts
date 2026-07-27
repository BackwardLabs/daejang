import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

import type { Pool } from 'pg'

import type { CreateUpload, UploadSession, UploadStore } from './upload-store.js'

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

  constructor(pool: Pool, objectRoot: string) {
    this.#pool = pool
    this.#objectRoot = path.resolve(objectRoot)
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
    const session = await this.#get(userId, uploadId)
    if (!session || session.expiresAt <= now || !['PENDING', 'UPLOADED'].includes(session.state)) {
      return undefined
    }
    if (contents.length !== session.expectedBytes || contents.length > 20 * 1024 * 1024) {
      return undefined
    }
    const destination = this.#path(session.objectKey)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await rename(temporary, destination)
    await this.#pool.query(
      `UPDATE web_private.upload_sessions SET state='UPLOADED'
       WHERE id=$1::uuid AND user_id=$2::uuid AND state IN ('PENDING','UPLOADED')`,
      [uploadId, userId],
    )
    return { ...session, state: 'UPLOADED' as const }
  }

  async confirm(userId: string, uploadId: string, now: Date) {
    const session = await this.#get(userId, uploadId)
    if (!session || session.expiresAt <= now || !['UPLOADED', 'CONFIRMED'].includes(session.state)) {
      return undefined
    }
    if (session.state === 'CONFIRMED') {
      return session
    }
    const contents = await readFile(this.#path(session.objectKey))
    if (contents.length !== session.expectedBytes || contents.subarray(0, 5).toString() !== '%PDF-') {
      await this.#pool.query(`UPDATE web_private.upload_sessions SET state='FAILED' WHERE id=$1::uuid`, [uploadId])
      return undefined
    }
    const digest = createHash('sha256').update(contents).digest('hex')
    const result = await this.#pool.query<UploadRow>(
      `UPDATE web_private.upload_sessions SET state='CONFIRMED',verified_digest=$3,
        verified_bytes=$4,confirmed_at=$5
       WHERE id=$1::uuid AND user_id=$2::uuid AND state='UPLOADED'
       RETURNING id::text,user_id::text,provider,object_key,original_filename,media_type,
        expected_bytes,state,idempotency_key,expires_at,verified_digest,verified_bytes`,
      [uploadId, userId, digest, contents.length, now],
    )
    return result.rows[0] ? toSession(result.rows[0]) : undefined
  }

  async #get(userId: string, uploadId: string) {
    const result = await this.#pool.query<UploadRow>(
      `${selectUpload} WHERE user_id=$1::uuid AND id=$2::uuid`,
      [userId, uploadId],
    )
    return result.rows[0] ? toSession(result.rows[0]) : undefined
  }

  #path(objectKey: string) {
    const value = path.resolve(this.#objectRoot, objectKey)
    if (!value.startsWith(`${this.#objectRoot}${path.sep}`)) {
      throw new Error('Upload object key escapes the configured root')
    }
    return value
  }
}
