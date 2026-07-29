import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const legacyMagic = Buffer.from('GIWAOBJ1', 'ascii')
const magic = Buffer.from('GIWAOBJ2', 'ascii')
const nonceBytes = 12
const tagBytes = 16

export type PrivateObjectKeyring = {
  currentKeyId: string
  legacyKeyId?: string
  keys: ReadonlyMap<string, Buffer>
}

const keyFor = (keyring: PrivateObjectKeyring, keyId: string) => {
  const key = keyring.keys.get(keyId)
  if (!key || key.length !== 32) {
    throw new Error(`Private object encryption key ${keyId} is unavailable`)
  }
  return key
}

export const encryptPrivateObject = (
  contents: Buffer,
  keyring: PrivateObjectKeyring,
  objectKey: string,
) => {
  const keyId = Buffer.from(keyring.currentKeyId, 'utf8')
  if (keyId.length === 0 || keyId.length > 255) {
    throw new Error('Private object encryption key ID is invalid')
  }
  const key = keyFor(keyring, keyring.currentKeyId)
  const nonce = randomBytes(nonceBytes)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(objectKey, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()])
  return Buffer.concat([
    magic,
    Buffer.from([keyId.length]),
    keyId,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ])
}

export const decryptPrivateObject = (
  envelope: Buffer,
  keyring: PrivateObjectKeyring,
  objectKey: string,
) => {
  let keyId = keyring.legacyKeyId ?? keyring.currentKeyId
  let nonceStart = magic.length
  if (envelope.subarray(0, magic.length).equals(magic)) {
    const keyIdLength = envelope[magic.length] ?? 0
    if (keyIdLength === 0) throw new Error('Private object envelope is invalid')
    const keyIdStart = magic.length + 1
    keyId = envelope.subarray(keyIdStart, keyIdStart + keyIdLength).toString('utf8')
    nonceStart = keyIdStart + keyIdLength
  } else if (!envelope.subarray(0, legacyMagic.length).equals(legacyMagic)) {
    throw new Error('Private object envelope is invalid')
  }
  const minimumBytes = nonceStart + nonceBytes + tagBytes
  if (envelope.length < minimumBytes) throw new Error('Private object envelope is invalid')
  const key = keyFor(keyring, keyId)
  const ciphertextStart = nonceStart + nonceBytes
  const tagStart = envelope.length - tagBytes
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    envelope.subarray(nonceStart, ciphertextStart),
  )
  decipher.setAAD(Buffer.from(objectKey, 'utf8'))
  decipher.setAuthTag(envelope.subarray(tagStart))
  return Buffer.concat([
    decipher.update(envelope.subarray(ciphertextStart, tagStart)),
    decipher.final(),
  ])
}
