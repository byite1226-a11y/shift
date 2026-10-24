# 배포와 광고 설정 (2026-10-24)

프로젝트 위치: `C:\dev\shift` (git, main). 이 문서는 공개 배포와 AdSense 연결에 필요한 순서를 전부 적은 것이다. 코드 쪽 준비는 끝나 있고, 아래 1·4·5는 계정 로그인이 필요해 운영자가 직접 한다.

## 1. GitHub 저장소 (운영자 1회)

Claude Code는 공개 저장소를 만드는 권한이 막혀 있어 이 한 줄만 직접 실행한다. `gh`는 이미 `byite1226-a11y`로 로그인돼 있다.

```powershell
cd C:\dev\shift; gh repo create byite1226-a11y/shift --public --source . --remote origin --push
```

- 공개 저장소를 쓰는 이유: 개인정보 처리방침의 문의 링크가 `github.com/byite1226-a11y/shift/issues`이고, README가 검색·AI 답변에 읽힌다.
- 비공개로 하려면 `--public`을 `--private`으로 바꾸고, `public/privacy.html`의 문의 링크를 이메일 등으로 바꿔야 한다.

## 2. Vercel 연결 (Claude Code가 함)

저장소가 생기면 Vercel 팀 `byite`(team_9wQHbXANVNEThyJrl87TWyYl)에 Git 연동 프로젝트를 만든다. 설정은 Vite 자동 감지(빌드 `npm run build`, 출력 `dist`). 이후 main에 푸시할 때마다 자동 배포된다.

## 3. 주소 기입 (Claude Code가 함)

배포 주소(`https://<project>.vercel.app`)를 `index.html`의 `og:url`과 JSON-LD `url`에 넣고 커밋·푸시한다.

## 4. Google AdSense (운영자)

1. https://adsense.google.com 에서 계정을 만들거나 로그인한다(Google 계정, 주소, 본인 확인, 지급 정보).
2. "사이트" → 사이트 추가 → 배포 주소 입력. 소유권 확인은 AdSense 코드 스니펫 또는 `ads.txt`로 한다. `public/ads.txt`에 발급받은 `pub-…`를 넣어 다시 배포하면 `ads.txt` 방식으로 확인된다.
3. 심사(보통 며칠~2주). 심사 기준: 충분한 콘텐츠, 개인정보 처리방침 접근 가능(`/privacy.html`, 소개문에서 링크됨), 탐색 가능. 게임 설명이 접힌 "SHIFT는 어떤 게임인가요?" 섹션에 있다.
4. 승인 뒤 AdSense → 게임(H5 Games Ads) 신청. 이것이 라운드 종료 전면 광고(`adBreak`)에 쓰는 상품이다.
5. 발급된 게시자 ID `ca-pub-XXXXXXXXXXXXXXXX`를 알려 주면 Claude Code가:
   - Vercel 환경 변수 `VITE_ADSENSE_CLIENT=ca-pub-…`(Production)을 넣고 재배포한다. 이 변수가 없으면 광고 코드가 번들에 아예 들어가지 않는다.
   - `public/ads.txt`의 `pub-0000000000000000`을 실제 값으로 바꾼다.
6. 유럽(EEA·영국·스위스) 방문자를 받을 거면 AdSense → 개인정보 보호 및 메시지에서 GDPR 동의 메시지를 켠다. 한국만 대상이면 생략 가능.

## 5. 배포 후 확인 (함께)

- `https://<주소>/?adtest=1`로 접속해 한 판 끝내면 결과 화면에서 테스트 광고가 떠야 한다(승인 전에도 테스트 광고는 나온다). debug 패널 → "광고 테스트"로 라운드 없이도 호출 상태(`breakStatus`)를 볼 수 있다.
- `https://<주소>/ads.txt`, `/privacy.html`, `/robots.txt`, `/llms.txt`가 열리는지 본다.
- 광고가 실제로 나오기 시작하면 빈도(`src/ads.ts`의 `FREQUENCY_HINT`, 기본 30초)를 플레이 길이에 맞춰 조정한다. 짧은 판이 많으면 60초 이상을 권한다.

## 6. 참고

- `.env.example`에 환경 변수 이름이 있다. 로컬에서 광고를 보려면 `.env.local`에 같은 값을 넣는다(커밋되지 않음).
- 기록 서버(온라인 전체 랭킹)는 보류 상태다. 붙일 때의 설계는 `docs/MECHANICS_REVIEW_gate03.md` 8절과 2026-10-22 제안을 따른다.
