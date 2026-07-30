import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  acquirePostgresAdvisoryLease,
  GIWA_REPORT_WRITER_LEASE_KEY,
} from './postgres-advisory-lease.js'

const queryResult = <T extends QueryResultRow>(
  rows: T[],
): QueryResult<T> =>
  ({
    command: '',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  }) as QueryResult<T>

const fakePool = (
  query: ReturnType<typeof vi.fn>,
) => {
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(async () => client)
  return {
    pool: { connect } as unknown as Pool,
    connect,
    query,
    release,
  }
}

describe('PostgreSQL advisory lease', () => {
  it('holds one dedicated connection until an idempotent close', async () => {
    const query = vi.fn(
      async (sqlValue: string, _values?: unknown[]) => {
        if (sqlValue.includes('pg_try_advisory_lock')) {
          return queryResult([{ acquired: true }])
        }
        if (sqlValue === 'SELECT 1::integer AS alive') {
          return queryResult([{ alive: 1 }])
        }
        if (sqlValue.includes('pg_advisory_unlock')) {
          return queryResult([{ released: true }])
        }
        throw new Error(`Unexpected query: ${sqlValue}`)
      },
    )
    const harness = fakePool(query)

    const lease = await acquirePostgresAdvisoryLease(
      harness.pool,
      GIWA_REPORT_WRITER_LEASE_KEY,
    )
    await lease.readiness()
    const firstClose = lease.close()
    const secondClose = lease.close()

    expect(firstClose).toBe(secondClose)
    await firstClose
    await expect(lease.readiness()).rejects.toThrow(
      'writer lease is closed',
    )
    expect(harness.connect).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0]?.[1]).toEqual([
      GIWA_REPORT_WRITER_LEASE_KEY,
    ])
    expect(query.mock.calls[2]?.[1]).toEqual([
      GIWA_REPORT_WRITER_LEASE_KEY,
    ])
  })

  it('fails startup and releases the connection when another writer owns the lock', async () => {
    const query = vi.fn(async () =>
      queryResult([{ acquired: false }]),
    )
    const harness = fakePool(query)

    await expect(
      acquirePostgresAdvisoryLease(
        harness.pool,
        GIWA_REPORT_WRITER_LEASE_KEY,
      ),
    ).rejects.toThrow('already held by another process')
    expect(harness.release).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
  })

  it('releases the connection when lock acquisition fails', async () => {
    const query = vi.fn(async () => {
      throw new Error('database unavailable')
    })
    const harness = fakePool(query)

    await expect(
      acquirePostgresAdvisoryLease(
        harness.pool,
        GIWA_REPORT_WRITER_LEASE_KEY,
      ),
    ).rejects.toThrow('database unavailable')
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it('fails readiness when the dedicated connection health check is invalid', async () => {
    const query = vi.fn(async (sqlValue: string) => {
      if (sqlValue.includes('pg_try_advisory_lock')) {
        return queryResult([{ acquired: true }])
      }
      if (sqlValue === 'SELECT 1::integer AS alive') {
        return queryResult([{ alive: 0 }])
      }
      if (sqlValue.includes('pg_advisory_unlock')) {
        return queryResult([{ released: true }])
      }
      throw new Error(`Unexpected query: ${sqlValue}`)
    })
    const harness = fakePool(query)
    const lease = await acquirePostgresAdvisoryLease(
      harness.pool,
      GIWA_REPORT_WRITER_LEASE_KEY,
    )

    await expect(lease.readiness()).rejects.toThrow(
      'connection is unavailable',
    )
    await lease.close()
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it('releases the connection even when explicit unlock fails', async () => {
    const query = vi.fn(async (sqlValue: string) => {
      if (sqlValue.includes('pg_try_advisory_lock')) {
        return queryResult([{ acquired: true }])
      }
      if (sqlValue.includes('pg_advisory_unlock')) {
        throw new Error('connection lost')
      }
      throw new Error(`Unexpected query: ${sqlValue}`)
    })
    const harness = fakePool(query)
    const lease = await acquirePostgresAdvisoryLease(
      harness.pool,
      GIWA_REPORT_WRITER_LEASE_KEY,
    )

    const firstClose = lease.close()
    expect(lease.close()).toBe(firstClose)
    await expect(firstClose).rejects.toThrow('connection lost')
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it.each(['', 'contains spaces', 'x'.repeat(201)])(
    'rejects the invalid lease key %j before reserving a connection',
    async (leaseKey) => {
      const harness = fakePool(vi.fn())
      await expect(
        acquirePostgresAdvisoryLease(harness.pool, leaseKey),
      ).rejects.toThrow('lease key is invalid')
      expect(harness.connect).not.toHaveBeenCalled()
    },
  )
})
