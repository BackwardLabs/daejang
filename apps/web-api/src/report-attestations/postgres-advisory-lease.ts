import type { Pool, PoolClient } from 'pg'

type AdvisoryLockRow = {
  acquired: boolean
}

type AdvisoryUnlockRow = {
  released: boolean
}

type ConnectionHealthRow = {
  alive: number
}

export const GIWA_REPORT_WRITER_LEASE_KEY =
  'giwa.report-attestation.writer.eip155:91342.v1'

export type PostgresAdvisoryLease = Readonly<{
  readiness(): Promise<void>
  close(): Promise<void>
}>

export const acquirePostgresAdvisoryLease = async (
  pool: Pool,
  leaseKey: string,
): Promise<PostgresAdvisoryLease> => {
  if (
    leaseKey.length === 0 ||
    leaseKey.length > 200 ||
    !/^[A-Za-z0-9.:_-]+$/u.test(leaseKey)
  ) {
    throw new Error('PostgreSQL advisory lease key is invalid')
  }

  const client = await pool.connect()
  try {
    const acquired = await client.query<AdvisoryLockRow>(
      `
        SELECT
          pg_try_advisory_lock(
            hashtextextended($1, 0)
          ) AS acquired
      `,
      [leaseKey],
    )
    if (acquired.rows[0]?.acquired !== true) {
      throw new Error(
        'GIWA report writer lease is already held by another process',
      )
    }
  } catch (error) {
    client.release()
    throw error
  }

  return createHeldLease(client, leaseKey)
}

const createHeldLease = (
  client: PoolClient,
  leaseKey: string,
): PostgresAdvisoryLease => {
  let closing = false
  let closed = false
  let closePromise: Promise<void> | undefined

  const readiness = async () => {
    if (closing || closed) {
      throw new Error('GIWA report writer lease is closed')
    }
    const health = await client.query<ConnectionHealthRow>(
      'SELECT 1::integer AS alive',
    )
    if (health.rows[0]?.alive !== 1 || closing || closed) {
      throw new Error(
        'GIWA report writer lease connection is unavailable',
      )
    }
  }

  const close = () => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      try {
        const unlocked = await client.query<AdvisoryUnlockRow>(
          `
            SELECT
              pg_advisory_unlock(
                hashtextextended($1, 0)
              ) AS released
          `,
          [leaseKey],
        )
        if (unlocked.rows[0]?.released !== true) {
          throw new Error(
            'GIWA report writer advisory lock was lost before shutdown',
          )
        }
      } finally {
        closed = true
        client.release()
      }
    })()
    return closePromise
  }

  return Object.freeze({ readiness, close })
}
