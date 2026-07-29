import { describe, expect, it } from 'vitest'

import { validatePdfContents } from './pdf-validation.js'

describe('validatePdfContents', () => {
  it('accepts an unencrypted PDF envelope', () => {
    const contents = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

    expect(validatePdfContents(contents)).toBeUndefined()
  })

  it.each([
    '/Encrypt 2 0 R',
    '/En#63rypt 2 0 R',
  ])('rejects the PDF encryption dictionary key %s', (encryptEntry) => {
    const contents = Buffer.from(`%PDF-1.7\ntrailer\n<< ${encryptEntry} >>\n%%EOF\n`)

    expect(validatePdfContents(contents)).toBe('ENCRYPTED_PDF')
  })

  it('does not confuse a longer PDF name with the Encrypt key', () => {
    const contents = Buffer.from('%PDF-1.7\n<< /Encrypting false >>\n%%EOF\n')

    expect(validatePdfContents(contents)).toBeUndefined()
  })

  it.each([
    Buffer.from('not-a-pdf'),
    Buffer.from('%PDF-1.7\ntruncated'),
  ])('rejects a damaged PDF envelope', (contents) => {
    expect(validatePdfContents(contents)).toBe('INVALID_PDF')
  })
})
