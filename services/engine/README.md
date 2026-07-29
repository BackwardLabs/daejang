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
| `DAEJANG_SOURCE_ARTIFACT_DATABASE_URL` | PDF source evidence artifact writer PostgreSQL DSN. 미설정 시 source DSN 사용 |
| `DAEJANG_SOURCE_ARTIFACT_ROOT` | 암호화 원본·subject-private parser evidence artifact root |
| `DAEJANG_SOURCE_ARTIFACT_TEMP` | 같은 filesystem에 있는 source artifact 임시 디렉터리 |
| `DAEJANG_QUERY_DATABASE_URL` | ledger·review read model 및 subject-scoped tax report 조회 PostgreSQL DSN (`daejang_query_app`) |
| `DAEJANG_REPORT_DATABASE_URL` | immutable report snapshot PostgreSQL DSN |
| `DAEJANG_REVIEW_DATABASE_URL` | Review revision·reference·outbox write PostgreSQL DSN |
| `DAEJANG_REVIEW_ARTIFACT_DATABASE_URL` | subject-private artifact writer PostgreSQL DSN |
| `DAEJANG_REVIEW_ARTIFACT_ROOT` | subject-private Review resolution artifact root |
| `DAEJANG_REVIEW_ARTIFACT_TEMP` | 같은 filesystem에 있는 Review artifact 임시 디렉터리 |
| `DAEJANG_PRIVATE_OBJECT_ROOT` | `sync-worker`가 검증하는 subject-private upload root |
| `PRIVATE_OBJECT_ENCRYPTION_KEY` | Web API와 공유하는 base64 32-byte AES-256-GCM object key |
| `DAEJANG_JIT_BRIDGE_CONFIG` | EVM source job을 `jitd`에 연결하는 JSON 설정 파일의 절대 경로 |
| `ENGINE_LISTEN` | gRPC listen 주소, 기본 `127.0.0.1:50051` |
| `ENGINE_TLS_CERT_PATH` | Engine server certificate |
| `ENGINE_TLS_KEY_PATH` | Engine server private key |
| `ENGINE_TLS_CLIENT_CA_PATH` | Web API client certificate를 검증할 CA |
| `ENGINE_WEB_API_CLIENT_DNS_NAME` | application RPC를 허용할 Web API 인증서 DNS SAN |
| `ENGINE_PDF_PARSER_SOCKET_PATH` | networkless parser sidecar와 공유하는 UDS의 절대 경로 |
| `ENGINE_PDF_PARSER_TIMEOUT` | UDS parser 요청 제한 시간. 기본 `30s` |
| `ENGINE_PDF_IMPORT_LEASE_DURATION` | 동기 PDF import job lease. 기본 `2m`, parser timeout보다 길어야 함 |

TLS 네 값은 함께 설정해야 합니다. CA가 발급한 다른 인증서가 사용자
`RequestContext`를 위조하지 못하도록 health RPC를 제외한 모든 RPC는 이 DNS
SAN이 정확히 포함된 Web API 인증서만 허용하며 wildcard SAN은 거부합니다. 별도 probe 인증서는 health
service만 호출할 수 있습니다. 같은 host에서 두 process를 운영할 때는 loopback
listen과 `ENGINE_ALLOW_INSECURE_LOOPBACK=true`를 명시적으로 사용할 수 있습니다.
이 경우 Web API도 `ENGINE_ALLOW_INSECURE_LOOPBACK=true`와
`ENGINE_GRPC_INSECURE_TARGET=127.0.0.1:50051`을 함께 설정해야 합니다. loopback이
아닌 plaintext target은 runtime mode와 무관하게 거부됩니다.

