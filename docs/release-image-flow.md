# Local E2E, PR과 Registry image 흐름

> 대상: Daejang 서비스, database migration과 이를 소비하는 저장소의 기여자·리뷰어·에이전트
>
> 이 문서는 공통 절차의 정본이다. 저장소별 `CONTRIBUTING.md`, PR template와 `AGENTS.md`에는 같은 규칙을 복사하지 않고 이 문서를 연결한다.

## 전체 흐름

```text
기능 worktree
  │
  ├─ 개발 중 빠른 테스트
  ├─ 필요할 때 Local E2E와 Web UI 확인
  └─ PR 직전 해당 저장소 make test
           │
           ▼
      Draft PR · 로컬 검증 · 리뷰
           │
           ▼  Ready for review에서 최종 CI 1회
      GitHub 최종 검사
           │
           ▼
         main 병합
           │
           ▼  Mac Studio publisher가 2분마다 main SHA 확인
    linux/arm64 image build
           │
           ▼  build가 성공한 저장소만
      Registry :latest 갱신
           │
           ▼
      OCI digest 기록·검증
           │
           ▼
       별도 Release · 배포
```

PR의 후보 image와 merge 뒤 Registry image는 목적이 다르다.

- **PR 전 후보 image**: 현재 branch를 로컬에서 검증하기 위한 임시 image다. Registry에 push하지 않는다.
- **Registry `latest` image**: merge된 `main` commit을 Mac Studio publisher가 다시 build한 팀 기준 image다.
- **배포 대상**: mutable한 `latest` 문자열이 아니라 publisher가 기록한 OCI digest다.
- **merge**: image 발행을 시작시키지만 Production 배포 완료를 의미하지 않는다.

## 개발 workspace

- 공용 `/Users/Shared/Projects/01_Daejang/<repo>` checkout은 참조와 운영 자동화용이다. 여기서 기능 branch를 만들거나 개발 build를 하지 않는다.
- 각 개발자는 자신의 clone과 기능 worktree에서 작업한다.
- 여러 저장소를 바꾸면 실제로 수정하는 저장소만 같은 기능 worktree 묶음에 추가한다.
- 운영 DB, 운영 `.env`, 운영 secret, Supervisor·launchd runtime은 Local E2E에 사용하지 않는다.

## PR 전: 저장소 자체 자동 E2E

변경한 저장소에서 다음 명령을 실행한다.

```bash
cd <변경한-저장소-worktree>
make test
```

각 저장소의 `make test`는 다음 원칙을 따른다.

1. Registry에서 변경하지 않은 의존 서비스의 `latest`를 pull한다.
2. 현재 checkout만 로컬 후보 image로 build한다.
3. 일회용 PostgreSQL과 고정 fixture를 사용한다.
4. 실제 service runtime과 저장소 회귀 테스트를 실행한다.
5. container, network와 일회용 DB volume을 정리한다.
6. 로컬 후보 image는 Registry에 push하지 않는다.

| 저장소 | 현재 checkout으로 만드는 후보 | 확인하는 흐름 |
| --- | --- | --- |
| `daejang` | Web API, Engine, PDF parser | PDF → Posting → Ledger → Tax → Report와 Web API |
| `daejang-posting-service` | Posting test·runtime | publication claim → materialize → ACK → canonical ledger |
| `daejang-jit-engine` | JIT test·runtime | fixture RPC → jitd → publication → Posting → ledger |
| `daejang-tax-engine` | Tax test·runtime·dev fixture | SOURCE → Posting → ledger → Tax report |
| `daejang-db` | image 없음 | migration, runtime role, persistence client와 소비 흐름 |

## 개발 중: Web UI를 계속 띄워 확인

지속형 전체 제품 환경의 orchestrator는 `daejang` 저장소 하나다. 다른 저장소에서 `make dev-e2e-up`을 실행하는 구조가 아니다.

### Daejang 자체를 수정한 경우

```bash
cd <daejang-worktree>
make dev-e2e-up

# 같은 환경에서 자동 검증을 다시 실행
make dev-e2e-test

# 상태와 통합 로그
make dev-e2e-status
make dev-e2e-logs

# 모든 확인이 끝났을 때만 제거
make dev-e2e-down
```

이 명령은 현재 Daejang checkout으로 Web UI, Web API, Engine과 PDF parser 후보를 build한다. Posting과 Tax는 기본적으로 Registry `latest`를 사용한다.

