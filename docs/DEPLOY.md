# 배포와 광고 설정 (2026-10-24)

프로젝트 위치: `C:\dev\shift` (git, main). 이 문서는 공개 배포와 AdSense 연결에 필요한 순서를 전부 적은 것이다. 1·2(배포)는 끝났고, 3·4(도메인·AdSense)는 계정과 결제가 필요해 운영자가 직접 한다.

## 1. GitHub 저장소 — 완료 (공개, 2026-10-24)

저장소 `https://github.com/byite1226-a11y/shift`는 처음 비공개로 만들어 푸시했고(Claude Code는 공개 저장소 생성·공개 전환 권한이 막혀 있다), 2026-10-24 운영자가 Settings → Danger Zone에서 Public으로 바꿨다. 공개 저장소를 쓰는 이유: Pages 무료 플랜은 공개 저장소에서만 되고, 개인정보 처리방침의 문의 링크가 `github.com/byite1226-a11y/shift/issues`이며, README가 검색·AI 답변에 읽힌다.

## 2. 호스팅: GitHub Pages — 가동 중

**https://byite1226-a11y.github.io/shift/** 에서 서비스 중이다(2026-10-24 첫 배포, 홈 렌더링·스프라이트·privacy/ads/robots/llms 파일 모두 확인). `.github/workflows/pages.yml`이 main에 푸시될 때마다 테스트 → `npm run build -- --base=/shift/` → Pages 배포를 한다(약 1분). 주소는 `index.html`의 og:url·canonical·JSON-LD url에 들어가 있고, 스프라이트 경로는 `import.meta.env.BASE_URL` 기준이라 하위 경로에서도 깨지지 않는다.

Pages 사이트 자체는 워크플로의 `configure-pages`가 만들지 못한다(Actions 토큰에는 Pages 생성 권한이 없어 "Resource not accessible by integration"으로 실패). 운영자 토큰으로 `gh api -X POST repos/byite1226-a11y/shift/pages -f build_type=workflow`를 한 번 실행해 켰고, 이후 배포는 자동이다. 수동 재배포: `gh workflow run pages.yml --ref main`.

Vercel은 연결된 커넥터의 권한이 프로젝트 생성을 허용하지 않아(403) 쓰지 못했다. 나중에 Vercel로 옮기려면 대시보드에서 "Import Git Repository"로 이 저장소를 가져오면 되고(빌드 설정 자동), 그때 og:url 세 곳을 새 주소로 바꾼다.

## 3. 도메인 (AdSense를 쓰려면 필요) — 다음 단계

AdSense는 `github.io`나 `vercel.app` 같은 **공유 서브도메인 사이트를 받지 않는다**. 광고를 붙이려면 직접 소유한 도메인(예: `shiftgame.kr`)이 있어야 하고, `ads.txt`가 도메인 루트(`https://도메인/ads.txt`)에 있어야 한다. 순서: 도메인 구입 → GitHub Pages 설정의 Custom domain에 입력(DNS CNAME) → `index.html`의 og:url·canonical·JSON-LD url과 Pages 워크플로의 `--base=/`로 변경(루트 호스팅이 되면 `/shift/` 접두사가 사라진다). 이 변경은 Claude Code가 한다.

## 4. Google AdSense (운영자)

1. https://adsense.google.com 에서 계정을 만들거나 로그인한다(Google 계정, 주소, 본인 확인, 지급 정보).
2. "사이트" → 사이트 추가 → 배포 주소 입력. 소유권 확인은 AdSense 코드 스니펫 또는 `ads.txt`로 한다. `public/ads.txt`에 발급받은 `pub-…`를 넣어 다시 배포하면 `ads.txt` 방식으로 확인된다.
3. 심사(보통 며칠~2주). 심사 기준: 충분한 콘텐츠, 개인정보 처리방침 접근 가능(`/privacy.html`, 소개문에서 링크됨), 탐색 가능. 게임 설명이 접힌 "SHIFT는 어떤 게임인가요?" 섹션에 있다.
4. 승인 뒤 AdSense → 게임(H5 Games Ads) 신청. 이것이 라운드 종료 전면 광고(`adBreak`)에 쓰는 상품이다.
5. 발급된 게시자 ID `ca-pub-XXXXXXXXXXXXXXXX`를 알려 주면 Claude Code가:
   - GitHub 저장소 변수 `VITE_ADSENSE_CLIENT=ca-pub-…`(Settings → Secrets and variables → Actions → Variables; `gh variable set`으로도 가능)를 넣고 재배포한다. 워크플로가 이 값을 빌드에 넘기고, 없으면 광고 코드가 번들에 아예 들어가지 않는다.
   - `public/ads.txt`의 `pub-0000000000000000`을 실제 값으로 바꾼다.
6. 유럽(EEA·영국·스위스) 방문자를 받을 거면 AdSense → 개인정보 보호 및 메시지에서 GDPR 동의 메시지를 켠다. 한국만 대상이면 생략 가능.

## 5. 배포 후 확인 (함께)

- `https://<주소>/?adtest=1`로 접속해 한 판 끝내면 결과 화면에서 테스트 광고가 떠야 한다(승인 전에도 테스트 광고는 나온다). debug 패널 → "광고 테스트"로 라운드 없이도 호출 상태(`breakStatus`)를 볼 수 있다.
- `https://<주소>/ads.txt`, `/privacy.html`, `/robots.txt`, `/llms.txt`가 열리는지 본다.
- 광고가 실제로 나오기 시작하면 빈도(`src/ads.ts`의 `FREQUENCY_HINT`, 기본 30초)를 플레이 길이에 맞춰 조정한다. 짧은 판이 많으면 60초 이상을 권한다.

## 6. 참고

- `.env.example`에 환경 변수 이름이 있다. 로컬에서 광고를 보려면 `.env.local`에 같은 값을 넣는다(커밋되지 않음).
- 기록 서버(온라인 전체 랭킹)는 보류 상태다. 붙일 때의 설계는 `docs/MECHANICS_REVIEW_gate03.md` 8절과 2026-10-22 제안을 따른다.
