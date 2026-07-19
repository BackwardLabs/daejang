# 대장 (Daejang)

> 거래소와 지갑의 디지털 자산 기록을 수집·정규화하고, 사용자가 검토할 수 있는 재현 가능한 장부와 보고서로 연결하는 GIWA MVP입니다.

## 현재 범위

이 저장소는 GIWA MVP의 웹 애플리케이션과 이후 Web API·Go Engine을 함께 수용할 기본 구조를 제공합니다. 현재 구현된 범위는 `apps/web`의 React 초기 틀과 웹 기술·온보딩 문서입니다.

- Frontend: React 19, TypeScript 6, Vite 8
- Package manager: npm workspaces
- Quality: Oxlint, TypeScript, Vitest, Testing Library
- MVP 데이터 소스: Upbit CSV 1개, EVM 지갑 주소 1개

전체 서비스 경계와 아직 결정되지 않은 항목은 [웹 앱 기술 명세](docs/00-web-app-technical-spec.md)를 확인하세요. 로그인부터 첫 데이터 수집 시작까지의 UX는 [사용자 온보딩](docs/01-user-onboarding.md)에 정리되어 있습니다.

## 시작하기

요구 사항:

- Node.js `20.19+` 또는 `22.12+`
- npm

```bash
npm install
npm run dev
```

개발 서버는 기본적으로 `http://localhost:5173`에서 실행됩니다.

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
docs/         제품 흐름과 웹 기술 명세
```

기술 명세의 목표 구조에는 `apps/web-api`, `services/engine`, `proto`, `migrations`, `fixtures`가 포함되지만, 해당 구현이 시작되기 전까지 빈 디렉터리는 만들지 않습니다.

## 기준 자료

- [대장 Flow](https://www.figma.com/board/9rt2FVwNe1Dfv9DXLThXok/%EB%8C%80%EC%9E%A5-flow?node-id=58-145)
- [Technical Spec — GIWA MVP v0.1](https://linear.app/giwa-daejang/document/technical-spec-giwa-mvp-v01-18d511232c66)

## 협업

- 버그, 기능 요청, 작업 제안은 GitHub Issues에 등록합니다.
- 작업 브랜치는 동기화된 Linear 이슈의 **Copy git branch name**으로 생성합니다.
- 변경 사항은 Pull Request로 제출합니다.
- 코딩 에이전트는 [AGENTS.md](AGENTS.md)의 공통 지침을 따릅니다. Claude Code는 [CLAUDE.md](CLAUDE.md)를 통해 같은 지침을 불러옵니다.
- 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)를 확인하세요.

## 저장소 초기 설정

이 저장소를 GitHub 템플릿으로 생성했다면 [TEMPLATE_SETUP.md](TEMPLATE_SETUP.md)의 체크리스트를 먼저 완료하세요.
