# SHIFT 인수인계 (2026-11-01 기준)

다음 사람(개발자 또는 새 Claude Code 세션)이 이 문서 하나로 상황을 파악하고 이어갈 수 있도록 쓴 요약이다. 세부는 각 절에서 가리키는 문서를 본다.

## 1. 한 줄 요약

SHIFT는 경쟁 게임(FPS·격투·리듬) 전에 1~2분 동안 반응속도와 동체시력을 깨우는 무료 브라우저 워밍업 아케이드다. 죽림고수의 투사체 메커니즘을 참고했다. **코드는 완성·배포 상태**이고, 지금 남은 일은 도메인 연결과 광고(AdSense)뿐이다.

## 2. 현재 상태

| 항목 | 상태 |
| --- | --- |
| 소스 | `C:\dev\shift` (git main). 작업 트리 깨끗, 원격과 동일 |
| 원격 저장소 | https://github.com/byite1226-a11y/shift (공개) |
| 서비스 주소 | **https://byite1226-a11y.github.io/shift/** (GitHub Pages, 2026-10-24부터) |
| 배포 | main에 푸시하면 `.github/workflows/pages.yml`이 테스트 → 빌드 → 배포 (약 1분) |
| 테스트 | `npx vitest run` → 93 통과 / 6 건너뜀(진단용) |
| 광고 | 코드는 있으나 꺼져 있음(`VITE_ADSENSE_CLIENT` 미설정 → 번들에 광고 SDK가 아예 없음) |
| 도메인 | 미구입. 운영자가 `shiftwarmup.com`을 Cloudflare Registrar에서 사기로 결정(2026-10-27) |
| 온라인 랭킹 서버 | 보류(운영자 결정). 기록은 브라우저 로컬에만 저장 |

## 3. 실행·검증

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest 전체
npm run build      # tsc + vite → dist/
```

URL 파라미터: `?mode=A|C|D`(B는 숨김, `?mode=B`로만), `?diff=aware`(죽림고수형 프리셋), `?seed=42`, `?hit=1`(판정 영역), `?autopilot=1`(봇, 테스트용), `?adtest=1`(테스트 광고). debug 패널: `` ` `` 키 또는 우상단 debug.

검증 원칙: 단위 테스트와 빌드, 그리고 **브라우저는 백그라운드 탭에서 DOM·스크린샷 확인만** 한다. 운영자가 플레이 중인 탭을 새로고침하거나 거기서 봇을 돌리면 안 된다(실제로 라운드가 날아가 항의받음). 테스트 통과를 위해 허용치를 완화하지 않는다(Gate 02.1에서 지적받은 사항).

## 4. 게임 구성 (플레이어가 보는 것)

- 홈: 워드마크 SHIFT(점 없음, 140px·기울임·잔상·속도선, 도착 시 1회 슬라이드인), START, 모드 3개, BEST TIME, RANKING. 가장자리 투사체는 **정지 이미지**(움직이면 안 됨, 운영자 결정). SOUND 페이지는 debug 패널 뒤에만 있다.
- 모드: **DODGE**(A, WASD 회피) / **DEFEND**(C, 마우스 클릭 요격, 코어 체력 3) / **DUAL**(D, 회피+요격, 검은 armored 탄은 요격 불가). B(마우스 회피)는 코드만 남기고 숨김.
- 난이도: 무한 생존, LV1~10. A·D는 3초마다 레벨업(27초부터 LV10 고정), C는 5초. 프리셋 두 개 — 기본 `g3.1-27s`(`config/gate03.levels.json`, 패턴 플레이리스트)와 `?diff=aware`의 `g3.3-aware-27s`(`config/gate03.levels.aware.json`, 죽림고수형: 상시 조준탄 stream / 8방향 일렬탄 line / 동시 도착 일제사격 burst). 어느 쪽을 기본으로 할지는 **미결**.
- 결과 화면: 시간, 레벨, 이 기기 상위 10위에 들면 이니셜(영숫자 3자) 입력, RETRY/RANKING. 라운드 종료 시 광고 1회 호출(설정 시).
- 랭킹: 오락실식 HIGH SCORES, 기기 로컬, 모드별 탭. 서버 순위·상위 퍼센트는 서버 없이는 표시하지 않는다(지시서 원칙).
- 사운드: 전부 WebAudio 생성음. 효과음은 빠른 탄 예고 틱, 근접 통과, 요격/세이브, 코어 피격, 사망, 시작, 기록, UI만. **발사음·빈 클릭·레벨업 소리는 없음**(운영자 결정: "효과음이 많으면 정신사나움"). BGM은 칩튠 루프 두 편성(홈 / 게임 중), `public/assets/bgm.mp3`를 두면 그 파일 우선.

