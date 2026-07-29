import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createRuntimeIndexerConfig,
  createRuntimeSubjectACL,
  ensureRuntimeIndexerView,
  privateObjectWriteEnvironment,
  finishSignalShutdown,
  releaseProcessLock,
  runRestartOperation,
  runSignalShutdown,
  tryAcquireProcessLock,
} from './host-backend.mjs'

test('limits the runtime indexer config to the JIT chain stores', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-test-'))
  const localSource = join(parent, 'local-indexer.json')
  const bulkSource = join(parent, 'bulk-indexer.json')
  const output = join(parent, 'indexer.runtime.json')
  try {
    writeFileSync(localSource, JSON.stringify({
      dataDir: '${EVM_INDEXER_DATA_DIR}',
      chains: [
        {
          name: 'ethereum-mainnet', sourceKind: 'verified-local', startBlock: 0,
          liveSource: 'geth-hook', livePath: '/geth',
        },
      ],
    }))
    writeFileSync(bulkSource, JSON.stringify({
      chains: [{
        name: 'optimism-mainnet-bulk-bedrock', sourceKind: 'sqd-portal',
        startBlock: 105235063, supplementalRpcUrl: '${SECRET_PROXY_URL}/rpc',
      }],
    }))
    createRuntimeIndexerConfig(localSource, bulkSource, output, join(parent, 'view'))
    const runtime = JSON.parse(readFileSync(output, 'utf8'))
    assert.deepEqual(
      runtime.chains.map((chain) => chain.name),
      ['ethereum-mainnet-tail', 'optimism-mainnet-bulk-bedrock-tail'],
    )
    assert.equal(runtime.dataDir, join(parent, 'view'))
    assert.equal(runtime.chains[0].sourceKind, 'remote-finalized-single-source')
    assert.equal(runtime.chains[0].startBlock, 25559129)
    assert.equal(runtime.chains[0].liveSource, undefined)
    assert.equal(runtime.chains[1].startBlock, 154465211)
    assert.equal(runtime.chains[1].supplementalRpcUrl, 'http://127.0.0.1:1')
    assert.equal(statSync(output).mode & 0o777, 0o600)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed when a required JIT indexer chain is missing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-test-'))
  const localSource = join(parent, 'local-indexer.json')
  const bulkSource = join(parent, 'bulk-indexer.json')
  const output = join(parent, 'indexer.runtime.json')
  try {
    writeFileSync(localSource, JSON.stringify({
      chains: [{ name: 'ethereum-mainnet' }],
    }))
    writeFileSync(bulkSource, JSON.stringify({ chains: [] }))
    assert.throws(
      () => createRuntimeIndexerConfig(localSource, bulkSource, output, join(parent, 'view')),
      /missing a required JIT chain/,
    )
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('creates a fail-closed read-only indexer view from exact stores', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-indexer-view-test-'))
  const root = join(parent, 'view')
  const ethereum = join(parent, 'ethereum')
  const optimism = join(parent, 'optimism')
  try {
    mkdirSync(ethereum)
    mkdirSync(optimism)
    ensureRuntimeIndexerView(root, {
      'ethereum-mainnet-tail': ethereum,
      'optimism-mainnet-bulk-bedrock-tail': optimism,
    })
    assert.equal(readlinkSync(join(root, 'ethereum-mainnet-tail')), ethereum)
    assert.equal(readlinkSync(join(root, 'optimism-mainnet-bulk-bedrock-tail')), optimism)
    assert.throws(
      () => ensureRuntimeIndexerView(root, { 'ethereum-mainnet-tail': optimism }),
      /changed unexpectedly/,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('rewrites only the local JIT ACL identity to the current service UID', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-test-'))
  const source = join(parent, 'subject-acl.json')
  const output = join(parent, 'subject-acl.runtime.json')
  try {
    writeFileSync(source, JSON.stringify({
      version: 1,
      grants: [
        { identity: 'uid:505', subjects: ['audit-public'] },
        { identity: 'spiffe://daejang/remote', subjects: ['subject-1'] },
      ],
    }))
    createRuntimeSubjectACL(source, output, 502)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      version: 1,
      grants: [
        { identity: 'uid:502', subjects: ['audit-public'] },
        { identity: 'spiffe://daejang/remote', subjects: ['subject-1'] },
      ],
    })
    assert.equal(statSync(output).mode & 0o777, 0o600)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed when the JIT ACL local identity is ambiguous', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-acl-test-'))
  const source = join(parent, 'subject-acl.json')
  const output = join(parent, 'subject-acl.runtime.json')
  try {
    writeFileSync(source, JSON.stringify({
      version: 1,
      grants: [
        { identity: 'uid:501', subjects: ['subject-1'] },
        { identity: 'uid:502', subjects: ['subject-2'] },
      ],
    }))
    assert.throws(
      () => createRuntimeSubjectACL(source, output, 502),
      /exactly one local UID grant/,
    )
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('omits the private object key ID when PDF encryption is disabled', () => {
  assert.deepEqual(privateObjectWriteEnvironment({}), {})
})

test('passes the private object key and its ID as one unit', () => {
  assert.deepEqual(privateObjectWriteEnvironment({
    PRIVATE_OBJECT_ENCRYPTION_KEY: 'base64-key',
  }), {
    PRIVATE_OBJECT_ENCRYPTION_KEY: 'base64-key',
    PRIVATE_OBJECT_ENCRYPTION_KEY_ID: 'primary',
  })
})

test('creates the runtime root before taking the first operation lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-test-'))
  const runtimeRoot = join(parent, 'fresh-runtime')
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./host-backend.mjs', import.meta.url)), 'stop'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIWA_HOST_RUNTIME_ROOT: runtimeRoot,
        },
      },
    )
    assert.equal(existsSync(join(runtimeRoot, 'supervisor')), true, result.stderr)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fails closed on a malformed process lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-lock-test-'))
  const lock = join(parent, 'operation.lock')
  try {
    writeFileSync(lock, '')
    assert.throws(
      () => tryAcquireProcessLock(lock, () => ({
        status: 0,
        stdout: 'test command',
      })),
      /Malformed backend lock requires manual removal/,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('only the lock owner can release a process lock', () => {
  const parent = mkdtempSync(join(tmpdir(), 'giwa-host-backend-owner-test-'))
  const lock = join(parent, 'operation.lock')
  try {
    const lockContent = tryAcquireProcessLock(lock, () => ({
      status: 0,
      stdout: 'test command',
    }))
    assert.throws(
      () => releaseProcessLock(lock, 'different owner'),
      /lock ownership changed unexpectedly/,
    )
    releaseProcessLock(lock, lockContent)
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('restart establishes pause before stopping or starting services', async () => {
  const events = []
  await runRestartOperation({
    prepare: () => events.push('prepare'),
    pause: () => events.push('pause'),
    stop: async () => events.push('stop'),
    start: async () => events.push('start'),
  })
  assert.deepEqual(events, ['prepare', 'pause', 'stop', 'start'])
})

test('signal shutdown waits for the active operation before serialized stop', async () => {
  const events = []
  let finishOperation
  const activeOperation = new Promise((resolve) => {
    finishOperation = resolve
  })
  const shutdown = runSignalShutdown({
    pause: () => events.push('pause'),
    activeOperation,
    stop: async () => events.push('stop'),
  })
  await Promise.resolve()
  assert.deepEqual(events, ['pause'])
  finishOperation()
  await shutdown
  assert.deepEqual(events, ['pause', 'stop'])
})

test('supervisor signal shutdown returns through its lock-release finally', () => {
  const exitCodes = []
  finishSignalShutdown({
    supervising: true,
    exitCode: 143,
    exit: (code) => exitCodes.push(code),
  })
  assert.deepEqual(exitCodes, [])
  assert.equal(process.exitCode, 143)
  process.exitCode = undefined
})