### Posting branch를 Web UI와 함께 확인하는 경우

```bash
cd <posting-service-worktree>
make test

# make test가 남긴 로컬 runtime 후보를 전체 환경에 연결
cd <daejang-checkout>
DAEJANG_POSTING_IMAGE=daejang-posting-service:dev-e2e-runtime \
  make dev-e2e-up
```

### Tax branch를 Web UI와 함께 확인하는 경우

```bash
cd <tax-engine-worktree>
make test

cd <daejang-checkout>
DAEJANG_TAX_ENGINE_IMAGE=daejang-tax-engine:dev-e2e-runtime \
DAEJANG_TAX_DEV_E2E_IMAGE=daejang-tax-engine:dev-e2e-fixture \
  make dev-e2e-up
```

### DB branch를 전체 환경에 연결하는 경우

```bash
cd <daejang-checkout>
make dev-e2e-up DAEJANG_DB_DIR=<daejang-db-worktree>
```

JIT은 현재 Daejang 지속형 Compose에 포함되지 않는다. JIT 변경은 JIT worktree의 `make test`로 검증한다. 지속형 환경까지 연결하기 전에는 Web UI 전체 검증을 했다고 기록하지 않는다.

현재 Posting·Tax·JIT 후보 tag는 같은 Docker daemon에서 공유된다. 다른 사용자의 후보 build와 겹칠 수 있으므로, 동일 서비스의 Local E2E를 동시에 실행할 때는 먼저 조율한다. 사용자별 tag가 구현되기 전까지 이 제한을 PR의 미검증 범위에 포함한다.

## 여러 저장소를 함께 변경한 경우

상류 후보를 먼저 build한 뒤 하류 테스트에 image 이름을 전달한다.

```bash
cd <posting-service-worktree>
make test

cd <tax-engine-worktree>
make test POSTING_IMAGE=daejang-posting-service:dev-e2e-runtime
```

Posting과 JIT을 함께 바꾼 경우에도 JIT의 `make test`에 같은 `POSTING_IMAGE`를 전달한다. 관련 PR과 안전한 병합 순서를 모든 PR 본문에 연결한다.

## PR 작성 규칙

PR은 기본적으로 Draft로 만들고 제목과 본문을 한국어로 작성한다. 본문에는 다음 항목을 남긴다.

```markdown
## 변경 내용
- 사용자가 보게 되는 변화 또는 계약 변화

## 재현한 상황
- 수정 전 문제가 발생한 입력과 흐름
- 수정 후 기대 결과

## 검증 결과
- 실행한 정확한 명령
- 성공·실패 결과
- 로컬 후보 image ID
- 사용한 Registry 의존 image digest
- 실행하지 못한 테스트와 남은 위험

## 관련 PR과 병합 순서
- 의존 PR URL
- 안전한 병합 순서
```

- 로컬 후보 image ID는 PR에서 어떤 bytes를 시험했는지 설명하는 증적이다. 해당 image를 Registry에 push하지 않는다.
- UI 변경은 확인한 URL·시나리오와 필요한 화면을 함께 남긴다.
- 동일 목적의 PR을 새로 만들지 않고 기존 최신 PR에 유효한 변경을 통합한다.
- CI와 리뷰가 끝나도 명시적인 요청 없이 에이전트가 merge하지 않는다.

### GitHub Actions 비용 경계

- Draft PR에서는 GitHub-hosted runner를 실행하지 않는다. 개발 중 반복 검증은 해당 worktree의 `make test` 또는 `make check`로 수행한다.
- 최종 로컬 검증과 PR 설명 정리가 끝나면 PR을 `Ready for review`로 바꾼다. 자동 CI가 있는 저장소는 이 시점에 최종 검사를 한 번 실행한다.
- `Ready for review` 상태에서 새 commit을 push하면 최종 CI가 다시 실행된다. 따라서 준비 전까지 Draft를 유지한다.
- Markdown과 `docs/`만 바뀐 PR은 자동 CI를 실행하지 않는다.
- 자동 GitHub CI는 현재 `daejang`과 `daejang-db`에만 둔다. DB의 PostgreSQL race test도 Draft에서는 실행하지 않고 최종 PR 검사에서만 실행한다.
- `daejang-jit-engine`, `daejang-posting-service`, `daejang-tax-engine`과 schema 저장소는 자동 GitHub Actions를 사용하지 않는다. 각 저장소의 로컬 검증 결과와 생략 사유를 PR 본문에 기록한다.
- main image 발행은 GitHub Actions가 아니라 Mac Studio publisher가 담당한다.

