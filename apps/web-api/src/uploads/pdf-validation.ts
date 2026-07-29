export type PdfValidationFailure = 'ENCRYPTED_PDF' | 'INVALID_PDF'

const isPdfWhitespace = (value: number) =>
  value === 0x00 ||
  value === 0x09 ||
  value === 0x0a ||
  value === 0x0c ||
  value === 0x0d ||
  value === 0x20

const isPdfDelimiter = (value: number) =>
  value === 0x28 ||
  value === 0x29 ||
  value === 0x3c ||
  value === 0x3e ||
  value === 0x5b ||
  value === 0x5d ||
  value === 0x7b ||
  value === 0x7d ||
  value === 0x2f ||
  value === 0x25

const hexValue = (value: number) => {
  if (value >= 0x30 && value <= 0x39) return value - 0x30
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10
  return undefined
}

const containsPdfName = (contents: Buffer, expected: string) => {
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x2f) continue

    const name: number[] = []
    for (let cursor = index + 1; cursor < contents.length; cursor += 1) {
      const value = contents[cursor] as number
      if (isPdfWhitespace(value) || isPdfDelimiter(value)) break
      if (value === 0x23 && cursor + 2 < contents.length) {
        const high = hexValue(contents[cursor + 1] as number)
        const low = hexValue(contents[cursor + 2] as number)
        if (high !== undefined && low !== undefined) {
          name.push(high * 16 + low)
          cursor += 2
          if (name.length > expected.length) break
          continue
        }
      }
      name.push(value)
      if (name.length > expected.length) break
    }

    if (Buffer.from(name).toString('latin1') === expected) return true
  }
  return false
}

export const validatePdfContents = (
  contents: Buffer,
): PdfValidationFailure | undefined => {
  if (
    contents.length < 8 ||
    contents.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !contents.subarray(Math.max(0, contents.length - 1_024)).includes(Buffer.from('%%EOF'))
  ) {
    return 'INVALID_PDF'
  }

  // The Encrypt entry is an unencrypted trailer/xref-stream dictionary key.
  // PDF names may encode characters as #xx, so compare decoded name tokens.
  if (containsPdfName(contents, 'Encrypt')) return 'ENCRYPTED_PDF'

  return undefined
}
