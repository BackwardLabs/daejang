import type { ReactNode } from 'react'
import './page-header.css'

export type PageHeaderTone = 'dashboard' | 'product' | 'workspace'

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
  tone,
}: {
  actions?: ReactNode
  description: string
  eyebrow: string
  title: string
  tone: PageHeaderTone
}) {
  return (
    <header className={`page-header page-header--${tone}`}>
      <div className="page-header__copy">
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
