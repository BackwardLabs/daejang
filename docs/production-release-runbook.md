# Production Release 운영 런북

이 문서는 Mac Studio의 `/Users/Shared/Projects/01_Daejang`을 Production checkout으로
사용할 때, 어떤 commit을 검증하고 배포하는지 설명한다. GitHub `main`은 소스코드의
정본이고, Production은 자동으로 `main`을 따라가지 않는다. 배포할 버전을 Release
manifest로 명시한 뒤에만 checkout이 이동한다.

## 운영 원칙

```text
PR 병합
   │
   ▼
Publisher가 main SHA별 이미지 발행
   │
   ▼
운영자가 Release manifest 작성
   │
   ▼
immutable image + 전체 E2E 검증
   │
   ▼
exact source SHA checkout
   │
   ▼
Production 재시작 및 current 포인터 교체
```

- `origin/main`이 바뀌어도 Production은 자동으로 바뀌지 않는다.
- `latest`는 개발 의존용이며, Release에는 `sha-<commit>` 이미지와 OCI digest를 기록한다.
- `releases/current`는 현재 운영 버전, `releases/previous`는 즉시 되돌릴 버전이다.
- Release에는 source SHA, image digest, 검증 결과만 저장한다. 운영 DB와 secret은 저장하지 않는다.

## Release 만들기

모든 명령은 운영 사용자 `backwardlabs`가 실행한다.

### ReviewRoom 배포 설정

ReviewRoom은 Release manifest에 고정된 OCI digest로만 배포한다. 배포 전에
[`deploy/reviewroom.compose.env.example`](../deploy/reviewroom.compose.env.example)를
`/Users/Shared/Projects/01_Daejang/daejang/deploy/reviewroom.env`로 복사해
`backwardlabs:upside`, mode `660`으로 제한한다. 이는 현재 Mac Studio의
`deploy/production.env`, `daejang-db/.env`와 같은 운영 배치 규칙이다.

workload 파일도 ReviewRoom checkout의 Git-ignored `.env.*` 파일로 둔다.

| 파일 | 용도 |
| --- | --- |
| `daejang/deploy/reviewroom.env` | Postgres password와 네 workload env의 절대 경로 |
| `daejang-reviewroom/.env.migrate` | ReviewRoom migration DB URL |
| `daejang-reviewroom/.env.api` | API token, commitment/encryption key, JWT, proof 조회 설정 |
| `daejang-reviewroom/.env.anchor-worker` | chain RPC/registry, anchor signer와 worker 설정 |
| `daejang-reviewroom/.env.delivery-worker` | 중앙 Daejang DB consumer credential와 ingest token |

각 파일의 key 목록은 `deploy/reviewroom.*.env.example`에 있다. 실제 파일은
`.gitignore`에 포함되어 있으므로 Git에 add하지 않는다.

delivery worker는 `DAEJANG_DB_NETWORK`로 지정된 중앙 DB Compose network에도
연결한다. 현재 Mac Studio 값은 `daejang-db_default`이고, delivery DB URL의 host는
ReviewRoom-local `postgres`와 충돌하지 않는 `daejang-db-postgres-1`이다.

`REVIEWROOM_IMAGE_REF`는 이 파일에 넣지 않는다. release script가 검증된
`images.lock.json`의 `reviewroom@sha256:...` 값을 Compose 실행 환경에 주입한다.
따라서 `latest` 또는 수동 tag로 ReviewRoom을 배포할 수 없다. 다른 경로를 써야 하면
`REVIEWROOM_DEPLOY_ENV_FILE`과 `REVIEWROOM_COMPOSE_FILE`을 명시적으로 지정한다.

`verify`의 ReviewRoom canonical E2E에는 Foundry의 `forge`, `anvil`, `cast`가 필요하다.
`mac-studio:preflight`는 이 세 명령과 ReviewRoom Compose의 secret-file 경로를 모두
검사하므로, Release를 만들기 전에 먼저 통과시킨다.

