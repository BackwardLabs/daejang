import { collectionSupport } from '../landing-content.ts'

type CollectionRangeProps = {
  range: {
    readonly start: string
    readonly end: string
  }
}

function kstDateTime(value: string) {
  return `${value.replace(' ', 'T')}+09:00`
}

function CollectionRange({ range }: CollectionRangeProps) {
  return (
    <div className="feature-support__range">
      <span className="feature-support__range-dates">
        <time dateTime={kstDateTime(range.start)}>{range.start}</time>
        <span className="feature-support__range-arrow" aria-hidden="true">→</span>
        <time dateTime={kstDateTime(range.end)}>{range.end}</time>
      </span>
    </div>
  )
}

export function CollectionSupport() {
  return (
    <section
      className="feature-support"
      aria-labelledby="collect-support-title"
    >
      <h3 id="collect-support-title">현재 지원 범위</h3>
      <dl className="feature-support__summary">
        <div className="feature-support__row">
          <dt>거래 자료</dt>
          <dd>
            <ul className="feature-support__items" aria-label="지원 거래 자료">
              {collectionSupport.documentTypes.map((documentType) => (
                <li key={documentType}>{documentType}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <div className="feature-support__period">
        <div className="feature-support__period-heading">
          <h4>네트워크</h4>
          <p className="feature-support__timezone">{collectionSupport.timezone}</p>
        </div>
        <p className="feature-support__period-note">
          지원 기간은 지속적으로 확장 중입니다.
        </p>
        <ul
          className="feature-support__period-list"
          aria-label="지원 네트워크와 수집 기간"
        >
          {collectionSupport.networks.map((network) => {
            const headingId = `collection-period-${network.id}`
            return (
              <li
                className="feature-support__period-card"
                aria-labelledby={headingId}
                key={network.id}
              >
                <h5 id={headingId}>{network.name}</h5>
                <div className="feature-support__range-list">
                  {network.collectedRanges.map((range) => (
                    <CollectionRange
                      key={`collected-${range.start}-${range.end}`}
                      range={range}
                    />
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
