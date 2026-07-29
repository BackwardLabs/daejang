import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  decryptPrivateObject,
  encryptPrivateObject,
  type PrivateObjectKeyring,
} from './private-object-crypto.js'

describe('private object envelope key rotation', () => {
  it('decrypts an old key ID after the current write key changes', () => {
    const oldKey = Buffer.alloc(32, 1)
    const nextKey = Buffer.alloc(32, 2)
    const objectKey = 'upbit/subject/document.pdf'
    const contents = Buffer.from('%PDF-1.7 private')
    const oldKeyring: PrivateObjectKeyring = {
      currentKeyId: 'key-2026',
      keys: new Map([['key-2026', oldKey]]),
    }
    const envelope = encryptPrivateObject(contents, oldKeyring, objectKey)
    const rotatedKeyring: PrivateObjectKeyring = {
      currentKeyId: 'key-2027',
      keys: new Map([
        ['key-2026', oldKey],
        ['key-2027', nextKey],
      ]),
    }

    expect(decryptPrivateObject(envelope, rotatedKeyring, objectKey)).toEqual(contents)
    expect(() => decryptPrivateObject(envelope, {
      currentKeyId: 'key-2027',
      keys: new Map([['key-2027', nextKey]]),
    }, objectKey)).toThrow('key-2026')
  })

  it('uses the explicit legacy key ID for a GIWAOBJ1 envelope', () => {
    const legacyKey = Buffer.alloc(32, 3)
    const currentKey = Buffer.alloc(32, 4)
    const objectKey = 'upbit/subject/legacy.pdf'
    const contents = Buffer.from('%PDF-1.7 legacy')
    const nonce = Buffer.alloc(12, 5)
    const cipher = createCipheriv('aes-256-gcm', legacyKey, nonce)
    cipher.setAAD(Buffer.from(objectKey))
    const envelope = Buffer.concat([
      Buffer.from('GIWAOBJ1'),
      nonce,
      cipher.update(contents),
      cipher.final(),
      cipher.getAuthTag(),
    ])

    expect(decryptPrivateObject(envelope, {
      currentKeyId: 'current',
      legacyKeyId: 'legacy',
      keys: new Map([
        ['current', currentKey],
        ['legacy', legacyKey],
      ]),
    }, objectKey)).toEqual(contents)
  })
})
