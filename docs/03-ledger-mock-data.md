# 장부 검증용 Mock Data v5

> 상태: Draft
>
> 대상: 장부 작업 프론트엔드, 백엔드 API 설계, QA
> 구현: `apps/web/src/mocks/ledger.ts`

## 목적

백엔드 연결 전에도 거래별 전체 여정, 검토, 보류, 재검토, revision 반영을 같은 응답 형식으로 검증한다. 화면 문구에 거래 정보나 날짜를 직접 넣지 않고, 선택한 `transaction`에 연결된 `journey`와 `reviewTask`를 렌더링한다.

## Revision과 보고서 snapshot

- 검토 항목에서 사용자가 사실을 확정하면 기존 원본과 계산을 수정하지 않고 새 `revision`과 새 계산 결과를 만든다.
- 보류는 기존 revision을 유지하며, 보류 항목을 다시 열어 사실을 확정하는 시점에 새 revision을 만든다.
- `Revision 비교`는 `rev.4` 기준 계산부터 현재까지 생성된 모든 검토 revision을 보존해 보여준다.
- 보고서 생성은 현재 완료된 revision을 Web·PDF·CSV·JSON·Manifest가 공유하는 발행 snapshot으로 고정한다. 보고서 생성 자체는 revision 번호를 올리지 않는다.
- 과거 발행 snapshot(`rev.3`, `rev.4` 등)과 발행되지 않은 중간 계산 revision은 서로 다른 이력이다.

## 응답 단위

`LedgerTransactionsResponse.data.items[]`의 각 거래는 다음 정보를 포함한다.

| 객체 | 역할 | 주요 참조 |
| --- | --- | --- |
| `LedgerTransaction` | 목록과 현재 상태 | `id`, `occurredAt`, `statusCode` |
| `LedgerJourney` | 원본부터 발행까지의 추적 묶음 | `transactionId`, `economicEventId`, `eventId`, `currentRevisionId` |
| `LedgerJourneyStep` | 여정의 개별 증거 노드 | `evidenceId`, `key`, `status` |
| `LedgerReviewTask` | 검토 질문과 상태 전이 | `reasonCode`, `status`, `options` |
| `LedgerReviewOption` | 사용자가 확인할 사실과 계산 변화 | `resolutionCode`, `outcome`, `profitDeltaWon` |

프론트용 mock에서는 조회 편의를 위해 `journey`와 `reviewTask`를 거래에 포함한다. 실제 DB에서는 원본 artifact, observation, event/revision, posting, valuation, publication을 별도 append-only 엔티티로 저장하고 ID로 조인하는 형태를 권장한다.

## 대표 시나리오

화면에는 플로우 검증용 거래 24건을 반환하며, 전체 건수도 `items.length`에서 계산한다. 초기 상태는 확인 10건, 검토 9건, 보류 2건, 표시 전용 3건이다.

