# Daejang Web Design

## Source of truth

- 상태: **Active**
- 마지막 갱신: `2026-07-26`
- 적용 범위: 공개 랜딩, 인증·회원가입, 온보딩, workspace 대시보드, 데이터 소스 등록, 수집 진행, 장부 검토, 보고서
- 구현 기준: 이 문서의 공통 제품 규칙을 우선하고, 화면별 Figma와 flow 문서는 해당 화면의 구조·콘텐츠 근거로 사용한다.
- 확인한 근거:
  - [제품 Figma — GIWA-70 Frontend Common Template](https://www.figma.com/design/ugpKU5ACV3biVhVQbmz6wr/daejang-web?node-id=1077-2448)
  - [랜딩 Figma — Layout v6](https://www.figma.com/design/ugpKU5ACV3biVhVQbmz6wr/daejang-web?node-id=969-448)
  - [`docs/00-web-app-technical-spec.md`](docs/00-web-app-technical-spec.md)
  - [`docs/01-user-onboarding.md`](docs/01-user-onboarding.md)
  - [`docs/02-data-source-collection.md`](docs/02-data-source-collection.md)
  - 현재 React 랜딩과 `apps/web/src/styles.css`

제품 화면은 `GIWA-70 Frontend Common Template`의 app shell, breakpoint, reusable pattern, component variant를 기준판으로 사용한다. Figma와 이 문서가 충돌하면 구현자가 임의로 선택하지 않고 `DESIGN.md`를 먼저 갱신한다.

### Implementation quick reference

| 항목 | 기본 계약 |
| --- | --- |
| Font | `Pretendard Variable`, weight `400·500·600·700` |
| Desktop | `>=1280px`, sidebar `236px`, page padding `32px`, content max `1200px` |
| Tablet | `768–1279px`, icon sidebar `72px`, 8-column grid, padding `24px` |
| Mobile | `<768px`, top app bar + bottom navigation `64px`, padding `20px` |
| Primary action | page header당 주홍색 action 1개 |
| Control | 높이 `40px`, 최소 pointer target `44×44px` |
| Card | radius `12–16px`, `Border/Subtle`, 기본 shadow 없음 |
| State | `Empty · Loading · Error` 공용 variant 우선 |
| Screen pattern | `Dashboard · List/Table · Detail/Evidence · Form/Connection` 중 하나 사용 |
| Required checks | lint, typecheck, component test, build, desktop·mobile visual check |

## Brand

- 성격: precise, restrained, product-first, dependable
- 목표 인상: 세무·장부 제품에 필요한 정확성, 신뢰, 가독성
- 브랜드 표기: 공개 화면과 제품 shell 모두 심볼 + `Daejang`을 기본으로 한다. 화면 제목과 메뉴는 한국어를 사용한다.
- 신뢰 신호: 원본 보존, 처리 상태, 판단 근거, revision, 보고서 재현 가능성을 화면에서 확인할 수 있어야 한다.
- 피할 것:
  - 넓은 gradient와 반복되는 pastel surface
  - 근거 없는 성공 표현과 장식적인 상태 색상
  - 과도한 radius, glassmorphism, 무거운 shadow
  - `대장`, `Daejang`, 오탈자 표기의 혼용

## Product goals

- 거래소 거래내역 문서와 개인지갑 기록을 한 workspace에서 수집한다.
- 서로 다른 원본을 정규화하고, 검토할 항목과 계산 근거를 연결한다.
- 수집부터 revision과 보고서까지 현재 상태와 다음 동작을 명확히 보여 준다.
- 긴 작업은 background Job으로 처리하고 사용자가 다른 화면을 계속 사용할 수 있게 한다.

비목표:

- Frontend에서 원본 중복, 세무 계산 또는 source coverage를 임의로 확정하지 않는다.
- 자동 처리 결과를 법적·세무적으로 확정된 결과처럼 표현하지 않는다.
- API Key·Secret, 개인키, seed phrase를 기본 입력으로 요구하지 않는다.

성공 신호:

- 사용자가 현재 단계, 남은 검토 항목과 복구 동작을 한 화면에서 이해한다.
- 새로고침 후에도 진행 중 Job과 입력 가능한 상태가 복구된다.
- 동일 입력과 판단 기준으로 보고서를 다시 생성할 수 있다.

## Personas and jobs

- 주요 사용자: 여러 거래소·지갑 기록을 정리해야 하는 디지털 자산 보유자와 실무 검토자
- 핵심 작업:
  - 이용약관·개인정보 내용을 확인하고 계정을 시작한다.
  - 거래소 문서 또는 공개 지갑 주소와 수집 기간을 등록한다.
  - 수집·정규화·계산의 진행 상태와 오류를 확인한다.
  - 자동 확정할 수 없는 사실관계를 검토한다.
  - 근거와 revision이 연결된 보고서를 생성한다.
- 사용 맥락: 데스크톱 중심의 집중 작업, 표와 숫자 비교, 장시간 Job 상태 확인

## Information architecture

공개 영역:

- 랜딩
- 로그인·회원가입
- 이용약관·개인정보 처리방침

제품 영역의 기본 navigation:

- 대시보드
- 장부 작업
- 보고서
- 데이터 소스
- 설정

핵심 화면 계층:

1. 페이지 제목과 현재 workspace·기간
2. 현재 상태와 가장 중요한 다음 동작
3. 요약 수치 또는 진행 단계
4. 상세 목록·표·검토 근거
5. 보조 설명, 정책 또는 기술 정보

제품 shell의 고정 영역:

- Desktop: `236px` sidebar + fluid main, main 내부 최대 본문 폭 `1200px`
- Tablet: `72px` 축소 sidebar + 8-column content grid
- Mobile: top app bar + bottom navigation + single-column content
- Top utility 영역: breadcrumb, 동기화 상태, 과세연도, profile처럼 화면 전반에 영향을 주는 정보
- Page header: eyebrow, 제목, 한 줄 설명, 중립 보조 action과 주홍색 주요 action 1개

라우팅과 실제 메뉴 노출은 권한과 API 계약이 정해진 뒤 구현한다. 존재하지 않는 route를 디자인만으로 확정하지 않는다.

## Design principles

1. **상태보다 다음 동작을 명확히 한다.** 진행 중, 검토 필요, 실패 상태에는 사용자가 할 수 있는 동작을 함께 둔다.
2. **결과 옆에 근거를 둔다.** 계산값과 원본·Observation·Event·Posting·revision의 연결을 멀리 분리하지 않는다.
3. **원본과 사용자 판단을 구분한다.** 수정 가능한 판단과 변경되지 않는 원본을 같은 입력처럼 보이게 하지 않는다.
4. **밀도는 높이되 위계는 단순하게 유지한다.** 표와 숫자는 조밀하게, 장식과 색은 제한적으로 사용한다.
5. **Frontend가 모르는 사실은 단정하지 않는다.** 예상값, 검증 중, 일부 지원 상태를 정확히 표시한다.

## Visual language

### Color

제품 UI는 Figma의 `GIWA Web / Color` collection에서 `Dashboard Light` mode를 사용한다.

| Figma variable | 값 | 기본 용도 |
| --- | --- | --- |
| `Background/Canvas` | `#FFFFFF` | 제품 canvas |
| `Background/Surface` | `#FFFFFF` | 기본 panel |
| `Background/Surface Raised` | `#F7F7F8` | 떠 있는 보조 영역 |
| `Background/Subtle` | `#F3F4F6` | table header, help, 선택 배경 |
| `Background/Inverse` | `#1A1A1A` | active navigation, 핵심 역상 panel |
| `Text/Primary` | `#1A1A1A` | 제목, 핵심 숫자, 기본 본문 |
| `Text/Secondary` | `#5F6368` | 설명과 보조 본문 |
| `Text/Muted` | `#8A8F98` | metadata, 비활성 label |
| `Text/On Inverse` | `#FFFFFF` | 역상 surface의 텍스트 |
| `Accent/Primary` | `#E8622A` | 주요 action, active icon |
| `Accent/Bright` | `#F4743B` | 강조 표식, chart highlight |
| `Accent/Deep` | `#B64317` | accent의 진한 텍스트·stroke |
| `Border/Default` | `#D9DCE1` | field와 명확한 경계 |
| `Border/Subtle` | `#ECEEF1` | card, table row, shell 구분 |
| `Status/Positive` | `#16794C` | 완료·정상 |
| `Status/Warning` | `#A86800` | 검토 필요·주의 |
| `Status/Negative` | `#DC2626` | 실패·파괴적 동작 |

자산 구분이 필요한 chart와 legend에서만 `Asset/ETH`, `Asset/BTC`, `Asset/USDC`, `Asset/ARB`, `Asset/Other` 변수를 사용한다. Mineral Orange는 브랜드와 주요 행동을 위한 색이며 성공·오류 의미를 대신하지 않는다. 상태는 항상 icon 또는 텍스트 label을 함께 제공한다.

랜딩의 CSS token은 현재 `apps/web/src/styles.css`에 유지하되 제품 token과 같은 이름으로 별도 값을 중복 선언하지 않는다.

### Typography and font delivery

모든 제품 텍스트는 `Pretendard Variable`을 사용한다.

- 로컬 파일: `apps/web/public/fonts/PretendardVariable.woff2`
- 형식: WOFF2 TrueType Variable Font
- 확인 버전: `1.20250`
- 파일 크기: `2,057,688 bytes`
- CSS weight axis: `45–920`
- 제품에서 사용하는 weight: `400`, `500`, `600`, `700`
- 로딩: `font-display: swap`, HTML에서 같은 파일을 preload
- fallback: `Pretendard`, Apple system font, `Segoe UI`, sans-serif
- 라이선스: SIL Open Font License 1.1, `apps/web/public/fonts/Pretendard-LICENSE.txt`

Figma 기준판의 text layer가 `Noto Sans KR`로 표시되더라도 이는 Figma 작업 환경의 font 상태이며 구현 font 계약이 아니다. 실제 웹 구현과 새로운 제품 component는 Pretendard를 사용한다.

브라우저가 임의의 bold·italic을 합성하지 않도록 `font-synthesis: none`을 유지한다. 제품 UI에서 italic은 사용하지 않는다. 폼 control은 반드시 전역 font를 상속해야 한다.

Marketing scale:

| 역할 | 크기 / 행간 | 굵기 |
| --- | --- | --- |
| Hero | `56 / 60` | `700` |
| Section XL | `40 / 44` | `700` |
| Section L | `32 / 36` | `700` |
| Card title | `24 / 32` | `600` |
| Body L | `18 / 30` | `400` |
| Body M | `16 / 26` | `400` |
| Label M | `14 / 20` | `500` |
| Eyebrow | `12 / 18` | `600` |

Product scale:

| 역할 | 크기 / 행간 | 굵기 |
| --- | --- | --- |
| Page title | `28 / 36` | `700` |
| Mobile page title | `20 / 28` | `700` |
| Section / panel title | `14 / 20` | `600–700` |
| Body / description | `13 / 20` | `400` |
| Navigation | `14 / 20` | `600` |
| Button / control label | `13 / 18` | `600` |
| Dense data / table | `12 / 18` | `400–600` |
| Caption / metadata | `11 / 16` | `400` |
| KPI numeric | `24 / 32` | `700` |

- 제목 자간은 `-0.02em` 전후, 본문은 기본 자간을 사용한다.
- 한국어 문장은 `word-break: keep-all`을 우선하되 table cell과 identifier에는 적용하지 않는다.
- chart axis처럼 반복되는 비상호작용 보조 정보에 한해 `10 / 14`를 허용한다. 핵심 상태, 금액, table cell, action label에는 사용하지 않는다.
- 금액·수량·날짜를 비교하는 열에는 `font-variant-numeric: tabular-nums`를 사용한다.
- 숫자와 단위 사이, 날짜 형식과 소수점 자릿수는 같은 화면에서 일관되게 유지한다.

### Spacing and layout

- 기본 spacing 단위: `4px`
- Figma variable scale: `4, 8, 12, 16, 24, 32, 48, 72, 96`
- 공개 랜딩 기준 frame: `1512px`
- 랜딩 넓은 content: `1352px`, desktop 좌우 `80px`
- 제품 desktop 기준 frame: `1440×1024`, 적용 구간 `>=1280px`
- Desktop shell: sidebar `236px`, fluid main, page padding `32px`
- Tablet `768–1279px`: sidebar `72px`, 8-column grid, page padding `24px`
- Mobile `<768px`: top app bar + bottom navigation, single column, page padding `20px`
- 제품 main의 최대 본문 폭: `1200px`
- grid gap: `16–24px`; dashboard KPI grid는 `12px` compact gap을 허용한다.
- 정보 panel 내부 padding: `18–24px`
- form field 사이: `16px`, section 사이: `32–40px`
- 긴 form은 한 열을 기본으로 하고 연관된 짧은 입력만 같은 행에 둔다.
- 긴 table은 column을 임의로 숨기기보다 가로 scroll을 기본으로 한다.

### Shape, border and elevation

- Figma radius variable: `4, 8, 10, 16, 18, Full(999)`
- 제품 card radius: `12–16px`; 공용 pattern card는 `14px`, app shell과 큰 container는 `16px`
- control radius: `8–10px`; badge·공개 랜딩 CTA만 pill을 허용한다.
- 기본 panel: `1px solid Border/Subtle`, field처럼 명확한 경계는 `Border/Default`, shadow 없음
- dropdown·popover·modal처럼 실제로 떠 있는 layer에만 낮은 shadow를 사용한다.
- 제품 preview shadow: `0 14px 28px rgba(16, 16, 18, 0.12)`
- table row와 form 영역을 모두 카드로 감싸 중첩 border를 만들지 않는다.

### Motion and imagery

- hover·focus transition은 `120–180ms` 안에서 opacity, color, transform만 사용한다.
- 진행률을 제외한 반복 animation은 사용하지 않는다.
- `prefers-reduced-motion`에서는 smooth scroll과 transition을 제거한다.
- 공개 랜딩은 실제 제품 화면의 3x Figma export를 사용한다. 실제 앱 화면은 raster screenshot이 아니라 React component로 구현한다.

## Components

### Product shell

- Desktop sidebar: `236×1024px`; 내부 폭 `204px`, 좌우 padding `16px`, profile·help 영역 높이 `56px`
- Sidebar navigation: `Sidebar / App Nav Item` component set을 사용한다. `Item = Dashboard | Ledger | Report | Data source | Settings`, `State = Default | Active` variant를 조합한다.
- Navigation item: `204×44px`; active는 inverse surface + 주홍색 icon + 흰 label, badge count는 상태와 분리된 보조 정보로 표시한다.
- Tablet sidebar: `72px`로 축소하고 icon과 accessible name을 유지한다.
- Mobile navigation: `64px` bottom navigation을 사용하고 desktop sidebar를 함께 노출하지 않는다.
- Top utility bar: breadcrumb, 동기화 상태, 과세연도, profile처럼 전역 맥락만 둔다.
- Page header: 제목, 짧은 설명, neutral 보조 action과 주홍색 주요 action 1개를 배치한다.
- Desktop에서 sidebar와 main scroll 책임을 명확히 분리하고 이중 scrollbar를 만들지 않는다.

아이콘은 Figma에 복사된 `shadcn/icon/*` 또는 DesignCode UI 원본을 로컬 component로 관리하고, 구현에서는 동일한 의미의 Lucide icon으로 매핑한다. 원격 Community 파일에 runtime 의존하지 않는다.

### Controls

- Button: `primary`, `secondary`, `ghost`, `danger`; 높이 `40px` 기본, `32px` compact, 랜딩만 `48px`
- 주요 action은 한 page header에서 1개만 주홍색으로 강조한다.
- Input·Select·Date: label, helper, error를 동일한 field wrapper에서 관리한다.
- Checkbox·Radio: native control semantics를 유지하고 label 전체를 클릭할 수 있게 한다.
- File upload: 선택 전, 업로드 중, 서버 검증 중, 실패, 완료 상태를 구분한다.
- 민감한 값은 입력 후 다시 표시하지 않으며 현재 MVP에서는 요청하지 않는다.

### Data display

- Summary card: 주요 숫자 하나, 기준 기간과 source를 함께 표시한다.
- Table: column header, 정렬 상태, 빈 상태, loading 상태와 row action을 제공한다.
- Status badge: label과 semantic color를 함께 사용한다.
- Stepper / Job progress: 완료, 현재, 예정, 검토 필요, 실패를 구분한다.
- Evidence path: 원본에서 결과까지의 연결 방향을 유지하고 역추적 진입점을 제공한다.
- Revision: 현재 revision과 이전 revision 비교·생성 시각을 함께 표시한다.

### Reusable screen patterns

새 제품 화면은 아래 네 패턴 중 하나를 복제하고 page별 content slot과 active navigation만 바꾼다.

| Pattern | 적용 순서와 책임 |
| --- | --- |
| `Dashboard / Summary` | 핵심 지표 → 분석 → 최근 데이터 |
| `List + Filter + Table` | 검색·필터·table을 한 흐름으로 유지하는 목록 |
| `Detail / Evidence` | 원본 데이터와 판단 근거를 나란히 탐색하는 상세 |
| `Form / Connection` | 연결·설정 form과 검증 상태를 단계적으로 표시 |

공용 pattern card는 `468×242px`, padding `18px`, gap `12px`, radius `14px` 기준판을 사용한다. 실제 route에서는 폭을 고정하지 않고 grid column에 맞춰 늘리되 내부 rhythm은 유지한다.

### Feedback and overlays

- Inline error는 수정할 field 또는 panel 가까이에 둔다.
- Page error는 원인 범위와 재시도 동작을 제공한다.
- Toast는 저장 완료처럼 짧고 되돌릴 필요가 없는 피드백에만 사용한다.
- Modal은 확인 또는 짧은 집중 작업에만 사용하고, 다단계 등록은 route 또는 drawer를 사용한다.
- Skeleton은 최종 layout을 유지하고, 불확정 progress를 가짜 percentage로 표현하지 않는다.
- 공용 `System / Data State` component set의 `Empty`, `Loading`, `Error` variant를 기본으로 재사용한다.
- Empty는 비어 있는 이유와 첫 action, Loading은 현재 작업과 page 이탈 가능 여부, Error는 원인 범위와 재시도를 제공한다.
- Toast 기본 노출 시간은 `4초`이며 중요한 실패나 복구 action을 toast에만 두지 않는다.
- Filter는 mobile에서 drawer로 전환하고 desktop drawer는 `480px`를 기준으로 한다.

### Figma-to-React mapping

아래 React 이름은 구현 시 사용할 목표 경계다. 아직 존재하지 않는 component를 이미 구현된 것으로 간주하지 않는다.

| Figma source | React target | 책임 |
| --- | --- | --- |
| `App Shell / Sidebar` | `AppSidebar` | desktop·tablet navigation과 profile 영역 |
| `Sidebar / App Nav Item` | `AppNavItem` | item, active state, badge, accessible name |
| `Template / Mobile App Shell` | `MobileAppShell` | top app bar, single-column content, bottom navigation |
| `Button` | `Button` | `primary · secondary · ghost · danger` variant |
| `Status / Badge` | `StatusBadge` | semantic status와 label 결합 |
| `System / Data State` | `DataState` | `empty · loading · error` variant와 recovery action |
| `Dashboard / Summary` | `DashboardSummaryLayout` | KPI, 분석, 최근 데이터 slot |
| `List + Filter + Table` | `DataTableLayout` | filter, table, horizontal overflow |
| `Detail / Evidence` | `EvidenceDetailLayout` | 원본과 판단 근거의 병렬 탐색 |
| `Form / Connection` | `ConnectionFormLayout` | 단계형 연결 form과 검증 상태 |

### Landing-only components

- Header: `72px`, 심볼 + `Daejang`, 제품·작동 방식·FAQ anchor, 외부 `Docs` link, Orange CTA
- Hero: `600px copy + 80px gap + 600px preview`; dashboard 위에 검토 결과 화면을 겹쳐 수집부터 보고서까지의 제품 범위를 함께 보여 준다.
- Feature: `600px copy + 80px gap + 672px preview`
- Final CTA: 최대 `1120px`, 최소 높이 `180px`
- Footer: 전체 폭 muted surface, 내부 `1352px` grid, 상단 border와 낮은 대비 dot pattern

## Accessibility

- 목표: WCAG 2.2 AA
- 모든 상호작용 요소는 keyboard로 도달·실행할 수 있어야 한다.
- focus ring은 배경과 충분한 대비를 갖고 `outline`을 제거하지 않는다.
- field error는 `aria-describedby`, dialog는 label과 초기 focus, table은 올바른 header 관계를 제공한다.
- 최소 pointer target은 `44×44px`; compact table control은 keyboard focus 영역을 별도로 확보한다.
- 색만으로 성공·실패·검토 필요를 구분하지 않는다.
- 자동 갱신 Job 상태는 과도하게 읽히지 않도록 중요한 전이만 live region으로 알린다.
- 금액·주소·hash의 시각적 축약과 screen reader label을 분리한다.

## Responsive behavior

- `>= 1280px`: `236px` 고정 sidebar, fluid main, page padding `32px`, multi-column dashboard
- `768–1279px`: `72px` icon sidebar, 8-column grid, page padding `24px`
- `< 768px`: top app bar + `64px` bottom navigation, single-column layout, page padding `20px`
- 검증 기준 viewport: desktop `1440×1024`, mobile `390×844`
- table은 핵심 column을 유지한 가로 scroll 또는 명시적인 mobile card variant를 사용한다.
- form action은 mobile에서 viewport 하단을 막지 않게 배치하고 필요한 경우 sticky action bar를 사용한다.
- landing은 기존 `1320px`, `900px`, `600px` breakpoint 계약을 유지한다.
- 세무·장부의 고밀도 검토 경험은 desktop을 우선하되 mobile에서 조회와 기본 복구 동작을 막지 않는다.

## Interaction states

| 상태 | 표현 원칙 |
| --- | --- |
| Loading | `System / Data State = Loading`; 기존 layout을 유지하는 skeleton과 현재 작업 문구 |
| Empty | `System / Data State = Empty`; 비어 있는 이유, 첫 action, 지원 범위를 함께 표시 |
| Submitting | 중복 제출 방지, 현재 작업 문구, 취소 가능 여부 표시 |
| Background job | 상태·단계·최근 갱신 시각·다른 화면 사용 가능 여부 표시 |
| Waiting review | 실패로 표현하지 않고 검토 이유와 이동 action 제공 |
| Success | 완료된 대상과 다음 화면 또는 생성된 결과 연결 |
| Field error | 입력값을 유지하고 해당 field 가까이 수정 방법 표시 |
| Page / job error | `System / Data State = Error`; 안전한 오류 문구, request ID, 재시도 또는 지원 경로 |
| Disabled | 왜 사용할 수 없는지 주변 문맥 또는 helper로 설명 |
| Offline / slow network | 서버 확정 전 성공으로 표시하지 않고 재연결 상태 제공 |

## Content voice

- 짧고 직접적인 한국어를 사용하며 불필요한 `~합니다`, `~해 보세요` 반복을 피한다.
- 제목은 명사구 또는 결과 중심 표현, 설명은 필요한 경우에만 완결 문장을 사용한다.
- 로그인 사용자의 계정과 연결 대상을 모두 “계정”으로 부르지 않는다.
- 연결 대상은 `데이터 소스`, `거래소 거래내역 문서`, `개인지갑 주소`로 구체화한다.
- `검토 필요`는 실패가 아니며, 자동 확정할 수 없는 이유를 함께 표시한다.
- 예상값과 확정값, 저장과 처리 완료, 등록과 수집 시작을 구분한다.
- `Lot`, `revision`, `source coverage` 같은 용어는 첫 노출에 한국어 설명을 함께 제공한다.

## Implementation constraints

- Framework: React 19, TypeScript, Vite, npm workspaces
- 랜딩 token source: `apps/web/src/styles.css`의 `:root`
- 제품 token source: Figma의 `GIWA Web / Color`, `GIWA Web / Spacing`, `GIWA Web / Radius` collection. 구현 시 같은 이름의 CSS custom property 또는 typed token으로 1:1 매핑한다.
- 제품 기본 color mode는 `Dashboard Light`이며 dark `Default` mode는 별도 요구 전까지 구현 범위가 아니다.
- 실제 앱 route가 시작되면 token을 중복 선언하지 말고 공통 stylesheet 또는 `shared/ui` 경계로 이동한다.
- 랜딩 component를 제품 shell에 재사용하지 않는다. Brand와 원자적 control만 공통화한다.
- `Sidebar / App Nav Item`, Button, `Status / Badge`, `System / Data State` variant를 먼저 구현하고 page별로 다시 만들지 않는다.
- page별 차이는 reusable screen pattern의 content slot과 active navigation으로 표현한다.
- React는 Public Web API만 호출하고 Engine·DB·S3 자격증명을 알지 못한다.
- 라우터·서버 상태·폼 라이브러리는 실제 route와 API 계약이 정해진 시점에만 추가한다.
- 폰트 파일과 OFL license를 함께 배포한다.
- 전체 Pretendard Variable WOFF2는 약 2MB다. 초기 성능 예산을 넘기면 공식 subset을 검토하되 임의 변환본으로 교체하지 않는다.
- 검증: lint, typecheck, component test, production build, 랜딩 `1512·1200·768·390px`와 제품 `1440×1024·390×844` visual check

## Open questions

- [ ] 로그인·회원가입 인증 방식과 route 계약
- [ ] 첫 지원 EVM chain과 address 표시 규칙
- [ ] 제품 mobile에서 허용할 편집·검토 범위
- [ ] 보고서 다운로드와 revision 비교 화면의 최종 정보 구조
- [ ] table density 사용자 설정 제공 여부
- [ ] 전체 Pretendard preload 유지 또는 공식 subset 전환의 성능 기준
- [ ] 개인정보 처리방침 확인과 별도 수집·이용 동의의 최종 법무 문구

## Review checklist

- [ ] 화면이 이 문서의 제품 typography와 spacing scale을 사용한다.
- [ ] 새 route가 네 가지 reusable screen pattern 중 하나를 기반으로 한다.
- [ ] Sidebar와 System state는 새 component가 아니라 기존 Variant를 사용한다.
- [ ] Desktop `236px`, Tablet `72px`, Mobile top app bar + bottom navigation 전환을 확인했다.
- [ ] 기본·loading·empty·error·success·disabled 상태가 정의되어 있다.
- [ ] 서버가 확정하지 않은 값을 확정된 것처럼 표시하지 않는다.
- [ ] keyboard, focus, label, error 연결을 확인했다.
- [ ] 민감 정보가 화면·로그·분석 이벤트에 노출되지 않는다.
- [ ] desktop과 mobile에서 overflow와 주요 action을 확인했다.
- [ ] 실제 제품 화면은 screenshot이 아니라 component로 구현했다.
- [ ] lint, typecheck, test, build가 통과한다.
