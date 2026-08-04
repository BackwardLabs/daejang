import type { SourceRequestContext } from '../sources/wallet-source-store.js'

export const TAX_REPORT_MODEL_V1_MEDIA_TYPE =
  'application/vnd.giwa.tax-report-model.v1+json'
export const TAX_EVIDENCE_PACK_V1_MEDIA_TYPE =
  'application/vnd.giwa.tax-evidence-pack.v1+json'

export type TaxReportModelArtifact = {
  reportId: string
  artifactDigest: string
  mediaType: string
  canonicalJson: Uint8Array
}

export interface TaxReportModelReader {
  readonly durable: boolean
  getTaxReportModel(
    context: SourceRequestContext,
    reportId: string,
  ): Promise<TaxReportModelArtifact>
}

export type TaxEvidencePackArtifact = {
  reportId: string
  artifactDigest: string
  mediaType: string
  canonicalJson: Uint8Array
}

export interface TaxEvidencePackReader {
  readonly durable: boolean
  getTaxEvidencePack(
    context: SourceRequestContext,
    reportId: string,
  ): Promise<TaxEvidencePackArtifact>
}
