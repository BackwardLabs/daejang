import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const pretendardFontUrl = new URL(
  '../../../assets/fonts/Pretendard-Regular.ttf',
  import.meta.url,
)

export const pretendardFontSha256 =
  '6d0af5258997aec7354a6e340fc2325ba321c410ca48b3af858c8c3d6e92a324'

let cachedFont: Promise<Buffer> | undefined

export function loadPretendardFont(): Promise<Buffer> {
  cachedFont ??= readFile(pretendardFontUrl).then((bytes) => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== pretendardFontSha256) {
      throw new Error(
        'Pretendard PDF font digest does not match the pinned asset',
      )
    }
    return bytes
  })
  return cachedFont
}
