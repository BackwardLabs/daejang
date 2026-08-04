# 컨테이너 통합 검증과 release image 흐름

> 대상: Daejang 서비스, database migration과 이를 소비하는 저장소의 기여자·리뷰어·에이전트
>
> 이 문서는 공통 절차의 정본이다. 저장소별 `CONTRIBUTING.md`, PR template와 `AGENTS.md`는 이 문서에 링크만 둔다.

## 목적

개발자가 로컬에서 확인한 변경과 실제 배포되는 container image 사이의 차이를 줄인다. 매 PR마다 비용이 드는 hosted CI 통합 테스트를 실행하지 않고, PR 전 격리 검증과 main 병합 후 동일 image digest의 수동 통합 검증을 분리한다.

## 개발 workspace

- 공용 `/Users/Shared/Projects/01_Daejang/<repo>` checkout은 참조와 운영 절차용이다. 여기서 브랜치 전환, 의존성 설치, 빌드, 개발 서버 또는 직접 커밋을 하지 않는다.
- 각 개발자는 자신의 일반 clone에서 작업한다. 권장 위치는 `/Users/<user>/code/daejang/<repo>`다.
- 한 사람이 동시에 여러 브랜치를 실행해야 할 때만 자신의 clone에서 worktree를 추가로 사용한다. 다른 사람의 clone이나 worktree는 정리·수정하지 않는다.

## PR 전: 개발자 격리 검증

PR 전에 변경과 가장 가까운 테스트를 실행한다. 배포되는 서비스 또는 migration에 영향을 주면 아래를 추가한다.

1. 해당 branch와 repository Dockerfile로 image를 로컬 build한다.
2. 고유 Compose project name, host port, volume, DB 이름을 사용해 격리 환경에서 실행한다. 예: `COMPOSE_PROJECT_NAME=daejang-<user>-<task>`.
3. 기능의 API·worker·E2E 확인을 수행하고, migration이면 빈 PostgreSQL과 최신 schema upgrade 경로를 검증한다.
4. 실행 명령, commit SHA, 결과와 실행하지 못한 항목을 PR의 `검증 결과`에 기록한다.

`deploy/compose.production.yaml`, 운영 `.env`, 운영 DB, 운영 secret, Supervisor/launchd runtime은 이 단계에서 사용하지 않는다. 운영 컨테이너를 `docker commit`으로 떠서 테스트 image로 재사용하지 않는다.

Tax Engine과 Posting Service의 local PostgreSQL·runtime bundle·Compose 실행 방법은 [Tax·Posting 로컬 container 검증](local-container-workers.md)을 따른다.
signed runtime bundle 없이 image test target과 disposable DB를 확인할 때는 [Tax·Posting image local testnet](local-container-testnet.md)을 따른다.

## PR과 병합

- PR은 로컬 격리 검증의 증적과 데이터·호환성·다른 저장소 의존성을 포함한다.
- `daejang`과 `daejang-db`의 품질 CI는 PR에서만 실행한다. 같은 commit을 main에서 다시 테스트하지 않는다.
- repository를 넘는 `daejang-tax-engine` 통합 CI는 PR에서 자동 실행하지 않는다. PR 전 격리 검증 결과를 기록하고, 필요할 때 Actions의 수동 실행으로 계약을 재검증한다.
- `main` 직접 push는 금지한다. 모든 코드·migration 변경은 PR 검토와 PR CI를 통과한 뒤 병합한다.
- PR 병합은 코드 검토 완료를 뜻한다. 병합 자체가 실제 release image 검증 또는 운영 배포 완료를 뜻하지 않는다.
- 다른 저장소에 의존하면 호환 가능한 commit·PR·병합 순서를 PR에 적는다.

## main 병합 후: release image

release image는 main에 병합된 commit에서 한 번만 build한다. image publish workflow를 도입하기 전에는 승인된 release 담당자가 같은 규칙으로 수동 build/push할 수 있다.

- image 이름은 `ghcr.io/backwardlabs/<service>`처럼 서비스별로 분리하고 소문자를 사용한다.
- tag는 `sha-<main-commit>`을 사용한다. mutable `latest` 또는 branch tag만으로 테스트·배포 대상을 식별하지 않는다.
- push 결과의 OCI digest (`sha256:...`)를 release 기록에 남긴다.
- GitHub Actions를 사용하면 main push만 image publish 권한(`packages: write`)을 갖는다. PR에서는 image publish를 기본 동작으로 만들지 않는다.

## 수동 통합 검증과 배포

1. 테스트 환경에서 기록한 image digest를 pull한다.
2. 전용 Compose project, 전용 DB와 테스트용 외부 의존성으로 기능·healthcheck·migration·rollback 영향을 확인한다.
3. 통과한 **같은 digest**만 deployment configuration에 넣는다. 검증 뒤 동일 source를 다시 build하지 않는다.
4. 배포 전 image digest, 검증 일시·명령·결과, migration 여부, rollback 대상 digest를 기록한다.

테스트 서버가 private image를 pull할 때는 개발자 개인 자격증명이 아니라 `read:packages`만 가진 배포 전용 계정을 사용한다. 이 credential은 secret manager 또는 서버의 권한 제한된 설정에만 둔다.

## 저장소별 적용 범위

| 저장소 | PR 전 필수 확인 | main 병합 후 확인 |
| --- | --- | --- |
| `daejang` | Web API 또는 Engine 변경 시 해당 Dockerfile build와 격리 API/worker 확인 | 서비스 image digest 통합 검증 |
| `daejang-db` | migration 빈 DB 적용, 최신 schema upgrade, runtime role 확인 | migration image 또는 변경 commit과 소비 서비스의 호환성 확인 |
| `daejang-tax-engine` | taxd image build, pinned DB/JIT/schema 계약과 격리 PostgreSQL 확인 | taxd digest와 downstream report 경로 확인 |
| `daejang-jit-engine` | replay·schema·artifact contract 검증 | 배포 대상 service가 생기면 해당 image digest와 tax handoff 확인 |

## 비용 관리

- hosted CI는 PR마다 container image를 publish하지 않는다.
- `daejang`과 `daejang-db`의 hosted 품질 CI는 PR에서 한 번만 실행한다. main 병합으로 같은 품질 검사를 반복하지 않는다.
- 가장 비용이 큰 `daejang-tax-engine`의 repository 간 통합 CI는 수동 실행만 허용한다.
- image build/push는 main 병합 후 한 번만 실행한다.
- 통합 테스트는 수동 체크리스트 또는 격리된 self-hosted test runner에서 실행한다. 운영 서버에는 runner를 설치하지 않는다.
- 테스트 image·artifact의 보존 기간과 GitHub Actions budget을 운영자가 명시적으로 관리한다.
