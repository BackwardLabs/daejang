import { SourceOptionCard } from './SourceOptionCard.tsx'

const onboardingSteps = [
  {
    id: '01',
    title: '로그인 상태 확인',
    description: '유효한 세션과 현재 workspace 권한을 서버에서 확인합니다.',
  },
  {
    id: '02',
    title: '데이터 소스 등록',
    description: 'Upbit CSV 또는 EVM 지갑 주소 중 첫 소스를 등록합니다.',
  },
  {
    id: '03',
    title: '수집 작업 시작',
    description: '비동기 Job을 만들고 홈에서 진행 상태를 이어서 확인합니다.',
  },
] as const

export function OnboardingOverview() {
  return (
    <section className="onboardingSection" id="onboarding" aria-labelledby="onboarding-title">
      <div className="sectionHeading">
        <p className="eyebrow">USER ONBOARDING</p>
        <h2 id="onboarding-title">첫 데이터 수집까지 세 단계</h2>
        <p>
          온보딩 완료는 분석 완료가 아니라, 유효한 데이터 소스를 등록하고
          수집 작업을 시작한 시점입니다.
        </p>
      </div>

      <ol className="stepList">
        {onboardingSteps.map((step) => (
          <li key={step.id}>
            <span>{step.id}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="sourceSection" id="sources">
        <div>
          <p className="eyebrow">MVP DATA SOURCES</p>
          <h2>처음 지원하는 연결 방식</h2>
        </div>
        <div className="sourceGrid">
          <SourceOptionCard
            eyebrow="거래소"
            status="MVP"
            title="Upbit CSV"
            description="거래 내역 파일을 private storage에 업로드하고 서버 검증 후 수집을 시작합니다."
          />
          <SourceOptionCard
            eyebrow="개인 지갑"
            status="MVP"
            title="EVM 지갑 주소"
            description="지원 체인과 공개 주소를 등록합니다. private key나 seed phrase는 요청하지 않습니다."
          />
        </div>
      </div>
    </section>
  )
}
