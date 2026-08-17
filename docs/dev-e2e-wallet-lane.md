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

## Lane B — 실데이터 lane (`--profile wallet-real`)

운영 Mac Studio에 이미 인덱싱된 evm-indexer bulk store
(`ethereum-mainnet-bulk-tail-partial`, 블록 22,431,084→25,728,817)를 read-only로
마운트해 **임의 실지갑**을 수집한다. selection을 사전 materialize하지 않고
jitd가 요청마다 `evm-indexer query`를 실행하므로 지갑 주소 제약이 없다.
evidence 재수집(tx·trace)은 사용자의 개인 archive RPC로 한다.

### 실행

```bash
DAEJANG_DEV_E2E_WALLET_REAL=1 \
DAEJANG_DEV_E2E_ETH_RPC_URL=https://<개인 archive RPC> \
make dev-e2e-up
```

전제조건:

- `DAEJANG_EVM_INDEXER_DIR` (기본 `../daejang-evm-indexer`) — query 이미지를
  로컬 빌드한다.
- `DAEJANG_DEV_E2E_ETH_RPC_URL` — archive state + EIP-1898 + `finalized` tag +
  `debug_traceTransaction`(callTracer withLog, prestateTracer diffMode)을
  지원하는 개인 endpoint. **절대 커밋·로그에 남기지 않는다.** trace 미지원
  RPC여도 동작은 하지만 결과가 PARTIAL로 강등된다.
- 지갑은 등록 시 **Ethereum만** 선택한다(Optimism store는 아직 미배선).
- 지갑의 해당 블록 범위 후보가 **500건 미만**이어야 한다. 초과 시 sync job이
  `JIT_SELECTION_BUDGET_EXCEEDED`로 fail-closed된다(sync-worker 하드 상수).

### 동작과 기대 결과

- 수집 기간은 UI 고정 범위(2025-01-01~2026-08-11) 그대로 두면 된다 — bridge
  config가 이 범위를 store의 sealed 블록 범위로 매핑한다.
- **DeFi-Label 의미 분류가 포함된다.** jitd-real이
  `DAEJANG_DEFI_LABEL_DIR`(기본 `/Users/Shared/Projects/01_Daejang/DeFi-Label`)의
  서명된 action registry 릴리스로 ActionProof를 생성하고,
  `posting-evm-real`의 신뢰 핀(commit·bundleSha256)은 dev-e2e.sh가 실행 시점에
  같은 checkout의 `releases/action-registry-v1.json.receipt.json`에서 읽어
  주입한다. 등록된 프로토콜 액션(SWAP, LENDING SUPPLY/WITHDRAW,
  BRIDGE DEPOSIT/FILL, WRAP/UNWRAP)은 의미 분류된 posting으로,
  미등록·미완성 액션은 **objective posting**(`UNKNOWN`/
  `OBSERVED_ASSET_MOVEMENT` + `FEE`, `PARTIAL`/`DETECTED_ONLY`)으로 남는다 —
  registry 커버리지가 장부에서 그대로 드러난다.
- **registry 업데이트 테스트**: DeFi-Label에서 새 릴리스를 ship한 뒤
  `make dev-e2e-down` → 같은 명령으로 재기동하면 새 receipt의 핀과 registry가
  자동 반영된다. 같은 지갑을 다시 수집해 분류 변화를 비교한다(장부는
  append-only라 재분류는 새 revision으로 supersede된다).
- 가격을 모르는 토큰은 valuation `UNKNOWN` → 열린 Review가 생긴다(의도된
  테스트 데이터).
- wallet lane과 상태 볼륨을 공유하므로 **두 lane을 같은 실행에서 함께 켤 수
  없다**(스크립트가 거부).
- 실지갑을 수집한 뒤에는 `make dev-e2e-test`를 다시 돌리지 않는다 —
  pipeline-verify가 2025 과세연도 CEX fixture의 정확한 posting 수를 단정하는데
  실데이터 2025 posting이 섞이면 실패한다.
- bulk store의 sealed head는 계속 전진하지만 bridge coverage의 `toBlock`은
  의도적으로 고정돼 있다. 갱신하려면 compose의 `jit_bridge_real`과 jit-engine
  `indexer-real.json`을 store 상태와 함께 범프한다.
