import type { MouseEventHandler } from 'react'

type BrandProps = {
  href?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}

export function Brand({ href = '#top', onClick }: BrandProps) {
  return (
    <a className="brand" href={href} onClick={onClick} aria-label="Daejang 홈">
      <img
        className="brand__mark"
        src="/daejang-logo.svg"
        alt=""
        width="27"
        height="30"
      />
      <span>Daejang</span>
    </a>
  )
}
