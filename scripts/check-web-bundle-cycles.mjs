import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDirectory = resolve(
  process.argv[2] ?? join(repositoryRoot, 'apps/web/dist/assets'),
)
const staticImportPatterns = [
  /(?:^|[;\n])\s*import\s*(?:[^"'();]*?from\s*)?["'](\.\/[^"']+\.js)["']/g,
  /(?:^|[;\n])\s*export\s*(?:\*|\{[^}]*\})\s*from\s*["'](\.\/[^"']+\.js)["']/g,
]

const files = (await readdir(assetsDirectory))
  .filter((file) => file.endsWith('.js'))
  .sort()
const fileNames = new Set(files)
const importsByFile = new Map()

for (const file of files) {
  const source = await readFile(join(assetsDirectory, file), 'utf8')
  const imports = new Set()

  for (const pattern of staticImportPatterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const importedFile = basename(match[1])
      if (fileNames.has(importedFile)) imports.add(importedFile)
    }
  }

  importsByFile.set(file, [...imports])
}

const visited = new Set()
const active = new Set()
const stack = []

function findCycle(file) {
  if (active.has(file)) {
    const cycleStart = stack.indexOf(file)
    return [...stack.slice(cycleStart), file]
  }
  if (visited.has(file)) return undefined

  visited.add(file)
  active.add(file)
  stack.push(file)

  for (const importedFile of importsByFile.get(file) ?? []) {
    const cycle = findCycle(importedFile)
    if (cycle) return cycle
  }

  stack.pop()
  active.delete(file)
  return undefined
}

for (const file of files) {
  const cycle = findCycle(file)
  if (!cycle) continue

  console.error('Static JavaScript chunk cycle detected:')
  console.error(cycle.join(' -> '))
  process.exitCode = 1
  break
}

if (!process.exitCode) {
  console.log(`Verified ${files.length} JavaScript chunks: no static import cycles.`)
}
