# SHIFT. | Gate 01: 핵심 재미 및 조작 방식 비교

버전: 0.3 / 상태: 설계 완료, 구현 및 플레이테스트 전 / 2026-10-15

## 이 패키지의 목적

'마우스 기반 요격 게임'을 확정하지 않는다. 먼저 하나의 공통 아트 디렉션 안에서 **회피 메커니즘과 요격 메커니즘**, **키보드와 마우스 조작**을 분리해서 검증한다.

- **A / DODGE-KEYS**: WASD 또는 방향키로 작은 캐릭터를 이동시켜 투사체 회피
- **B / DODGE-MOUSE**: 마우스가 가리키는 지점으로 캐릭터가 일정 속도로 이동하면서 회피
- **C / DEFEND-MOUSE**: 고정된 중앙 코어로 접근하는 투사체를 마우스 클릭으로 요격

A 대 B는 조작 방식 비교, B 대 C는 동일한 마우스 입력에서 메커니즘 비교. 세 모드의 생존 시간을 직접 상대 비교해 '동체시력' 우열로 평가하지 않는다.

## 포함 파일

1. `01_product_direction.md`: 제품 원칙과 이번 실험의 결정 사항
2. `02_gameplay_specs.md`: 실제 구현 가능한 A/B/C 상세 게임 규칙과 수치
3. `03_visual_system.md`: UI/아트 디렉션과 고정 토큰
4. `04_claude_code_task.md`: Claude Code에 전달할 구현 지시서
5. `05_playtest_gate.md`: 실험 설계 및 합격/반려 기준
6. `assets/gate01_comparison.png`: 세 모드 비교 디자인 보드
7. `assets/gate01_comparison.svg`: 비교 디자인 보드 벡터 원본
8. `assets/preview_A.svg`, `preview_B.svg`, `preview_C.svg`: 각각의 디자인 화면 시안

## 추천 실행 순서

1. `assets/gate01_comparison.png`를 보고 시각 방향을 확인한다.
2. Claude Code가 `04_claude_code_task.md`를 중심으로 01~03 문서를 읽고 코드를 구현한다.
3. 실 플레이를 녹화/스크린샷/로그로 검증한다.
4. `05_playtest_gate.md` 기준으로 세 가지 중 어떤 핵심 메커니즘을 본게임으로 선택할지 결정한다.

## 주의

이 ZIP에는 **실행 가능한 게임 코드가 없다**. 코드는 사용자 요청에 따라 Claude Code가 작성하도록 명세만 제공한다. 디자인 시안은 실제 게임 실행 화면이 아니라 구조와 톤 검토용 정적 시각 자료다.
