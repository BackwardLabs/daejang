interface SourceOptionCardProps {
  description: string
  eyebrow: string
  status: string
  title: string
}

export function SourceOptionCard({
  description,
  eyebrow,
  status,
  title,
}: SourceOptionCardProps) {
  return (
    <article className="sourceCard">
      <div className="sourceCardHeader">
        <p>{eyebrow}</p>
        <span>{status}</span>
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  )
}
