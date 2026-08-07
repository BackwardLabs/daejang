import type { ReactNode } from 'react'

interface FeatureSectionProps {
  bullets: readonly string[]
  children?: ReactNode
  description: string
  eyebrow: string
  heading: string
  id: string
  imageAlt: string
  imagePosition?: 'left' | 'right'
  imageSrc: string
}

export function FeatureSection({
  bullets,
  children,
  description,
  eyebrow,
  heading,
  id,
  imageAlt,
  imagePosition = 'right',
  imageSrc,
}: FeatureSectionProps) {
  return (
    <section
      className={`feature-section ruled-section feature-section--image-${imagePosition}`}
      id={id}
      aria-labelledby={`${id}-title`}
    >
      <div className="feature-section__inner">
        <div className="feature-copy">
          <p className="section-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-title`}>{heading}</h2>
          <p className="feature-copy__description">{description}</p>
          <ul className="feature-list">
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          {children}
        </div>

        <figure className="product-preview">
          <img src={imageSrc} alt={imageAlt} width="675" height="496" />
        </figure>
      </div>
    </section>
  )
}
