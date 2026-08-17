# dev-e2e 지갑(EVM) lane

이 문서는 로컬 dev-e2e에서 지갑 소스의 전체 경로(등록 → sync job → jitd 수집 →
EVM posting → 장부/UI 표시)를 실행·검증하는 방법과, 실데이터 lane의 미검증
경계를 설명한다.

## Lane A — 결정적 fixture lane (`--profile wallet`)

CEX 파이프라인만 있던 dev-e2e에 다음 서비스가 `wallet` compose profile로 추가된다.

| 서비스 | 역할 |
| --- | --- |
| `jit-fixture` | `jit-dev-e2e` prepare — 사전 materialize된 selection, jitd runtime 설정, subject ACL, JIT claim policy 생성 |
| `jit-permissions` | fixture 산출물과 socket/artifact 볼륨을 jitd uid(10001)로 정리 |
| `jit-rpc` | 결정적 stub EVM JSON-RPC (`debug_traceTransaction` 포함) |
| `jitd` | 실제 JIT daemon (unix socket, 개인 checkout에서 빌드한 candidate image) |
| `sync-worker` | engine-runtime image의 sync-worker — `source_private.sync_jobs`를 lease해 jitd로 실행 |
| `posting-evm` | `evm-posting-worker --mode canonical` claim-polling — JIT publication을 canonical ledger로 변환 |

### 실행

```bash
make test-wallet
```

또는 지속형 Web UI 환경에 lane을 포함하려면:

```bash
DAEJANG_DEV_E2E_WALLET=1 make dev-e2e-up
```

전제조건:

- `DAEJANG_JIT_ENGINE_DIR` (기본 `../daejang-jit-engine`)에 개인 소유
  daejang-jit-engine checkout. candidate image는 이 checkout에서 per-user 태그로
  빌드된다.
- `SCHEMA_DIR` (기본 `/Users/Shared/Projects/01_Daejang/schema`). 공유 Docker
  데몬은 개인 checkout(`/Users/wiimdy/...` 등 700 권한)을 bind-mount할 수 없어
  공용 read-only checkout을 기본값으로 사용한다.

### 웹 UI로 직접 테스트할 때

