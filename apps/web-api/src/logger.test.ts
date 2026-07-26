import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLogger } from './logger.js'

describe('API logger redaction', () => {
  it('removes request and response credential sentinels from captured logs', async () => {
    const stream = new PassThrough()
    let output = ''
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const logger = createLogger(stream)

    logger.info({
      req: {
        headers: {
          cookie: 'cookie-secret-sentinel',
          authorization: 'authorization-secret-sentinel',
        },
      },
      res: {
        headers: {
          'set-cookie': 'set-cookie-secret-sentinel',
        },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('cookie-secret-sentinel')
    expect(output).not.toContain('authorization-secret-sentinel')
    expect(output).not.toContain('set-cookie-secret-sentinel')
  })
})
