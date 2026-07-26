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
