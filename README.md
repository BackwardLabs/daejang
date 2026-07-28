# 대장 (Daejang)

> 거래소와 지갑의 디지털 자산 기록을 수집·정규화하고, 사용자가 검토할 수 있는 재현 가능한 장부와 보고서로 연결하는 GIWA MVP입니다.

## 현재 범위

이 저장소는 GIWA MVP의 웹 애플리케이션, Web API와 Engine을 제공합니다. `apps/web`의 React 화면, `apps/web-api`의 Fastify BFF, `services/engine`의 Go gRPC Source·Workflow·Query 서비스와 durable Sync worker가 구현되어 있습니다.

- Frontend: React 19, TypeScript 6, Vite 8
- Web API: Fastify 5, TypeScript, 서버 세션 기반 BFF
- Engine API: Go, protobuf, mTLS gRPC, PostgreSQL source/job/read/report stores
- Package manager: npm workspaces
- Quality: Oxlint, TypeScript, Vitest, Testing Library
- MVP 데이터 소스: Upbit 거래내역 PDF와 여러 EVM 공개 지갑 주소

전체 서비스 경계와 아직 결정되지 않은 항목은 [웹 앱 기술 명세](docs/00-web-app-technical-spec.md)를 확인하세요. 로그인과 가입 흐름은 [사용자 온보딩](docs/01-user-onboarding.md), 데이터 소스 등록과 날짜 설정은 [데이터 소스 등록 및 수집 기간 설정](docs/02-data-source-collection.md)에 정리되어 있습니다. 화면의 색상·타이포·간격 기준은 [웹 디자인 가이드](docs/design.md), 저장소에서 작업을 시작하는 방법은 [개발 가이드](docs/development-guide.md)를 따릅니다.

## 시작하기

요구 사항:

- Node.js `20.19+` 또는 `22.12+`
- npm

```bash
npm install
npm run dev
```

개발 서버는 기본적으로 `http://localhost:5173`에서 실행됩니다.

Web API는 별도 터미널에서 실행합니다.

```bash
npm run dev:api
```

Web API의 기본 주소는 `http://127.0.0.1:3000`입니다. 설정 가능한 환경 변수는 [`apps/web-api/.env.example`](apps/web-api/.env.example)에서 확인할 수 있습니다.

실제 지갑 source를 로컬 DB에 저장하려면 `daejang-db` migration과 Source Engine도
실행해야 합니다. 로컬 plaintext gRPC는 loopback에만 명시적으로 허용되며 자세한
설정은 [`services/engine/README.md`](services/engine/README.md)를 따릅니다.

운영 DB에는 Web API를 시작하기 전에 `daejang-db`의 중앙 migration을 적용합니다.

```bash
cd ../daejang-db
DATABASE_URL='postgresql://...' make migrate-up
```

Web API는 다음 보안 경계를 기본으로 적용합니다.

- opaque host-only Session cookie와 절대·유휴 만료
- 상태 변경 `/api/*` 요청의 Origin·Fetch Metadata 검증
- API 응답 cache 금지, 보안 헤더와 민감 로그 redaction
- 서버 Session에서 확인한 단일 사용자 UUID만 신뢰
- PostgreSQL SessionStore와 사용자 상태·session epoch 기반 즉시 Session 무효화
- 버전별 이용약관·개인정보 처리방침과 append-only 사용자 동의 이력
- 공급자별 PostgreSQL 로그인 rate limit과 Session Token 회전
- Engine private gRPC client certificate mTLS preflight
- 서버 Session 기반 Source·Workflow·Query 호출과 503/504 오류 변환
- private Upbit PDF 업로드, digest 검증, durable Sync Job lease
- 실제 DB 기반 Dashboard·Activity·Ledger·Review와 immutable Report snapshot

메모리 SessionStore와 rate-limit store는 로컬 개발과 테스트 전용입니다. 운영 모드는 `DATABASE_URL`, 32 byte 이상의 `RATE_LIMIT_HMAC_SECRET`, Engine CA·client certificate·private key 설정이 없으면 시작하지 않습니다. Web schema는 `daejang-db` migration이 소유하며 OAuth·이메일 인증 persistence는 `000015`에서 추가됩니다. 현재 Web API는 wallet ownership 경계까지 반영된 `web-auth-persistence` v2 / migration 11 계약을 요구합니다. ingress 기준은 [`deploy/nginx`](deploy/nginx/README.md), DB부터 Worker까지 실제 배포 순서는 [계정 인증 배포 실행 순서](docs/auth-deployment-runbook.md)에 있습니다.

Migration `24`가 적용된 DB에서는 인증 Session의 사용자 ID를 subject 경계로 사용해 현재
신고서 read model을 조회합니다. 요청 header나 query로 다른 subject를 지정할 수 없으며,
금액 상태가 `UNKNOWN`이면 `amount`를 0으로 만들지 않고 필드 자체를 생략합니다.

```text
GET /api/v1/tax-reports/:taxYear/current?finality=FINAL|PROVISIONAL&residentId=...
```

서버는 시작 시 읽기 권한이 필요한 `reporting.tax_report`,
`reporting.current_tax_report`와 `tax-report-persistence` migration `24` 계약만
확인합니다. 세금 계산 상세 테이블은 Web API 역할에 노출하지 않습니다.

## 검증 명령

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## 디렉터리

```text
apps/
  web/        React 웹 애플리케이션
  web-api/    Fastify Web API / BFF
proto/        Web API와 Engine의 canonical gRPC 계약
services/
  engine/     Go SourceService API
docs/         제품 흐름과 웹 기술 명세
```

DB migration과 persistence client는 `daejang-db`가 소유합니다. Engine 실행 방법은 [`services/engine/README.md`](services/engine/README.md), 남은 연동 순서는 [Engine 연동 구현 현황과 계획](docs/engine-integration-roadmap.md)을 확인하세요.

## 기준 자료

- [대장 Flow](https://www.figma.com/board/9rt2FVwNe1Dfv9DXLThXok/%EB%8C%80%EC%9E%A5-flow?node-id=58-145)
- [Technical Spec — GIWA MVP v0.1](https://linear.app/giwa-daejang/document/technical-spec-giwa-mvp-v01-18d511232c66)
- [인증·Session Sequence](docs/auth-session-sequences.md)

## 협업

- 버그, 기능 요청, 작업 제안은 GitHub Issues에 등록합니다.
- 작업 브랜치는 동기화된 Linear 이슈의 **Copy git branch name**으로 생성합니다.
- 변경 사항은 Pull Request로 제출합니다.
- 코딩 에이전트는 [AGENTS.md](AGENTS.md)의 공통 지침을 따릅니다. Claude Code는 [CLAUDE.md](CLAUDE.md)를 통해 같은 지침을 불러옵니다.
- 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)를 확인하세요.
- 이슈부터 branch, 검증, PR과 병합까지의 실제 순서는 [개발 가이드](docs/development-guide.md)를 확인하세요.

## 저장소 초기 설정

이 저장소를 GitHub 템플릿으로 생성했다면 [TEMPLATE_SETUP.md](TEMPLATE_SETUP.md)의 체크리스트를 먼저 완료하세요.
