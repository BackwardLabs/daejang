import type { ReactNode } from 'react'

type LegalDocumentContentProps = {
  className?: string
  content: string
}

function plainInlineMarkdown(value: string) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

export function LegalDocumentContent({
  className,
  content,
}: LegalDocumentContentProps) {
  const nodes: ReactNode[] = []
  let paragraph: string[] = []
  let unorderedItems: string[] = []
  let orderedItems: string[] = []
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    nodes.push(
      <p key={`paragraph-${key++}`}>
        {plainInlineMarkdown(paragraph.join(' '))}
      </p>,
    )
    paragraph = []
  }

  const flushLists = () => {
    if (unorderedItems.length > 0) {
      nodes.push(
        <ul key={`unordered-${key++}`}>
          {unorderedItems.map((item, index) => (
            <li key={`${index}-${item}`}>{plainInlineMarkdown(item)}</li>
          ))}
        </ul>,
      )
      unorderedItems = []
    }

    if (orderedItems.length > 0) {
      nodes.push(
        <ol key={`ordered-${key++}`}>
          {orderedItems.map((item, index) => (
            <li key={`${index}-${item}`}>{plainInlineMarkdown(item)}</li>
          ))}
        </ol>,
      )
      orderedItems = []
    }
  }

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      flushLists()
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushLists()
      const headingText = plainInlineMarkdown(heading[2] ?? '')
      const headingLevel = heading[1]?.length ?? 1
      nodes.push(
        headingLevel <= 2
          ? <h2 key={`heading-${key++}`}>{headingText}</h2>
          : <h3 key={`heading-${key++}`}>{headingText}</h3>,
      )
      continue
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (orderedItems.length > 0) flushLists()
      unorderedItems.push(unordered[1] ?? '')
      continue
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (unorderedItems.length > 0) flushLists()
      orderedItems.push(ordered[1] ?? '')
      continue
    }

    flushLists()
    paragraph.push(line)
  }

  flushParagraph()
  flushLists()

  return (
    <div className={className}>
      {nodes.length > 0 ? nodes : <p>문서 본문이 비어 있습니다</p>}
    </div>
  )
}
