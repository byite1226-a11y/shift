# SHIFT — Gate 03 무한 생존 프로토타입

경쟁 게임(FPS·격투·리듬) 전에 1~2분 동안 반응속도와 동체시력을 깨우는 무료 브라우저 워밍업 아케이드. 설치·로그인 없음. A free browser warm-up arcade for competitive gamers: reaction time and dynamic visual acuity training with bullet-dodge, click-intercept and combined modes.
A DODGE(키보드 회피) / C DEFEND(마우스 요격) / D DUAL(키보드로 피하면서 마우스로 요격, 2026-10-21 추가) 세 모드를 한 화면에서 골라 플레이하는 브라우저 아케이드. B(마우스 회피)는 2026-10-21 플레이테스트 후 선택 화면에서 숨겼고 `?mode=B`로만 실행된다. D는 A와 같은 dodge 스케줄·난이도 버전을 쓰고(같은 키 입력이면 A와 동일한 월드), C의 15 px 클릭 판정으로 투사체를 지울 수 있으며, 투사체에 한 번 닿으면 종료된다. 요격은 횟수·쿨다운 제한이 없다. **검은 탄(armored)은 요격 불가**: 대형탄은 항상, 그리고 레벨 설정에서 `armored: true`로 표시한 타이머(aware 프리셋의 일제사격)가 해당하며 먹색으로 그려진다(D에는 클릭 링을 그리지 않는다, 판정 15 px은 C와 동일). 기록은 모드별로 분리된다.
Gate 03: 시간 제한 없는 생존, A는 LV.1~10이 3초씩(27초부터 LV.10 고정, 2026-10-21 이전 5초/45초), C는 5초씩(45초), C 코어 체력 3, Option B 투사체, 모드별 개인 기록. 이전 규칙은 `?sched=g1|g2`로만 실행된다.
홈 화면(2026-10-21)은 `docs/brief/gate03-concept/02_Screen_Concepts/01_Home.png` 시안을 따른다: 필드 오버레이 안에 워드마크, START, 모드 행, BEST TIME, 가장자리에 비행 중인 투사체 정지 구도(실제 스프라이트 PNG + CSS 잔상·파편, 애니메이션 없음). 라운드가 시작되면 같은 자리에 HUD와 필드가 드러나 레이아웃이 움직이지 않는다. 플레이어에게 보이는 모드 이름은 DODGE(탄막 회피) / DEFEND(코어 방어) / DUAL(회피 + 요격)이고, 기록·URL의 A/B/C/D 식별자는 그대로다.
랭킹(2026-10-22): 오락실식 HIGH SCORES. 라운드가 이 기기 보드의 상위 10판에 들면 결과 화면에서 이니셜(영숫자 3자)을 입력해 등록하고, 홈의 RANKING / 결과 화면의 RANKING이 모드별 탭(같은 규칙 버전만)의 상위 10판을 순위·이니셜·시간·레벨로 보여준다. 이 브라우저에서 플레이한 모든 기록이 대상이며, 서버 순위나 상위 퍼센트는 Gate 03 지시서대로 표시하지 않는다(`src/ranking.ts`의 서버 계약은 그대로; 서버가 붙으면 같은 표에 온라인 순위를 넣는다). 결과 화면은 시간·레벨·(이니셜 입력 또는 BEST)·RETRY/RANKING으로 줄였고, 시드와 평균은 debug 패널과 내보내기에만 남는다.
배포(2026-10-24): **https://byite1226-a11y.github.io/shift/** 에서 서비스 중. GitHub 저장소 `byite1226-a11y/shift`(공개)의 main에 푸시하면 `.github/workflows/pages.yml`이 테스트·빌드·GitHub Pages 배포를 자동으로 한다. 절차와 AdSense 연결은 `docs/DEPLOY.md`.
광고(2026-10-23, `src/ads.ts`): 라운드가 끝나 결과 화면이 뜰 때 Google H5 Games Ads(AdSense Ad Placement API)의 `adBreak({type:'next'})`를 한 번 호출한다. 실제 표시 여부는 Google이 정하고(빈도 힌트 30초, 재고, 승인 상태), 광고가 떠 있는 동안 재시작·시작 입력은 막힌다. `VITE_ADSENSE_CLIENT`(`.env.local`, `.env.example` 참고)가 없으면 SDK를 아예 싣지 않아 로컬과 광고 차단 브라우저에서는 아무 변화가 없다. `?adtest=1`은 테스트 광고 모드. debug 패널의 "광고 테스트"로 라운드 없이 호출해 상태(`breakStatus`)를 볼 수 있다. 광고를 실제로 켜려면 직접 소유한 도메인과 AdSense 승인이 필요하다(`docs/DEPLOY.md` 3·4절).
사운드(2026-10-23 확정, `src/audio.ts`): 전부 생성음이고 파일은 없다. 게임에서 나는 효과음은 빠른 탄 예고(틱), 근접 통과, 요격·세이브, 코어 피격, 사망, 시작, 기록 등록, 모드 선택·일시정지·재개뿐이다. 투사체 발사(낱개·일제사격·일렬탄), 빈 클릭, 레벨 상승은 사용자 결정으로 소리를 내지 않는다. 소리는 필드의 x 위치로 좌우 패닝된다. BGM은 내장 칩튠 루프(E단조 132 BPM 4마디) 두 편성: 홈 = 킥·스네어·베이스, 게임 중 = 같은 것 + 뒷박 하이햇 + 스퀘어 아르페지오, 레벨에 따른 변화 없음. 일시정지에 멈추고 결과에서 페이드아웃한다. `public/assets/bgm.mp3`를 넣으면 내장 루프 대신 그 파일을 반복 재생한다. 첫 입력 전에는 아무 소리도 나지 않고(자동재생 금지), 사운드 토글 하나로 전부 끈다. 홈의 SOUND 페이지에서 모든 효과음(꺼 둔 것은 흐리게)을 상황 설명과 함께 하나씩 들어볼 수 있고 BGM 홈/게임도 들을 수 있다.