| 거래 | 일시 | 시작 상태 | 검증 목적 | 미해결 코드 |
| --- | --- | --- | --- | --- |
| `btc-sell` | 2027-03-14 09:12 | 잠정 | 취득 출처 선택 후 revision 생성 | `LOT_ACQUISITION_SOURCE_REQUIRED` |
| `eth-sell` | 2027-03-12 17:40 | 확인 | CEX 매도 전체 여정 | 없음 |
| `eth-transfer` | 2027-03-10 11:18 | 검토 | 본인 지갑·동일 세무주체 확인 | `OWNERSHIP_EVIDENCE_REQUIRED` |
| `token-swap` | 2027-03-08 21:05 | 보류 | DEX 가격 증거 재검토 | `PRICE_EVIDENCE_MISSING` |
| `nft-sell` | 2027-03-06 14:32 | 검토 | 취득 Lot 범위 확인 | `LOT_COVERAGE_PARTIAL` |
| `usdc-deposit` | 2027-03-05 08:26 | 확인 | 자기이체 연속성·무손익 여정 | 없음 |
| `bridge-deposit` | 2027-03-02 19:11 | 보류 | 브리지 자산 동일성 재검토 | `BRIDGE_IDENTITY_UNRESOLVED` |
| `staking-reward` | 2027-02-28 10:04 | 검토 | 스테이킹 보상 분류 | `REWARD_INCOME_CLASSIFICATION_REQUIRED` |
| `gas-fee` | 2027-02-24 16:22 | 확인 | 부대비용 연결 | 없음 |
| `wrap-eth` | 2027-02-20 13:08 | 확인 | 자산 표현 변경 | 없음 |
| `airdrop-receipt` | 2027-02-14 20:31 | 검토 | 에어드롭 목적 확인 | `AIRDROP_PURPOSE_REQUIRED` |
| `reverted-swap` | 2027-02-11 07:42 | 표시 전용 | 실패 거래와 gas 분리 | 없음 |
| `sol-sell` | 2027-02-08 18:14 | 확인 | 다른 거래소의 매도 Lot | 없음 |
| `lp-withdrawal` | 2027-02-06 12:46 | 검토 | DeFi 원금·보상 분리 | `LP_REWARD_SPLIT_REQUIRED` |
| `lending-interest` | 2027-02-03 09:37 | 검토 | 대출 원금·이자 구분 | `LENDING_YIELD_CLASSIFICATION_REQUIRED` |
| `usdt-depeg-settlement` | 2027-01-31 14:24 | 검토 | stablecoin 디페그 손실 분류 | `STABLECOIN_DEPEG_CLASSIFICATION_REQUIRED` |
| `restaking-reward` | 2027-01-30 08:52 | 검토 | 재스테이킹 보상 베스팅 확인 | `RESTAKING_REWARD_VESTING_REQUIRED` |
| `exchange-fee-rebate` | 2027-01-29 23:41 | 확인 | 거래소 수수료 환급 연결 | 없음 |
| `reorg-invalidated-transfer` | 2027-01-29 22:44 | 표시 전용 | chain reorg 무효화와 계산 제외 | 없음 |
| `bridge-withdrawal` | 2027-01-29 22:08 | 확인 | L1·L2 메시지 연결 | 없음 |
| `btc-buy` | 2027-01-24 15:21 | 확인 | 취득 Lot 생성 | 없음 |
| `validator-slashing` | 2027-01-18 06:42 | 확인 | 검증자 손실 | 없음 |
| `token-migration` | 2027-01-11 13:19 | 표시 전용 | 1:1 프로토콜 전환 | 없음 |
| `nft-mint` | 2027-01-04 20:05 | 확인 | NFT 취득원가 생성 | 없음 |

`eth-sell`과 `usdc-deposit`은 각각 다른 `occurredAt`, `sourceRecordId`, `eventId`, `revisionId`, `valuationId`를 가진다. 따라서 확인 거래에서 전체 여정을 열면 3월 12일과 3월 5일이 각각 표시되어야 한다.

## 상태 전이

```text
OPEN / provisional | needs_review
  ├─ 확인 가능한 사실 선택 → RESOLVED / confirmed / 새 revision
  ├─ "나중에" 선택       → ON_HOLD / on_hold
  └─ 미확정 선택          → ON_HOLD / on_hold

ON_HOLD / on_hold
  ├─ 보류함 거래 클릭     → on_hold 유지 / 기존 질문으로 검토 재개
  └─ 확인 답변 제출       → RESOLVED / confirmed / 보류함에서 제거
```

검토 화면으로 이동하는 것만으로 보류 상태를 해제하지 않는다. 사용자가 확인 가능한 답변을 제출해야 보류 건수와 목록에서 제거된다. 모르는 값, 가격 증거 누락, 브리지 동일성 미해결을 `0` 또는 `confirmed`로 자동 승격하지 않는다. 현재 구현은 `localStorage`의 `ledger-transactions.v5`에 전체 상태를 저장하므로 새로고침과 컴포넌트 재마운트 후에도 전이를 확인할 수 있다.

## 보고서 연결

