import type { ComponentProps, MouseEvent } from 'react'

import { navigateTo } from '../auth/navigation.ts'

type AppLinkProps = Omit<ComponentProps<'a'>, 'href'> & {
  href: `/${string}`
  replace?: boolean
}

export function AppLink({
  href,
  onClick,
  replace = false,
  target,
  ...props
}: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target && target !== '_self')
    ) return

    event.preventDefault()
    navigateTo(href, replace)
  }

  return <a {...props} href={href} target={target} onClick={handleClick} />
}
