import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const magic = Buffer.from('GIWAOBJ1', 'ascii')
const nonceBytes = 12
const tagBytes = 16

export const encryptPrivateObject = (
  contents: Buffer,
  key: Buffer,
  objectKey: string,
) => {
  if (key.length !== 32) throw new Error('Private object encryption key is invalid')
  const nonce = randomBytes(nonceBytes)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(objectKey, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()])
  return Buffer.concat([magic, nonce, ciphertext, cipher.getAuthTag()])
}

export const decryptPrivateObject = (
  envelope: Buffer,
  key: Buffer,
  objectKey: string,
) => {
  if (key.length !== 32) throw new Error('Private object encryption key is invalid')
  const minimumBytes = magic.length + nonceBytes + tagBytes
  if (
    envelope.length < minimumBytes ||
    !envelope.subarray(0, magic.length).equals(magic)
  ) {
    throw new Error('Private object envelope is invalid')
  }
  const nonceStart = magic.length
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