```bash
cd /Users/Shared/Projects/01_Daejang/daejang

# 현재 checkout과 권한, GitHub·Registry 연결 확인
npm run mac-studio:status
npm run mac-studio:preflight

# 기존 current Release를 기준으로 Publisher가 성공한 main 이미지까지 반영
npm run mac-studio:release -- prepare 20260816-release1 --publisher-main

# source SHA와 image digest를 임시 worktree·일회용 DB에서 검증
npm run mac-studio:release -- verify 20260816-release1

# 검증된 Release만 Production에 반영
npm run mac-studio:release -- promote 20260816-release1
```

특정 저장소의 commit만 지정하려면 `prepare` 뒤에 `저장소=SHA`를 붙인다.

```bash
npm run mac-studio:release -- prepare 20260816-posting-fix \
  daejang-posting-service=<병합된-commit-SHA> \
  daejang=<호환되는-commit-SHA>
```

`prepare`는 Production checkout을 건드리지 않는다. `verify`가 실패하면 manifest를
수정하거나 새 Release ID를 만들고 다시 검증한다. `promote`만 exact source SHA로
checkout하고 서비스를 재시작한다.

## 배포 후 확인

```bash
npm run mac-studio:release -- status
npm run backend:status
curl -fsS http://127.0.0.1:<web-port>/healthz
curl -fsS http://127.0.0.1:<web-port>/readyz
```

상태 확인에는 `releases/current/release.json`의 source SHA와
`images.lock.json`의 digest를 함께 남긴다. Web UI가 열리는 것만으로 완료 처리하지
말고 PDF·Posting·Ledger·Tax·Report 흐름과 EVM 한 건을 확인한다. `verify`는 별도의
PostgreSQL·Anvil에서 ReviewRoom canonical V2 E2E를 실행하고, `promote`는 같은
ReviewRoom digest로 migration을 완료한 뒤 API·anchor worker·delivery worker를 기동한다.

## 롤백

배포 후 문제가 발견되면 이전 manifest와 source 상태를 복구한다.

```bash
npm run mac-studio:release -- rollback
npm run mac-studio:release -- status
```

롤백은 `releases/previous`를 기준으로 source checkout과 서비스를 복구하고, 이전
ReviewRoom digest로 API·worker를 다시 기동한다. 운영 DB의 데이터를 삭제하거나
migration을 되돌리는 작업은 포함하지 않으므로, 데이터 복구가 필요하면 별도 백업
절차를 따른다.

## Release 전에 막히는 조건

- Production checkout에 tracked/untracked 변경이 남아 있음
- `origin/main`에 포함되지 않은 commit을 지정함
- Publisher가 해당 source SHA의 immutable image를 발행하지 않음
- image label의 `org.opencontainers.image.revision`이 manifest SHA와 다름
- 전체 E2E 검증 결과가 없거나 manifest가 검증 후 변경됨
- ReviewRoom Compose interpolation 파일 또는 workload별 secret env 파일이 없음

이 조건들은 우회하지 않는다. 먼저 작업 중인 변경을 별도 worktree나 PR로 옮기고,
필요한 image가 Publisher에 의해 성공적으로 발행된 뒤 새 Release를 만든다.

## 자동화의 경계

기존 main-sync cron은 더 이상 Production checkout을 이동시키지 않는다. 남아 있는
cron 항목은 다음 명령으로 제거할 수 있다.

```bash
sudo -H -u backwardlabs \
  /bin/bash /Users/Shared/Projects/01_Daejang/ops/main-sync/uninstall-main-sync.sh
```

Publisher와 image 정리는 계속 동작하지만, 현재·이전 Release가 참조하는 digest는
삭제 대상에서 보호한다. 오래된 Release를 보존해야 한다면 해당 Release의
`images.lock.json`을 지우지 않는다.