## 5. 코드 지도

```
index.html                 메타데이터(title/OG/JSON-LD VideoGame), HUD, 접힌 소개문, debug 패널
src/main.ts                DOM·입력·루프·홈/결과/보드/사운드 오버레이·기록·광고 호출
src/sim.ts                 순수 게임 로직(5 ms 고정 스텝, 스폰·공정성·충돌·판정·로그)
src/schedule.ts            seed → 스폰 스케줄 (PatternScheduler = g3.1, TimerScheduler = aware)
src/render.ts              Canvas 2D (잔상, 예고 마커, armored 먹색 틴트)
src/audio.ts               효과음·BGM 생성
src/ads.ts                 Google H5 Games Ads adBreak (env 없으면 dead code)
src/ranking.ts storage.ts roundstore.ts   로컬 기록·보드·플레이 로그
src/bot.ts                 스윕용 회피 봇
src/*.test.ts              단위 테스트 + seed 스윕 (gate03/dual/diag/sweep 등)
config/*.json              모든 튜닝 값 (코드에 숫자를 박지 않는다)
public/                    스프라이트, ads.txt(자리표시 pub id), privacy.html, llms.txt, robots.txt
.github/workflows/pages.yml  배포
docs/                      보고서·리뷰·플레이테스트·배포 문서, brief/에 기획 원본과 컨셉 이미지
```

경로 규칙: 스프라이트는 `import.meta.env.BASE_URL` 기준(하위 경로 `/shift/`에서도 동작). 줄 끝은 LF(`.gitattributes`).

## 6. 운영자(사용자)가 정한 규칙 — 어기면 안 됨

1. 코드 전면 재작성 금지. 확장만 한다.
2. 새 기획 결정이 필요하면 임의로 확정하지 말고 보고한다(미결 목록은 7절).
3. 서버 없이 가상의 순위·상위 퍼센트를 만들지 않는다.
4. 없는 이미지 자산을 비슷하게 재창작하지 않는다(원본을 요청).
5. 테스트 통과만을 위해 허용치를 완화하지 않는다.
6. 홈 화면은 실제 게이머가 보는 것만(디버그·사운드 페이지 노출 금지), 이미지는 움직이지 않는다.
7. 효과음은 적고 강하게. 투사체 발사·빈 클릭·레벨업은 무음.
8. 운영자가 쓰는 브라우저 탭을 건드리지 않는다. 확인은 백그라운드 탭·단위 테스트로.
9. 플레이어에게 보이는 모드 이름은 DODGE / DEFEND / DUAL (내부 id A/C/D는 그대로).

## 7. 다음 할 일 (순서대로)

### 7-1. 도메인 연결 — 운영자가 구입·DNS 입력 후, 코드 쪽은 Claude Code

운영자: Cloudflare에서 `shiftwarmup.com` 구입(약 $10.46/년) → ICANN 인증 메일 클릭 → Cloudflare DNS에 A ×4, AAAA ×4, CNAME www 레코드를 **Proxy 끔(DNS only)**으로 입력. 레코드 값과 화면 순서는 `docs/DEPLOY.md` 3절.

코드 쪽(도메인 이름을 들은 뒤):

```bash
gh api -X PUT repos/byite1226-a11y/shift/pages -f cname=shiftwarmup.com
```

1. `public/CNAME`에 `shiftwarmup.com` 한 줄.
2. `.github/workflows/pages.yml`의 `--base=/shift/` → `--base=/`.
3. `index.html`(og:url·canonical·JSON-LD url), `public/llms.txt`, `README.md`, `docs/DEPLOY.md`의 주소를 `https://shiftwarmup.com/`로 교체.
4. 푸시 → 배포 → DNS 반영 뒤 GitHub이 인증서를 발급하면 `gh api -X PUT repos/byite1226-a11y/shift/pages -F https_enforced=true`.
5. `https://shiftwarmup.com/`, `/ads.txt`, `/privacy.html`, `/llms.txt` 열리는지 확인. 기존 github.io 주소는 자동 리다이렉트.

### 7-2. AdSense — 운영자 로그인 필요

