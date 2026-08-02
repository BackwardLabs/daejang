# Tax·Posting 로컬 container 검증

이 절차는 개인 clone에서만 Tax Engine, Posting Service와 로컬 PostgreSQL을
하나의 Compose project로 실행한다. 운영 DB, 운영 secret, 운영 artifact와
Supervisor/launchd runtime을 사용하지 않는다.

## 준비

각 경로는 자신의 clone을 가리켜야 한다. 공용 checkout을 지정하지 않는다.

```sh
export DAEJANG_DB_DIR="$HOME/code/daejang/daejang-db"
export DAEJANG_TAX_ENGINE_DIR="$HOME/code/daejang/daejang-tax-engine"
export DAEJANG_POSTING_SERVICE_DIR="$HOME/code/daejang/daejang-posting-service"
export DAEJANG_LOCAL_RUNTIME_DIR="$HOME/code/daejang/local-worker-runtime"
export DAEJANG_WORKERS_RUNTIME_ENV_FILE="$HOME/code/daejang/workers.runtime.env"
export COMPOSE_PROJECT_NAME="daejang-${USER}-task"
```

`DAEJANG_WORKERS_RUNTIME_ENV_FILE`은 [example](../deploy/workers.runtime.env.example)에서
시작하되 repository 밖에 둔다. `DAEJANG_LOCAL_RUNTIME_DIR`에는 test-only로 서명한
Tax/Posting 정책·ownership·activation·quote artifact를 각각 `tax/`, `source/`,
`evm/` 하위에 둔다. production bundle이나 production credential을 복사하지 않는다.

두 Go image는 private `daejang-db` module을 build하므로, build 시에만 읽기 전용
GitHub PAT를 BuildKit secret으로 전달한다. 이 값은 env 파일·image layer·로그에 넣지
않는다.

```sh
export DAEJANG_GITHUB_TOKEN='test-only-read-token-from-secret-manager'
```

main image publish도 같은 읽기 권한을 가진 `CROSS_REPO_READ_TOKEN` Actions secret을
각 Tax·Posting repository에 요구한다. 이 token은 DB 접속 권한이 아니라 private
`daejang-db` Go module을 받기 위한 GitHub repository Contents: Read 권한이다. secret이
없으면 publish workflow는 image build 전에 원인을 출력하고 중단한다.

## 로컬 실행

먼저 DB clone에서 `.env.example`을 자신의 `.env`로 복사해 local-only DB password를
설정한다. 그 뒤 Daejang repository root에서 다음을 실행한다.

```sh
docker compose \
  --env-file "$DAEJANG_DB_DIR/.env" \
  --env-file "$DAEJANG_WORKERS_RUNTIME_ENV_FILE" \
  -f "$DAEJANG_DB_DIR/compose.yaml" \
  -f deploy/compose.workers.local.yaml \
  --profile tools --profile source --profile tax \
  up --build
```

EVM writer도 확인할 때만 `--profile evm`을 추가한다. source/tax/evm worker는 모두
실제 signed test bundle을 요구하며, bundle이 없거나 pin이 맞지 않으면 fail-closed로
시작을 거부하는 것이 정상이다. 이 Compose가 migration을 적용하고 role을 만든 뒤
worker를 시작하므로 host PostgreSQL이나 운영 포트를 공유하지 않는다.

중지와 정리는 project 이름을 명시해 수행한다.

```sh
docker compose \
  --env-file "$DAEJANG_DB_DIR/.env" \
  -f "$DAEJANG_DB_DIR/compose.yaml" \
  -f deploy/compose.workers.local.yaml \
  --project-name "$COMPOSE_PROJECT_NAME" \
  down --volumes
```

## release image 재검증

PR 전에는 위 명령으로 local image를 build해 검증한다. main에서 GHCR에 publish된 뒤에는
기록된 `image@sha256:...`를 pull하고 같은 local project에서 image tag를
`daejang-taxd:local`, `daejang-posting-service:local`로 임시 tag한 뒤 `up --no-build`로
실행한다. 이때만 source를 다시 build하지 않고, 검증한 digest를 배포 후보로 기록한다.

Tax Engine은 `DAEJANG_TAXD_DB_MIGRATION_VERSION`과 DB/JIT/schema pin이 bundle과
일치해야 한다. 현재 pin을 무시하고 최신 다른 repository main과 섞어 실행하는 것은
통합 검증이 아니다.
