import type {
  LedgerEventModel,
  LedgerPostingModel,
} from '../../api/productApi.ts'

const materialPostingRoles = new Set(['PRINCIPAL', 'INCOME'])

const transactionKey = (event: LedgerEventModel) => {
  if (
    event.transactionCoordinate !== 'EXACT' ||
    !event.chainId ||
    !event.transactionHash
  ) return `event:${event.eventId}`

  return `evm:${event.chainId}:${event.transactionHash.toLowerCase()}`
}

const representativeScore = (event: LedgerEventModel) => {
  const proofScore = event.actionProofId ? 1_000_000 : 0
  const resolutionScore = event.resolution === 'RESOLVED' ? 100_000 : 0
  const materialScore = event.postings.filter((posting) =>
    materialPostingRoles.has(posting.role),
  ).length * 100

  return proofScore + resolutionScore + materialScore + event.postings.length
}

const postingKey = (posting: LedgerPostingModel) => [
  posting.accountId,
  posting.assetId,
  posting.direction,
  posting.quantity,
  posting.role,
  posting.occurredAt,
].join('\u0000')

const mergePostings = (events: LedgerEventModel[]) => {
  const groups = new Map<string, Map<string, LedgerPostingModel[]>>()

  for (const event of events) {
    for (const posting of event.postings) {
      const key = postingKey(posting)
      let byEvent = groups.get(key)
      if (!byEvent) {
        byEvent = new Map()
        groups.set(key, byEvent)
      }
      const eventPostings = byEvent.get(event.eventId) ?? []
      if (!eventPostings.some(({ legId }) => legId === posting.legId)) {
        eventPostings.push(posting)
      }
      byEvent.set(event.eventId, eventPostings)
    }
  }

  const postings: LedgerPostingModel[] = []
  for (const byEvent of groups.values()) {
    let selected: LedgerPostingModel[] = []
    for (const eventPostings of byEvent.values()) {
      if (eventPostings.length > selected.length) selected = eventPostings
    }
    postings.push(...selected)
  }
  return postings
}

const byEffectiveAtDescending = (left: LedgerEventModel, right: LedgerEventModel) =>
  Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt)

export const projectLedgerTransactions = (events: LedgerEventModel[]) => {
  const groups = new Map<string, LedgerEventModel[]>()

  for (const event of events) {
    const key = transactionKey(event)
    const group = groups.get(key)
    if (group) group.push(event)
    else groups.set(key, [event])
  }

  const projections: LedgerEventModel[] = []
  for (const [projectionKey, group] of groups) {
    const ranked = [...group].sort((left, right) =>
      representativeScore(right) - representativeScore(left),
    )
    const representative = ranked[0]
    if (!representative) continue

    projections.push({
      ...representative,
      projectionKey,
      postings: mergePostings(ranked),
      sourceEvents: ranked.map(({ eventId, revisionId }) => ({ eventId, revisionId })),
      projectedActions: ranked
        .filter(({ actionProofId }) => actionProofId)
        .filter((event, index, proofEvents) =>
          proofEvents.findIndex(({ actionProofId }) => actionProofId === event.actionProofId) === index,
        )
        .map((event) => ({
          eventId: event.eventId,
          eventType: event.eventType,
          flowShape: event.flowShape,
          subtype: event.subtype,
          actionProofId: event.actionProofId!,
          actionProfileId: event.actionProfileId,
          actionProfileVersion: event.actionProfileVersion,
        })),
    })
  }

  return projections.sort(byEffectiveAtDescending)
}