계정 생성 → 사이트 추가(`shiftwarmup.com`) → 심사 → H5 Games Ads 신청. 절차는 `docs/DEPLOY.md` 4절. 게시자 ID(`ca-pub-…`)가 나오면 코드 쪽:

```bash
gh variable set VITE_ADSENSE_CLIENT --repo byite1226-a11y/shift --body "ca-pub-XXXXXXXXXXXXXXXX"
```

그리고 `public/ads.txt`의 `pub-0000000000000000`을 실제 값으로 바꿔 푸시. `?adtest=1`로 테스트 광고 확인. 유럽 방문자를 받으면 AdSense 동의 메시지 설정.

### 7-3. 미결 기획 (운영자 결정 대기)

- 기본 프리셋: g3.1 유지 vs aware를 기본으로.
- DUAL의 요격 횟수 제한·킬 카운트 표시 여부(지금은 무제한, 표시 없음).
- B 모드 코드 삭제 시점.
- 온라인 전체 랭킹 서버(Supabase 설계 제안은 `docs/MECHANICS_REVIEW_gate03.md` 8절). 운영자가 "뒤로 미루자"고 함.
- 잠정값: 대형탄 반경 14, 동시 투사체 상한 32, 최소 스폰 거리 200 px, fan 가중치.

## 8. 알아 둘 함정

- Pages 사이트 생성은 Actions 토큰으로 안 된다(`configure-pages`의 enablement가 "Resource not accessible by integration"으로 실패). 이미 운영자 토큰으로 만들어 두었으니 이후 배포는 문제없다. 저장소를 다시 만들면 `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`를 한 번 실행해야 한다.
- Claude Code는 공개 저장소 생성·공개 전환 권한이 없다(권한 분류기 차단). 운영자가 GitHub 설정에서 한다.
- Vercel 커넥터는 프로젝트 생성이 403, CLI는 로그아웃 상태. 쓰려면 운영자가 대시보드에서 Import.
- AdSense는 `github.io`·`vercel.app` 같은 공유 서브도메인을 받지 않는다 → 도메인이 필요한 이유.
- 워크플로 로그의 "Node.js 20 is deprecated" 경고는 무해하다.
- Bash에서 한글이 들어간 `sed`는 깨진다. 한글 파일 수정은 Write 도구나 node 스크립트로.
- Git Bash에서 `--base=/shift/`가 로컬에서는 `/Program Files/Git/shift/`로 변환되어 보일 수 있다. Actions(Linux)에서는 정상.

## 9. 문서 지도

| 문서 | 내용 |
| --- | --- |
| `README.md` | 게임 설명, 실행법, URL 파라미터, 조작, 구조 |
| `docs/DEPLOY.md` | 배포·도메인·AdSense 절차(운영자 할 일 / 코드 할 일 구분) |
| `docs/MECHANICS_REVIEW_gate03.md` | 투사체 메커니즘 리뷰, aware 프리셋, 쫄깃함 튜닝, DUAL, armored, 랭킹, 사운드 결정 |
| `docs/REPORT_gate01~03.md` | 각 게이트 구현 보고서(지시서 대응) |
| `docs/PLAYTEST_GUIDE.md`, `PLAYTEST_FORM.md` | 플레이테스트 진행·기록 양식 |
| `docs/brief/` | 기획 지시서 원본, 컨셉 이미지(`gate03-concept/02_Screen_Concepts/01_Home.png`가 홈 시안) |
| `docs/logs/`, `docs/screenshots/` | 스윕 요약, 검증 캡처 |

## 10. 커밋 이력 (main)

```
33a0066 DEPLOY: domain candidates checked, DNS records and cut-over steps
e6e3b89 Docs: site live on GitHub Pages, runbook updated
1716702 GitHub Pages deployment: workflow with /shift/ base, base-relative sprite paths
43d9439 Deployment and AdSense runbook
5f14f45 Brand mark without the period: SHIFT
1f2facc Normalise line endings to LF
26ba702 SHIFT. Gate 03 prototype: endless survival arcade with DODGE / DEFEND / DUAL
```

그 이전(Gate 01~03, 홈·사운드·랭킹·DUAL 작업)은 스크래치 폴더에서 git 없이 진행되어 첫 커밋 `26ba702`에 한꺼번에 들어 있다. 변경 사유는 `docs/REPORT_*.md`와 `docs/MECHANICS_REVIEW_gate03.md`에 날짜별로 적혀 있다.
