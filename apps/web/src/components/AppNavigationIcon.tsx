import type { SVGProps } from 'react'

export type AppNavigationIconName =
  | 'dashboard'
  | 'ledger'
  | 'reports'
  | 'settings'
  | 'sources'

const iconProps: SVGProps<SVGSVGElement> = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 1.5,
  viewBox: '0 0 24 24',
}

export function AppNavigationIcon({
  name,
}: {
  name: AppNavigationIconName
}) {
  if (name === 'dashboard') {
    return (
      <svg {...iconProps}>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    )
  }

  if (name === 'ledger') {
    return (
      <svg {...iconProps}>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4V2h6v2" />
        <path d="M9 10h6M9 14h6M9 18h6" />
      </svg>
    )
  }

  if (name === 'reports') {
    return (
      <svg {...iconProps}>
        <path d="M3 3h18v13H3z" />
        <path d="M8 21l4-5 4 5" />
        <path d="M7 12V9M12 12V6M17 12V8" />
      </svg>
    )
  }

  if (name === 'sources') {
    return (
      <svg {...iconProps}>
        <path d="M20 7V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15" />
        <path d="M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7" />
        <path d="M16 14h4" />
      </svg>
    )
  }

  return (
    <svg {...iconProps}>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="13" cy="18" r="2" />
    </svg>
  )
}
