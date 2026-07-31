export const reportsUiModes = ['product', 'giwa28-demo'] as const

export type ReportsUiMode = (typeof reportsUiModes)[number]

export function resolveReportsUiMode(
  configuredMode: string | undefined,
): ReportsUiMode {
  if (configuredMode === undefined) return 'product'
  if (reportsUiModes.includes(configuredMode as ReportsUiMode)) {
    return configuredMode as ReportsUiMode
  }

  throw new Error(
    `VITE_REPORTS_UI_MODE must be one of: ${reportsUiModes.join(', ')}`,
  )
}

export function reportsPageEntry(mode: ReportsUiMode) {
  return mode === 'giwa28-demo'
    ? './src/features/reports/Giwa28DemoReportPage.tsx'
    : './src/features/reports/ProductReportPage.tsx'
}
