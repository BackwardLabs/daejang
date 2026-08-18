# Canonical Posting → 대장 E2E 대조

이 절차는 canonical worker가 발행한 ActionProof·Event·Posting과 대장 조회 결과,
현재 Lot 계보와 검토 상태를 동일한 `(subject, chainId, txHash)` 좌표에서 대조한다.
운영 데이터는 조회만 하며 migration, 재분류, worker 재시작을 수행하지 않는다.

## 안전 경계

- DB URL은 기본적으로 `DAEJANG_QUERY_DATABASE_URL`에서만 읽는다.
- `DAEJANG_POSTING_DATABASE_URL`을 지정하면 실행을 거부한다.
- 모든 DB 연결에 `default_transaction_read_only=on`을 강제한다.
- DB role이 `daejang_event_app`이면 실행을 거부한다.
- subject, transaction hash, Event ID, leg ID는 기본 출력에서 SHA-256 축약값으로
  치환한다. 운영자가 제한된 로컬 증적에 원문이 꼭 필요한 경우에만
  `--include-identifiers`를 명시한다.
- 기본 표본은 대장 공개 read model이 받을 수 있는 lowercase UUID subject만
  포함한다. 개발용 문자열 subject는 표본에서 제외한다.

## 1. 검증 및 빌드

운영 checkout이 아니라 개인 clone 또는 격리 worktree에서 실행한다.

```bash
cd <isolated-daejang-clone>/services/engine
gofmt -w cmd/ledger-crosscheck/*.go
go test ./cmd/ledger-crosscheck
go vet ./cmd/ledger-crosscheck
go build ./cmd/ledger-crosscheck
```

Mac Studio에서 production `engine` 컨테이너 안에 실행할 바이너리는 현재 image
architecture에 맞춰 별도로 만든다.

```bash
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -trimpath \
  -o /private/tmp/ledger-crosscheck \
  ./cmd/ledger-crosscheck

docker cp \
  /private/tmp/ledger-crosscheck \
  daejang-engine-1:/tmp/ledger-crosscheck
```

## 2. 전체 표본 실행

`engine` 컨테이너는 query DB URL을 이미 환경으로 받는다. URL 값을 셸이나 로그로
출력하지 않고 바이너리만 실행한다.

```bash
docker exec daejang-engine-1 \
  /tmp/ledger-crosscheck \
  --sample-limit=100 \
  --timeout=2m
```

출력은 transaction report와 마지막 summary로 구성된 JSONL이다. finding이 없으면
exit 0, 대조 finding이 있으면 exit 2, 설정·DB·인코딩 오류이면 exit 1이다.

특정 사용자의 한 거래만 재현할 때는 세 좌표를 모두 고정한다.

```bash
docker exec daejang-engine-1 \
  /tmp/ledger-crosscheck \
  --subject='<lowercase UUID>' \
  --chain-id='eip155:10' \
  --tx-hash='<0x-prefixed lowercase hash>' \
  --sample-limit=1
```

`--chain-id`와 `--tx-hash`는 함께 사용해야 하고 exact transaction 실행에는
`--subject`도 필수다.

## 3. Optimism ActionProof 존재 여부만 판정하는 SQL

하네스를 아직 배포하지 못한 DB 세션에서도 아래 읽기 전용 SQL로 증상 ②의 하한을
확인할 수 있다. `eip155:10` count가 0이면 현재 canonical ActionProof-backed Event 중
Optimism 거래가 하나도 없다는 확정 증거다. 0보다 크다는 결과는 DB에 표본이 존재한다는
뜻이며, 특정 사용자나 실거래의 발견 성공까지 증명하지는 않는다.

