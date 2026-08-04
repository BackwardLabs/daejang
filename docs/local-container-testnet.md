# Tax·Posting image local testnet

이 testnet은 개인 clone의 disposable PostgreSQL과 Tax·Posting의 Docker **test target**만
사용한다. 운영 DB, 운영 runtime bundle, 운영 Supervisor와는 연결하지 않는다.

## 준비

```sh
export DAEJANG_DB_DIR="$HOME/code/daejang/daejang-db"
export DAEJANG_TAX_ENGINE_DIR="$HOME/code/daejang/daejang-tax-engine"
export DAEJANG_POSTING_SERVICE_DIR="$HOME/code/daejang/daejang-posting-service"
export DAEJANG_GITHUB_TOKEN='read-only-token-from-secret-manager'
export COMPOSE_PROJECT_NAME="daejang-${USER}-test"
export POSTGRES_PORT=58432
```

`DAEJANG_GITHUB_TOKEN`은 private `daejang-db` Go module을 build할 때만 BuildKit secret으로
사용한다. `.env`, image layer, Compose container 환경에는 넣지 않는다. Posting의 Python
회귀 테스트는 test stage에서 고정된 `DeFi-Label` commit을 임시 clone한다. DB clone의
`.env.example`을 local-only `.env`로 복사해 별도 password를 선택한다.

## 실행

Daejang repository root에서 실행한다.

```sh
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$DAEJANG_DB_DIR/.env" \
  -f "$DAEJANG_DB_DIR/compose.yaml" \
  -f deploy/compose.workers.test.yaml \
  --profile tools --profile test \
  up -d --build test-gate

docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$DAEJANG_DB_DIR/.env" \
  -f "$DAEJANG_DB_DIR/compose.yaml" \
  -f deploy/compose.workers.test.yaml \
  --profile tools --profile test \
  wait test-gate
```

실행 순서는 `postgres → bootstrap-roles → migrate → posting-tests → tax-tests → test-gate`다.
Posting test는 private DB client와 Python materialization adapter를 검사하고, Tax test는
같은 disposable schema에서 race-enabled Go test를 실행한다. Tax test가 fixture를 seed할
때만 disposable DB owner를 쓰며, 실제 `taxd` 컨테이너는 계속 `daejang_tax_app` 권한을
쓴다. signed 운영 policy나 실제 publication을 넣지 않는다.

결과 확인 뒤 만든 test 데이터만 제거한다.

```sh
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$DAEJANG_DB_DIR/.env" \
  -f "$DAEJANG_DB_DIR/compose.yaml" \
  -f deploy/compose.workers.test.yaml \
  --profile tools --profile test \
  down --volumes --remove-orphans
```