- 기획·디자인 원본: `docs/brief/`
- 보고서: `docs/REPORT_gate01.md`, `docs/REPORT_gate02.md`, `docs/REPORT_gate02_1.md`, `docs/REPORT_gate03.md`
- 플레이테스트: `docs/PLAYTEST_GUIDE.md`(진행·수집 항목), `docs/PLAYTEST_FORM.md`(기록 양식)
- 튜닝값: `config/gate01.constants.json`(월드·반경·속도), `config/gate02.patterns.json`(패턴·속도표·공정성), `config/gate03.levels.json`(레벨 1~10, C 체력·레벨, 유효성 기준)

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: 판정/시간/좌표/스케줄/패턴/공정성 스윕(60 seed)
npm run build      # tsc 타입검사 + vite 빌드 → dist/
```

더 큰 스윕과 요약 파일:

```bash
SWEEP_SEEDS=200 SWEEP_REACTION=250 SWEEP_WRITE=1 npx vitest run src/sweep.test.ts   # → docs/logs/sweep-summary.json
```

URL 파라미터

| 파라미터 | 뜻 |
| --- | --- |
| `mode=A|B|C` | 시작 모드 |
| `seed=42` 또는 `seed=playtest-3` | seed 고정(매 판 같은 스케줄) |
| `sched=g1|g2` | 이전 40초 규칙으로 실행(비교용, 기록은 suspect) |
| `autopilot=1` | A 모드를 봇이 조작(재현 가능한 화면·로그용 테스트 훅). 기본은 기하 봇 A, `bot=reactive`면 제한 반응 봇 B |
| `hit=1` | 판정 영역 표시 켠 채 시작 |
| `diff=aware` | 죽림고수형 프리셋(g3.3-aware-27s): 상시 조준탄(stream, LV8+ 빠른 티어·예고) · 8방향 일렬탄(line 9~13발, 플레이어 중심) · 동시 도착 일제 조준 사격(burst)이 각각 독립 주기로 발사. LV6부터 탄속 ≥ 플레이어 260. 발사 시점 위치 조준, 예측 없음. 기본은 g3.1 |

## 조작

| 상황 | 키 |
| --- | --- |
| 시작 / 재시작 | Space, R, Enter 또는 화면 클릭 |
| A 이동 | WASD / 방향키 (대각선 정규화) |
| B 이동 | 마우스 포인터가 목표점, 캐릭터가 260 px/s로 따라감 |
| C 요격 | 표적 위에서 왼쪽 클릭 (판정 반경 15 px) |
| 일시정지 / 재개 | ESC (탭 포커스를 잃으면 자동 일시정지) |
| 디버그 패널 | ` 키 또는 우상단 debug — seed 고정, FPS·카운터, 로그 JSON 다운로드, 판정 영역 표시 |

## 구조

```
config/gate01.constants.json  월드, 플레이어/코어/투사체 반경, C 설정, Gate 01 스케줄(C가 사용)
config/gate02.patterns.json   투사체 종류, 속도 3단계, 공정성 규칙, 패턴 그룹(속도표), 페이즈 리듬
src/sim.ts        순수 게임 로직: 상태 머신, 5 ms 고정 스텝, 스폰(예고·반대편 폴백·빠른탄 캡), 스윕 충돌, 로그
src/schedule.ts   seed → 스폰 스케줄. buildSchedule(Gate 01) / buildPatternSchedule(Gate 02)
src/bot.ts        스윕용 탐욕 회피 봇(반응시간 모델)
src/geom.ts       선분-점 거리(스윕 판정), 포인터 → 960×540 논리 좌표 변환
src/render.ts     Canvas 2D 렌더링, 속도 비례 잔상, 예고 마커, 판정 영역 디버그 오버레이
src/main.ts       DOM, 입력, 루프, 오버레이, 기록 저장, 디버그
src/audio.ts      WebAudio 생성 효과음 (제스처 후에만, 음소거 토글)
src/storage.ts    localStorage 모드별 최고기록 + 최근 200판
src/*.test.ts     단위 테스트 + seed 스윕
docs/screenshots  검증 캡처, docs/logs 스윕 요약·판별 로그
```

## 기록·로그

- 모드별 최고기록과 최근 200판 결과는 브라우저 localStorage(`shift.gate01.records.v1`)에 저장.
- 판별 이벤트/샘플 로그는 메모리에 최근 10판만 보관, 디버그 패널에서 JSON으로 내려받음. 화면에는 노출하지 않음.