- 본인 브라우저 지갑을 쓰려면 그 주소로 환경을 띄운다:
  `DAEJANG_DEV_E2E_WALLET=1 DAEJANG_DEV_E2E_WALLET_ADDRESS=0x<주소> make dev-e2e-up`
  (기본값은 hardhat 테스트 키 #0 주소 `0xf39f…9266`.)
- 지갑 등록 화면에서 **수집 네트워크는 Ethereum만** 체크한다. fixture는
  `eip155:1`만 구성돼 있어 Optimism이 포함되면 coverage 조회에서 실패한다.
- 수집 기간은 현재 지갑 flow가 고정 범위(`EVM_WALLET_COVERAGE_*_DATE` 상수,
  2025-01-01~2026-08-11)만 보내므로 그대로 두면 된다. bridge config에 이 범위가
  매핑돼 있으며, UI 상수가 바뀌면 compose의 `jit_bridge` coverage도 함께 바꿔야
  한다.
- 수집 완료 후 장부 화면에서 **연도 2026**을 선택하면 fixture 거래
  (2026-07-30)가 보인다.

### 결정적 불변식

sync-worker → jitd 경로에서 selection 재사용은 scope
`(indexSnapshotId, chainStore, chainId, genesisHash, address, blockRange, profileHash)`
의 정확한 일치로만 성립한다. 다음 값들은 서로 맞물려 있으며 하나를 바꾸면 전부
함께 바꿔야 한다.

| 값 | 위치 |
| --- | --- |
| 지갑 주소 `0xf39f…9266` (고정 테스트 키의 주소) | compose `DAEJANG_JIT_DEV_E2E_FROM_ADDRESS`, `apps/web-api/src/sources/evm-pipeline.e2e.test.ts` |
| coverage `2026-07-30` (fixture 블록 시각의 날짜) | compose `jit_bridge` config, EVM e2e 테스트 |
| snapshot `jit-dev-e2e-snapshot-dev-e2e` | compose `DAEJANG_JIT_DEV_E2E_SUFFIX=dev-e2e`, `jit_bridge` config |
| 블록 302086, chain `eip155:1`, profileHash `e`×64 | jit-engine fixture 상수, `jit_bridge` config |

검증은 `RUN_EVM_PIPELINE_E2E_TESTS=1`로 게이트된
`apps/web-api/src/sources/evm-pipeline.e2e.test.ts`가 수행한다: 고정 키 지갑
등록 → sync job 생성 → `SUCCEEDED` 폴링 → JIT publication `PUBLISHED` + posting
생성 → ledger API(2026 과세연도) 노출.

이 lane은 ActionProof를 생성하지 않는다(jitd `--defi-label-dir` 미지정). 따라서
DeFi 액션 분류·`REVIEW_REQUIRED` 경로는 커버하지 않으며, 자산 이동 Observation의
posting까지가 범위다.

## Lane B — 실데이터 lane (설계, 미구현)

운영 Mac Studio에 이미 인덱싱된 evm-indexer bulk store를 read-only로 재사용해
실지갑 주소의 selection을 만드는 lane이다. `evm-indexer query`는 RPC 없이
온디스크 store만 읽으므로 인덱싱 시간 없이 실데이터 selection이 가능하다.

구성 스케치 (Lane A의 `jitd` 서비스 변형):

```yaml
jitd-real:
  profiles: ["wallet-real"]
  image: ${DAEJANG_JIT_CANDIDATE_IMAGE}
  command: [--config, /e2e/runtime.yaml, --selection-dir, /var/lib/daejang/selections,
            --indexer-binary, /usr/local/bin/evm-indexer,
            --indexer-config, /e2e/indexer-real.json,
            --schema-dir, /opt/daejang/schema, --subject-acl, /e2e/subject-acl.json]
  environment:
    ENV_POSTGRES_DSN: ${JIT_DATABASE_URL}
    ENV_RPC_URL_ETHEREUM_MAINNET: ${DAEJANG_DEV_E2E_ETH_RPC_URL:?archive RPC URL이 필요합니다}
  volumes:
    - ${DAEJANG_EVM_INDEXER_DATA:-/Users/Shared/Projects/01_Daejang/evm-indexer-data}:/var/lib/daejang/evm-index:ro
```

구현 전에 해소해야 하는 경계:

1. **evm-indexer 이미지가 없다.** `daejang-evm-indexer`에는 Dockerfile이 없어
   컨테이너 안에서 `query`를 실행할 방법부터 만들어야 한다
   ([컨테이너화 로드맵](containerization-roadmap.md) 참조). jitd 이미지에
   `COPY --from`으로 주입하는 방안 포함.
2. **evidence 수집용 archive RPC.** selection 이후 tx·receipt·
   `debug_traceTransaction`(prestateTracer) 재조회는 실제 archive RPC가 필요하다.
   운영 secret은 dev 검증에 사용할 수 없으므로 사용자가 자신의 RPC URL을
   `DAEJANG_DEV_E2E_ETH_RPC_URL`로 제공해야 한다.
3. **bulk store 권한.** 호스트 store는 `2750/0640`(sharedRead 그룹) 권한이다.
   컨테이너 uid(10001)와의 매핑, macOS virtiofs의 그룹 매핑 동작은 미검증이다.
4. **coverage 구성.** 실지갑 주소는 사용자마다 다르고 bridge config의 coverage
   항목(스냅샷 ID, 블록 범위)도 대상 store에 맞춰야 하므로 정적 config로는
   불가능하다. env 치환 또는 사용자별 config 생성 스텝이 필요하다.
5. **로컬 체인 대안은 불성립.** evm-indexer는 `headTag=finalized`를 강제하므로
   anvil 등 로컬 체인 인덱싱으로 이 lane을 대신할 수 없다.
