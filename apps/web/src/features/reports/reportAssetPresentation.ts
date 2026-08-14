import type {
  LedgerEventModel,
  LedgerPostingModel,
} from '../../api/productApi.ts'
import {
  formatUserFacingAssetSymbol,
  parseLedgerAsset,
} from '../ledger/ledgerPresentation.ts'
import type { TaxReportV2DetailModel } from './taxReportApi.ts'

export type ReportAssetPresentation = {
  symbol: string
  decimals?: number
  metadata: string
}

export type ReportAssetPresentations = Record<string, ReportAssetPresentation>

const unsafeSymbolPattern = /[\p{Cc}\p{Cf}\p{M}]/u

const safeSymbol = (posting: LedgerPostingModel) => {
  const presentation = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  const symbol = formatUserFacingAssetSymbol(presentation.symbol)
  if (
    unsafeSymbolPattern.test(symbol) ||
    symbol.length > 24 ||
    symbol === '미확인 토큰(스팸 의심)'
  ) {
    return null
  }
  return {
    symbol,
    ...(presentation.decimals === undefined
      ? {}
      : { decimals: presentation.decimals }),
    metadata: presentation.metadata ?? '원장 자산 메타데이터',
  }
}

const reportAssetBindings = (report: TaxReportV2DetailModel) => {
  const bindings = new Map<string, Set<string>>()
  const bind = (taxAssetId: string, ledgerAssetId: string) => {
    const assetIds = bindings.get(taxAssetId) ?? new Set<string>()
    assetIds.add(ledgerAssetId)
    bindings.set(taxAssetId, assetIds)
  }

  for (const row of [
    ...report.disposals,
    ...report.feeAssetDisposals,
    ...report.acquisitions,
    ...report.incomeRows,
  ]) {
    bind(row.taxAssetId, row.ledgerAssetId)
  }

  return bindings
}

export const buildReportAssetPresentations = (
  report: TaxReportV2DetailModel,
  ledgerItems: LedgerEventModel[],
): ReportAssetPresentations => {
  const byLedgerAssetId = new Map<string, ReportAssetPresentation>()
  for (const event of ledgerItems) {
    for (const posting of event.postings) {
      const presentation = safeSymbol(posting)
      if (presentation && !byLedgerAssetId.has(posting.assetId)) {
        byLedgerAssetId.set(posting.assetId, presentation)
      }
    }
  }

  const result: ReportAssetPresentations = {}
  const bindings = reportAssetBindings(report)
  const taxAssetIds = new Set([
    ...report.assetSummaries.map((asset) => asset.taxAssetId),
    ...bindings.keys(),
  ])

  for (const taxAssetId of taxAssetIds) {
    const candidates = [
      ...(bindings.get(taxAssetId) ?? []),
      taxAssetId,
    ]
    const matches = candidates
      .map((assetId) => byLedgerAssetId.get(assetId))
      .filter((value): value is ReportAssetPresentation => value !== undefined)

    const uniqueSymbols = new Set(matches.map((value) => value.symbol))
    if (matches.length > 0 && uniqueSymbols.size === 1) {
      const match = matches[0]!
      result[taxAssetId] =
        match.symbol === 'NATIVE' && /^asset:eip155:(?:1|10):native$/u.test(taxAssetId)
          ? { ...match, symbol: 'ETH' }
          : match
    }
  }

  return result
}
