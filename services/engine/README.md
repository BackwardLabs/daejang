# Source Engine API

`services/engine`은 Web API가 durable 데이터 소스를 등록·조회·연결 해제할
때 사용하는 private gRPC 서비스입니다. Web API는 `source_private`를 직접
읽거나 쓰지 않으며 이 서비스가 `daejang_source_app` 역할로 접근합니다.

## 계약 생성

루트의 `proto/giwa/engine/v1/engine.proto`가 정본입니다.

```bash
buf lint
buf generate
```

## 실행 설정

| 환경 변수 | 용도 |
| --- | --- |
| `DAEJANG_SOURCE_DATABASE_URL` | `daejang_source_app` PostgreSQL DSN |
| `DAEJANG_QUERY_DATABASE_URL` | ledger·review read model PostgreSQL DSN |
| `DAEJANG_REPORT_DATABASE_URL` | immutable report snapshot PostgreSQL DSN |
| `ENGINE_LISTEN` | gRPC listen 주소, 기본 `127.0.0.1:50051` |
| `ENGINE_TLS_CERT_PATH` | Engine server certificate |
| `ENGINE_TLS_KEY_PATH` | Engine server private key |
| `ENGINE_TLS_CLIENT_CA_PATH` | Web API client certificate를 검증할 CA |

TLS 세 값은 함께 설정해야 합니다. 로컬 통합 테스트에서만 loopback listen과
`ENGINE_ALLOW_INSECURE_LOOPBACK=true`를 사용할 수 있습니다. 이 경우 Web API도
`ENGINE_GRPC_INSECURE_TARGET=127.0.0.1:50051`을 설정합니다. 두 plaintext opt-in은
production에서 거부됩니다.

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/engine-api
```

`daejang-db`의 sourcestore 변경이 먼저 병합되어야 합니다. 두 저장소를 동시에
개발할 때는 커밋되는 `replace` 지시문 대신 로컬 `go.work`로 두 module을 묶습니다.

## 운영 프로세스

- `engine-api`: mTLS gRPC Source·Workflow·Query API. 연결된 DB 중 하나라도
  응답하지 않으면 표준 gRPC health를 `NOT_SERVING`으로 내린다.
- `sync-worker`: `FOR UPDATE SKIP LOCKED`로 Sync Job을 임대하고 private object
  root의 Upbit PDF 무결성을 검증한다. 지원하지 않는 소스는 안전한 실패 코드로
  종료하며 원장 레코드를 임의 생성하지 않는다.
- `engine-healthcheck`: 별도 probe client 인증서로 gRPC Health Check를 수행한다.

운영 구성은 `deploy/compose.production.yaml`을 기준으로 한다. Engine 서버
인증서 SAN에는 `engine.internal`이 포함되어야 하며 Web client 인증서와 probe
client 인증서는 분리한다.

Engine 이미지 빌드는 private `BackwardLabs/daejang-db` module을 내려받기 위해
BuildKit secret `github_token`이 필요하다. Compose는 현재 shell의 `GH_PAT`을 이
secret으로 전달하며 이미지 layer나 build argument에는 토큰을 남기지 않는다.

```bash
GH_PAT="$(gh auth token)" docker compose \
  --env-file deploy/production.env \
  -f deploy/compose.production.yaml build engine sync-worker
```