Review mutation은 네 Review 설정값을 모두 지정했을 때만 등록됩니다. Review
DSN은 `daejang_event_app` 수준의 review/reference 권한을, artifact DSN은
`artifactstore.Put` 권한을 가진 role을 사용합니다. 현재 production 예시는
Engine이 이미 보유한 `daejang_source_app` DSN을 artifact writer에도 재사용하며,
artifact-only role이 DB contract에 추가되면 그 role로 축소해야 합니다. 두 DSN은
artifact metadata를 ResolveV2 transaction에서 참조할 수 있도록 같은 물리
database를 가리켜야 합니다. 이 opt-in은
기존 Source·Workflow·Query 배포를 깨지 않기 위한 것이며, 활성화한 DB role에는
`reviewstore.ResolveV2`와 `artifactstore.Put`에 필요한 migration 16·17,
bounded evidence query 권한을 추가하는 migration 18이
있어야 합니다. Engine은 시작 시 `giwa62-review-resolution-v2` contract를
검증합니다. proof의 schema module digest는 환경변수가 아니라 Review가 열린
정확한 PARTIAL ledger revision의 immutable `schema_digest`에서 DB가
파생합니다. Query DSN의 role은 Review 상세에 표시할 bounded projection을 위해
`subject_evidence`의 published fragment·observation·account·asset을 읽을 수
있어야 하며, raw artifact나 observation detail JSON 권한은 필요하지 않습니다.
Review 기능이 활성화되면 Engine은 시작 시 이 evidence projection 권한을
preflight하고, 실행 중 health check에서도 반복 검증합니다. 따라서 DB migration
16 → 17 → 18을 모두 적용한 뒤 Engine을 배포해야 합니다. 브라우저와 Web API는
ReviewRoom이나 체인을 직접 호출하지 않고 Engine이 원자적으로 생성한
`ReviewResolved V2` event와 `REVIEWROOM`·`APPLICATION_ENGINE` delivery를
downstream worker 경계로 사용합니다. 상세 계약과 후속 의존성은
[Review 응답 흐름](../../docs/review-resolution-flow.md)에 정리되어 있습니다.

```bash
go test ./...
go vet ./...
go build ./...
go run ./cmd/engine-api
```

`daejang-db`의 sourcestore 변경이 먼저 병합되어야 합니다. 두 저장소를 동시에
개발할 때는 커밋되는 `replace` 지시문 대신 로컬 `go.work`로 두 module을 묶습니다.

### EVM source job → JIT 설정

`sync-worker`는 `jitd`의 실제 `CandidateQueryService`와 `JitEngineService`를
호출합니다. 같은 host에서는 kernel peer credential을 사용하는 절대
`unix:///...` endpoint만 허용하며, 원격 `tcp://host:port`는 CA·client
certificate·client key를 모두 지정한 mTLS만 허용합니다. 시작할 때 두 gRPC
service가 `SERVING`인지 확인하며 plaintext fallback은 없습니다.

JIT 계약은 날짜를 받지 않고 inclusive block range와 immutable candidate
selection을 받습니다. `jitd`에는 날짜를 block으로 변환하는 RPC가 없으므로,
배포 파이프라인이 같은 read-only index snapshot에서 검증한 정확한 매핑을 설정에
공급해야 합니다. Worker는 요청 시작일·종료일과 정확히 일치하는 매핑만 사용하고,
없으면 `JIT_COVERAGE_MAPPING_UNAVAILABLE`로 job을 닫습니다. 최근 block을
추측하거나 넓은 범위를 임의로 대신 사용하지 않습니다.

```json
{
  "endpoint": "unix:///var/run/daejang/jitd.sock",
  "requestTimeout": "10s",
  "pollInterval": "1s",
  "awaitTimeout": "15m",
  "tls": {},
  "chains": [
    {
      "chainId": "eip155:1",
      "chainStore": "ethereum-mainnet",
      "genesisHash": "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      "evidenceProfile": "EVM_ACCOUNT_FULL",
      "profileHash": "<64 lowercase hex characters>",
      "coverage": [
        {
          "coverageStart": "2027-01-01",
          "coverageEnd": "2027-12-31",
          "indexSnapshotId": "snapshot-2027",
          "fromBlock": 21400000,
          "toBlock": 24100000
        }
      ]
    }
  ]
}
```

