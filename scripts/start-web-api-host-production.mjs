import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const entrypoint = resolve(
  process.env.GIWA_WEB_API_ENTRYPOINT ?? 'apps/web-api/dist/server.js',
)

await import(pathToFileURL(entrypoint).href)
