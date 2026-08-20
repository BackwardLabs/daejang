# Host binary 컨테이너화 로드맵

목표: 호스트 supervisor(LaunchAgent) 아래에서 실행 중인 잔류 프로세스를
단계적으로 image로 전환해, 최종적으로 production 배포 전체를 digest 고정
compose로 운영한다. 각 단계는 dev-e2e에서 먼저 검증한 뒤 production compose로
승격한다.

## 현재 상태

| 구성 요소 | 상태 |
| --- | --- |
| web-api · engine · pdf-parser · nginx | production compose 전환 완료 (digest 고정, mTLS) |
| reviewroom api/delivery/anchor | 컨테이너 운영 중 |
| posting-service (posting-worker + evm-posting-worker) | Registry image 발행 중 — 컨테이너 상주는 미전환 |
| tax-engine (taxd) | Registry image 발행 중 — 호스트 상주 |
| jit-engine (jitd) | runtime image 존재 (dev-e2e 검증) — 호스트 상주 |
| sync-worker | engine-runtime image에 포함 — 호스트 상주 (jitd peer-UID socket 의존) |
| evm-indexer | **Dockerfile 없음** — 호스트 상주 |
| upbit-candle-sync | tax-engine 저장소 binary — 호스트 상주, 전용 image 없음 |
| jitd·sync-worker dev 검증 | dev-e2e `wallet` profile로 컨테이너 조합 검증 가능 ([지갑 lane](dev-e2e-wallet-lane.md)) |

## 단계

### 1. evm-indexer 최소 image

`query` 오프라인 실행(+ bulk store read-only 접근)이 가능한 최소 Dockerfile을
`daejang-evm-indexer`에 추가한다. jitd 컨테이너에서 `--indexer-binary`로 쓸 수
있게 jit-engine image에 `COPY --from` 주입하는 변형도 함께 검토한다. 이 단계가
끝나면 dev-e2e Lane B(실데이터 lane)를 구현할 수 있다. bulk `portal-run`
상주(인덱싱 쓰기 경로)의 컨테이너화는 자원 상한(cpus/mem) 설정과 함께 별도로
다룬다 — 현재 호스트에서 CPU를 과점하는 문제의 완화책이기도 하다.

### 2. jitd + sync-worker의 tcp+mTLS 전환

production compose에는 이미 sync-worker 서비스 정의와 tcp bridge config 마운트
지점이 있다 (`deploy/compose.production.yaml`의 sync-worker 블록과 jitd 외부
배치 주석). 전환 순서:

1. dev-e2e에 `wallet-mtls` profile을 추가해 jitd `--tls-*` + sync-worker
   `tcp://` bridge(mTLS 3종)를 조합 검증한다. unix socket lane과 달리 subject
   ACL은 mTLS identity에 명시적 `subjects` 목록이 필요하다(`allowAnySubject`
   불가) — 운영 subject provisioning 절차를 함께 설계한다.
2. jitd를 컨테이너로 승격하고 evm-indexer(1단계 image)와 bulk store 마운트를
   연결한다. Etherscan V2 selection driver의 API key는 컨테이너 secret으로
   전달한다.
3. sync-worker 호스트 프로세스를 내리고 production compose의 sync-worker를
   활성화한다(단일 실행 보장: 동시 실행 금지 절차 문서화).

### 3. posting-worker · evm-posting-worker 상주 컨테이너화

image는 이미 존재하므로 claim policy와 trust key를 compose secret/config로
전달하는 배선만 필요하다. single-writer 보장을 위해 호스트 프로세스 중지와
컨테이너 기동을 원자적으로 전환하는 runbook을 먼저 작성한다.

### 4. taxd 상주 컨테이너화

3중 핀(schema/JIT/DB commit)과 migration 버전 핀을 compose env로 옮기고, 공용
checkout dirty 감지 같은 호스트 전제 동작을 컨테이너 환경에 맞게 재정의한다.

### 5. upbit-candle-sync

전용 target을 tax-engine Dockerfile에 추가하고 archive root를 volume으로
옮긴다.

### 6. release 절차 편입

각 신규 image는 기존 build-once-deploy-many 절차를 따른다: main 병합 →
Mac Studio publisher가 Registry `latest` 발행 → 검증된 digest를 release
manifest(`images.env`)에 고정 → `promote` 후 compose 재기동. host supervisor
의존(GUI 세션, `backend.env`)은 해당 구성 요소가 compose로 승격될 때마다
지원 목록에서 제거한다.

전환이 끝나면 데이터 경로는 다음 한 줄로 정리된다: 모든 서비스가 digest 고정
image로 compose에서 상주하고, 호스트에는 Docker와 release 도구만 남는다.