여러 chain을 한 job에 넣으면 모든 mapping의 `indexSnapshotId`가 같아야 합니다.
날짜는 UTC calendar boundary로 정규화하고, inclusive 종료일은 JIT ownership
window의 exclusive 다음 날 00:00 UTC로 변환합니다. Worker는 selection을 만든 뒤
source job ID에서 안정적으로 파생한 generation ID로 run을 시작합니다. 응답 유실
후 같은 입력을 다시 보내도 JIT durable natural key가 같은 run을 반환하며, run ID가
source job에 저장된 다음부터는 재시작 시 새 run을 만들지 않고 polling만 재개합니다.

JIT의 `COMPLETE`와 `PARTIAL`은 둘 다 published
`subject_evidence_fragment_id`가 있을 때만 source job 성공으로 닫습니다.
`FAILED`, fragment 없는 terminal 응답, 알 수 없는 상태는 성공으로 승격하지
않습니다. 일시적인 transport/timeout 오류는 lease retry를 위해 job을 terminal
상태로 바꾸지 않지만, 잘못된 chain·coverage·snapshot·권한 요청은 명시적 실패
코드로 닫습니다.

현재 외부 계약상 남은 배포 전제는 index snapshot을 생성하는 운영 단계가 위
날짜→block mapping을 함께 검증·배포하는 것입니다. 이 값이 없으면 adapter와 인증
연결이 정상이어도 해당 기간의 EVM job은 의도적으로 실행되지 않습니다.

## 운영 프로세스

- `engine-api`: mTLS gRPC Source·Workflow·Query·Review API. 연결된 DB 중 하나라도
  응답하지 않으면 표준 gRPC health를 `NOT_SERVING`으로 내린다.
- `sync-worker`: `FOR UPDATE SKIP LOCKED`로 Sync Job을 임대한다. EVM wallet은
  검증된 snapshot/block mapping으로 JIT candidate selection과 terminal fragment를
  연결하고, Upbit PDF는 private object root의 무결성을 검증한다. 지원하지 않는
  소스는 안전한 실패 코드로 종료하며 원장 레코드를 임의 생성하지 않는다.
- `engine-healthcheck`: 별도 probe client 인증서로 gRPC Health Check를 수행한다.

운영 구성은 `deploy/compose.production.yaml`을 기준으로 한다. Engine 서버
인증서 SAN에는 `engine.internal`이 포함되어야 하며 Web client 인증서와 probe
client 인증서는 분리한다. Web client 인증서 DNS SAN에는
`ENGINE_WEB_API_CLIENT_DNS_NAME`의 값이 포함되어야 한다.

Engine 이미지 빌드는 private `BackwardLabs/daejang-db` module을 내려받기 위해
BuildKit secret `github_token`이 필요하다. 같은 secret으로 고정 커밋의 private
`BackwardLabs/pdf-parser` Python package도 별도 `parser-runtime` target에만 설치한다.
Engine runtime에는 Python·parser package가 포함되지 않는다. Parser service는 DB·TLS
환경변수와 artifact volume 없이 UDS volume만 공유하고, `network_mode: none`, read-only
root filesystem, tmpfs, capability 제거, no-new-privileges 및 자원 제한으로 실행된다.
연결마다 fork한 child가 한 요청만 처리한 뒤 종료하므로 password와 PDF parser 내부
복사본이 다음 요청까지 남지 않는다. Compose는 현재 shell의 `GH_PAT`을 build secret으로
전달하며 runtime 환경, image layer 또는 build argument에는 토큰을 남기지 않는다.

R1 MVP에서는 외부 본인확인 provider가 없으므로 Web API가 비교 대상 이름을 전달하지
않는다. Parser sidecar는 이름을 스스로 일치 처리하지 않고
`subjectMatch.status=INCONCLUSIVE`,
`policyRef=mvp-subject-comparison-skipped:v1`인 내부 evidence를 만든다. Engine은 이
정확한 조합만 MVP 미확인 경로로 허용하며 `MISMATCH`나 다른 policy는 계속 거부한다.
업로드 소유권, 파일 크기·digest, 비밀번호 일회성 전달과 parser 격리는 그대로 유지한다.

```bash
GH_PAT="$(gh auth token)" docker compose \
  --env-file deploy/production.env \
  -f deploy/compose.production.yaml build engine pdf-parser sync-worker
```