## main 병합 후: Mac Studio 자동 publisher

GitHub Actions가 private Registry로 image를 push하지 않는다. Mac Studio의 scheduler가 2분마다 다음 네 저장소의 원격 `main` SHA를 확인한다.

- `BackwardLabs/daejang`
- `BackwardLabs/daejang-jit-engine`
- `BackwardLabs/daejang-posting-service`
- `BackwardLabs/daejang-tax-engine`

main SHA가 마지막 성공 기록과 다르면 publisher가 다음 작업을 수행한다.

1. GitHub API에서 해당 commit의 source archive를 임시 directory로 받는다.
2. 공용 checkout이 아니라 이 격리 source에서 native `linux/arm64` image를 build한다.
3. 한 저장소에 속한 image를 모두 먼저 build한다.
4. build가 성공하면 Registry의 해당 `latest` tag를 push한다.
5. source commit을 `org.opencontainers.image.revision` label에 기록한다.
6. push 결과의 OCI digest와 source commit을 publisher state에 기록한다.
7. 실패하면 성공 commit을 갱신하지 않고 다음 2분 주기에 재시도한다.

| main이 바뀐 저장소 | 자동 발행 image |
| --- | --- |
| `daejang` | `web-api:latest`, `engine:latest`, `pdf-parser:latest` |
| `daejang-jit-engine` | `jit-engine:latest` |
| `daejang-posting-service` | `posting-service:latest` |
| `daejang-tax-engine` | `tax-engine:latest`, `tax-engine-dev-e2e:latest` |

Registry 주소는 Mac Studio의 Tailscale MagicDNS에서 조회한다. 개발 저장소와 GitHub에는 Registry 비밀번호나 Tailscale auth key를 저장하지 않는다.

### `daejang-db`를 병합한 경우

`daejang-db`는 현재 자동 publisher의 container image 대상이 아니다. DB PR merge만으로 Registry image가 바뀌지 않는다.

- migration과 persistence client source는 Git의 main commit으로 관리한다.
- Local E2E는 사용할 DB checkout을 `DAEJANG_DB_DIR`로 선택한다.
- DB 변경을 소비하는 서비스는 호환 코드가 해당 서비스 main에 병합된 뒤 그 서비스 image가 별도로 발행된다.
- Production migration 적용은 image publisher가 아니라 별도 Release·migration 절차다.

## 발행 확인

Mac Studio에서 다음 명령으로 scheduler와 저장소별 마지막 성공 commit·digest를 확인한다.

```bash
cd /Users/Shared/Projects/01_Daejang/daejang/deploy/registry
make publisher-status
```

필요하면 즉시 한 번 실행할 수 있다.

```bash
make publisher-run
```

일반 개발자가 merge 뒤 수동 `docker push`를 실행하지 않는다. 자동 발행이 실패하면 publisher log와 Docker·GitHub·Registry 연결을 확인하고, 원인을 고친 뒤 publisher를 재실행한다. branch 후보 image를 `latest`로 대신 올려서는 안 된다.

PR이나 Release 기록에는 다음을 구분해서 적는다.

- merge commit SHA
- publisher가 기록한 source commit
- Registry tag
- 실제 OCI digest (`sha256:...`)
- 발행 확인 시각

## 정리와 보존

- Registry에는 각 image의 현재 `latest`를 유지한다.
- 교체된 이전 digest는 cleanup queue에 들어간다.
- 매일 04:15 cleaner가 현재 `latest`가 아닌 digest를 삭제하고 garbage collection을 실행한다.
- 이전 source는 Git commit으로 남으므로 필요하면 해당 commit에서 image를 다시 build할 수 있다.
- rollback과 배포 기록은 tag가 아니라 검증한 digest를 사용한다.

## Release와 배포

publisher의 성공은 “main image가 Registry에 준비됨”을 뜻한다. 그 다음 단계는 별도다.

1. 필요한 image를 digest로 고정한다.
2. 전용 QA 환경과 DB에서 smoke·migration·rollback 영향을 확인한다.
3. 통과한 동일 digest를 Release manifest에 기록한다.
4. 승인된 Release pointer를 변경해 Production에 배포한다.

merge, Registry publish, Release 확정, Production deployment를 같은 상태로 표현하지 않는다.
