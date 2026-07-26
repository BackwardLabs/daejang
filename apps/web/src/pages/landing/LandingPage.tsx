import { FaqSection } from './components/FaqSection.tsx'
import { FeatureSection } from './components/FeatureSection.tsx'
import { FinalCta } from './components/FinalCta.tsx'
import { HeroSection } from './components/HeroSection.tsx'
import { LandingFooter } from './components/LandingFooter.tsx'
import { LandingHeader } from './components/LandingHeader.tsx'
import { ProductFlow } from './components/ProductFlow.tsx'
import { SourceJourney } from './components/SourceJourney.tsx'
import { ValueProposition } from './components/ValueProposition.tsx'

const collectActions = [
  { href: '#how-it-works', label: '수집 흐름 보기', variant: 'primary' },
  { href: '#faq-support', label: '지원 범위', variant: 'secondary' },
] as const

export function LandingPage() {
  return (
    <div className="landing-page" id="top">
      <LandingHeader />
      <main>
        <HeroSection />
        <SourceJourney />
        <ValueProposition />
        <ProductFlow />
        <FeatureSection
          id="collect"
          eyebrow="COLLECT & NORMALIZE"
          heading={'거래소와 개인지갑 기록,\n한곳에서'}
          description="거래내역 문서나 지갑 주소를 등록하고 수집 기간과 지원 범위를 확인합니다."
          bullets={[
            '가져온 거래내역 원본과 정리 결과를 따로 보관',
            '수집 전에 기간과 지원 범위를 확인',
            '수집 중에도 처리 상태를 바로 확인',
          ]}
          actions={collectActions}
          imageSrc="/landing/data-connection.png"
          imageAlt="대장 장부 만들기 화면에서 데이터 소스 연결 단계를 보여주는 제품 화면"
        />
        <FeatureSection
          id="review"
          eyebrow="REVIEW & REPORT"
          heading={'계산 결과 옆에\n판단 근거'}
          description="연결 상태와 가격, Lot, 대사 과정에서 확인할 항목만 모아 보고, 판단을 반영해 보고서를 다시 계산합니다."
          bullets={[
            '확인할 항목마다 이유를 함께 표시',
            '사용자 판단을 계산 기준에 반영',
            '같은 입력으로 보고서를 다시 생성',
          ]}
          imageSrc="/landing/review-report.png"
          imageAlt="대장의 검토 반영 결과와 보고서 생성 단계를 보여주는 제품 화면"
          imagePosition="left"
        />
        <FaqSection />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  )
}