`apps/web/src/mocks/reports.ts`는 별도의 화면용 숫자를 보관하지 않고 최신 `LedgerTransaction[]`에서 현재 보고서를 생성한다.

- 거래 수: `transactions.length`
- Coverage 완전: `statusCode === confirmed`
- Coverage 예외: 전체 거래 수에서 완전 건수를 뺀 값
- revision: 기준 `rev.4`에서 해결된 검토 사실마다 1씩 증가
- 예상 손익: `rev.4`의 875,000원에 해결된 `LedgerReviewOption.profitDeltaWon`을 누적
- CSV·JSON·Evidence Pack: 선택한 보고서가 참조하는 동일 거래 배열에서 생성

`deriveMockLedgerResult()`가 장부 요약과 보고서의 단일 계산 원본이다. 따라서 장부에서 검토 결과를 제출하고 거래 목록으로 돌아가거나 페이지를 다시 연 뒤 보고서로 이동해도 손익, 거래 수, Coverage, revision과 산출물 데이터가 같은 localStorage 상태를 사용한다.

## 자동 검증 규칙

`validateMockLedgerTransactions()`는 최소한 다음을 검사한다.

- 거래 ID 중복 금지
- `journey.transactionId === transaction.id`
- `journey.occurredAt === transaction.occurredAt`
- 검토·잠정·보류 거래의 `reviewTask` 필수
- 여정 전체의 `evidenceId` 중복 금지

컴포넌트 테스트는 ETH 매도와 USDC 입금이 서로 다른 날짜와 `sourceRecordId`를 표시하는지, 보류 거래 클릭이 원래 질문으로 돌아가는지 검증한다.

## 정책 문서 반영

Linear GIWA 팀 개요에 연결된 문서 8개를 확인했다.

- `GIWA-11 설계 — Architecture·Schema·DB·실행 코드 v1.3`: 증거 계층, append-only revision, closed reference
- `GIWA-11 내용 — 목적·결론·거래 예시·완료조건 v1.3`: CEX·DEX·fee·transfer 대표 거래
- `Compliance 정본 인덱스`: 미해결 항목의 검토 노출, 개인정보·표현 제한
- `[폐기된 초안] GIWA-18 관할별 과세 정책 v1.2`: 폐기 상태이므로 설계 기준에서 제외
- `기술 결정 사항`: partial·unsupported·failed와 reorg provenance
- `최종 제출 문서`: 수집 → 정규화·검토 → 근거 pack → GIWA 검증의 golden path
- `재무재표`: 팀 재무 문서로 장부 mock 데이터 요구사항에는 적용하지 않음
- `ㅇㅇ`: 완료된 결정이 없는 보관 문서로 적용하지 않음

세부 reason code와 전이에는 GIWA-17의 연간 총평균·자기이체 연속성, GIWA-18 `KRTaxDeFiEventPolicyV1`, GIWA-21 transfer 단위 소유권 확인, GIWA-43 멱등성·수집 상태, GIWA-49 observation/interpretation 분리 기준도 반영했다.

## 백엔드 연결 시 계약

백엔드가 준비되면 `readMockLedgerTransactions`, `submitMockLedgerReview`, `holdMockLedgerReview`, `resumeMockLedgerReview`를 같은 반환 타입의 API adapter로 교체한다. 프론트 컴포넌트는 거래 ID와 연결 객체만 읽으므로 화면 구조를 다시 작성할 필요가 없다.

백엔드는 다음 조건을 보장해야 한다.

- 원본 artifact와 observation은 수정하지 않는다.
- 사용자 답변은 새 revision으로 기록한다.
- 모든 posting은 균형을 이루고 event/revision을 참조한다.
- 미확정 reason code는 검토 또는 보류 상태로 종료한다.
- 발행 manifest에는 선택된 revision, 정책·엔진·스키마 버전과 digest를 포함한다.
- GIWA 온체인 commitment에는 지갑 주소, transaction hash, 원본 금융 데이터, 결정적 PDF hash를 기록하지 않는다.
