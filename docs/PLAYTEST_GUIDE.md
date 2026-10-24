# Gate 02.2 플레이테스트 실행 가이드

메커니즘·난이도는 Gate 02.1 그대로다. 이 문서는 진행자용이다. 설문과 관찰 기록 양식은 `PLAYTEST_FORM.md`.

## 준비

```bash
npm install
npm run build && npm run preview     # http://localhost:4173  (또는 npm run dev → :5173)
```

- 데스크톱 브라우저(Chrome 권장), 창을 1440×900 이상으로. 마우스 모드(B/C)는 마우스 사용.
- 백틱(`) 또는 우상단 debug 로 디버그 패널을 열고 **참가자** 칸에 ID(P01…)를 넣는다. `?tester=P01`로도 된다. 입력은 저장되며 모든 라운드 로그에 붙는다.
- 사운드는 참가자가 켜고 끌 수 있다.

## 세션 절차 (참가자 1명 ≈ 15분)

1. 설명 5초 이하: "최대한 오래 버티세요. 한 번 실패하면 끝입니다."
2. 모드 순서는 `05_playtest_gate.md`대로 참가자마다 순환: A→B→C, B→C→A, C→A→B.
3. 모드마다 최대 3판. 1판은 이해 확인용, 2~3판을 기록·재미 비교용으로 본다.
4. A와 B를 같은 스케줄로 비교하려면 디버그 패널의 seed를 고정(예: 42)하고 두 모드 모두 그 seed로 플레이한다. C는 Gate 01 스케줄이라 숫자를 A/B와 비교하지 않는다.
5. 세 모드가 끝나면 설문 5문항 + 강제 선택 + 심층 질문(양식 참고).
6. **참가자가 끝날 때마다 "로그 JSON 다운로드"**를 누른다. 파일명 `shift-playtest-<참가자>-<시각>.json`. 라운드 로그는 IndexedDB에 저장되므로 새로고침·탭 종료 후에도 남지만, 다운로드 전 창을 닫으려 하면 경고가 뜬다.
7. 다음 참가자 전에 참가자 ID를 바꾸고, 원하면 "세션 로그 초기화"(다운로드 확인 후)와 "기록 초기화"(PB 초기화)를 누른다.

## 다운로드 JSON에 들어가는 것

| 항목 | 위치 |
| --- | --- |
| 참가자·세션 ID, 브라우저·DPR·뷰포트, 설정 전체 | 최상위 `tester`, `sessionId`, `client`, `config`, `patterns` |
| 모드별 개인 기록(판수, CLEAR 수, 최고, 중앙, 평균, 최근 5판) | `recordsByMode`(전체), `recordsByModeForTester`(현재 참가자). 모드 간 합산 없음 |
| 라운드별: 모드, seed, 스케줄(g1/g2), 생존시간, 종료 사유 | `rounds[i].mode/seed/schedule/survivalMs/endReason` |
| 마지막 충돌 투사체: 종류·단계·속도·패턴·그룹·생성시각·폴백 여부·예고 여부·보인 시간 | `rounds[i].summary.lastHit` |
| 사망 직전 3초 리플레이(20 ms 간격: 플레이어 위치, 입력 방향/포인터 목표, 모든 투사체 위치) | `rounds[i].lastSeconds`. 투사체 속도·방향은 `events`의 `spawn`(x, y, angle, speed, t)에 있어 전 구간 재구성 가능 |
| 패턴 비중: 조준/일제(volley)/부채꼴 생성 수, 그룹별 발생·생성·예정, 페이즈·단계별 | `rounds[i].accounting.spawnedPattern / groupStarts / spawned / planned / spawnedPhase / spawnedTier / notFired` |
| 발사 원점 폴백: 시각, 발사 예정 시각, 그룹, 원래 변→바뀐 변, 위치, 전후 거리·비행시간 | `rounds[i].summary.flips` (= `events` 중 `flip`). 해당 스폰에는 `flipped: true, fromSide` |
| 예고: 마커 시각·위치·발사 예정 시각 | `events` 중 `telegraph`; 스폰의 `telegraphId`로 연결 |
| C 클릭: 모든 클릭 좌표, 명중 시 중심 거리와 코어 잔여 시간, 빗나감 시 최근접 표적 거리·ID | `events` 중 `click` / `hit.dist` / `miss.nearestDist` |
| 100 ms 전 구간 샘플, 일시정지, near miss, 프레임 통계 | `rounds[i].samples / events / frames` |

## 주의

- 봇 생존율(`docs/logs/sweep-*.json`)은 난이도 판단 근거가 아니다. 사람 데이터와 설문으로 판단한다.
- 결과 화면에는 생존시간·PB·seed만 보인다. 진단·등급 표시는 없다.
- `?autopilot=1`, `?hit=1`, `?sched=g1`은 분석용 훅이다. 참가자 세션에서는 쓰지 않는다.
- `?diff=aware`는 죽림고수형 프리셋(g3.2)이다. 기록은 difficultyVersion `g3.2-aware`로 따로 저장되므로 g3.1과 번갈아 플레이해도 개인 최고가 섞이지 않는다. 어느 쪽을 했는지 기록지에 적는다.