```sql
BEGIN READ ONLY;

WITH action_observation AS (
  SELECT DISTINCT
    revision.subject_id,
    reference.observation_fragment_id,
    reference.observation_id
  FROM ledger.interpreted_event AS event
  JOIN ledger.event_revision AS revision
    ON revision.subject_id = event.subject_id
   AND revision.event_id = event.event_id
   AND revision.revision_id = event.current_revision_id
  JOIN ledger.action_proof_effect_observation AS reference
    ON reference.subject_id = revision.subject_id
   AND reference.action_proof_id = revision.action_proof_id
  WHERE revision.action_proof_id IS NOT NULL
), coordinate AS (
  SELECT
    action.subject_id,
    transaction.chain_id,
    transaction.transaction_hash::text AS transaction_hash
  FROM action_observation AS action
  JOIN subject_evidence.observation AS observation
    ON observation.subject_id = action.subject_id
   AND observation.fragment_id = action.observation_fragment_id
   AND observation.observation_id = action.observation_id
  JOIN subject_evidence.account_transaction_link AS link
    ON observation.origin_kind = 'TRANSACTION'
   AND link.subject_id = observation.subject_id
   AND link.fragment_id = observation.fragment_id
   AND link.account_transaction_link_id = observation.origin_link_id
  JOIN chain_evidence.chain_transaction AS transaction
    ON transaction.chain_transaction_id = link.chain_transaction_id
)
SELECT
  chain_id,
  count(DISTINCT (subject_id, transaction_hash)) AS transaction_count
FROM coordinate
WHERE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
GROUP BY chain_id
ORDER BY chain_id;

ROLLBACK;
```

## 판정 코드

| code | 의미 |
| --- | --- |
| `LEDGER_EVENT_MISSING` | canonical current Event가 대장 read model에 없음 |
| `LEDGER_EVENT_DUPLICATE` | 같은 Event ID가 대장 결과에 두 번 이상 나타남 |
| `TRANSACTION_COORDINATE_NOT_EXACT` | Event는 있지만 좌표가 EXACT가 아니거나 입력 거래와 다름 |
| `ACTION_MISMATCH` | ActionProof/profile/binding 또는 Event 분류가 canonical 행과 다름 |
| `POSTING_MISSING` | canonical leg가 대장 결과에 없음 |
| `POSTING_DUPLICATE` | 같은 leg가 대장 결과에 두 번 이상 나타남 |
| `POSTING_UNEXPECTED` | canonical Posting에 없는 leg가 대장 결과에 나타남 |
| `POSTING_MISMATCH` | account/asset/direction/quantity/role이 canonical Posting과 다름 |
| `ASSET_DECIMALS_MISMATCH` | source asset decimal과 대장 decimal이 다름 |
| `LOT_LINEAGE_MISMATCH` | current canonical lot 행과 `lotread.EventLineage` 결과가 다름 |
| `LOT_LINEAGE_READ_FAILED` | 실제 대장 Lot reader가 해당 Event 계보를 읽지 못함 |
| `REVIEW_STATE_MISMATCH` | canonical review current state와 대장 표시 상태가 다름 |
| `REVIEW_REQUIRED_MISSING` | PARTIAL/불완전 해석/valuation pending인데 review state가 없음 |
| `FALLBACK_ACTION_COEXIST` | 한 거래에 `event-action:`과 `event-objective:`가 함께 존재 |
| `OPTIMISM_COVERAGE_MISSING` | UUID subject 기준 Optimism ActionProof 거래 표본이 0건 |

정상적인 한 거래의 여러 protocol Action은 서로 다른 Event ID이므로 중복으로 보지
않는다. 위험 신호는 같은 Event ID의 반복 또는 canonical Action Event와 objective
fallback Event의 공존이다.

## 결과 보관

PR과 일반 채팅에는 마지막 summary와 finding code별 집계만 남긴다. 원문 식별자를
포함한 JSONL을 만들어야 한다면 저장소 밖의 제한된 운영 증적 경로에 두고 권한과 보존
기간을 별도로 관리한다. DB URL, 사용자 UUID, transaction hash를 PR 본문에 복사하지
않는다.
