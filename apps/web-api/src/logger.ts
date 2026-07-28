import pino from 'pino'
import type { DestinationStream } from 'pino'

export const redactionPaths = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.url',
  'req.raw.url',
  'res.headers["set-cookie"]',
]

export const createLogger = (stream?: DestinationStream) =>
  pino(
    {
      level: 'info',
      redact: {
        paths: redactionPaths,
        censor: '[REDACTED]',
      },
    },
    stream,
  )
