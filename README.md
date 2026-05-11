<div align="center">

<img src="./assets/acorn.png" width="120" height="120" alt="Acorn" />

# Acorn 🌰

**병렬 Claude Code 세션을 한 창에서.**
*Parallel Claude Code sessions in one window — split panes, isolated git worktrees, native PTY terminals.*

AI는 강력하고 똑똑하지만, 결정과 책임은 결국 사람의 몫이죠. Acorn은 AI와 사람이 자연스럽게 협업하기 위해 만들어진 도구입니다.

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## 개요

Acorn은 여러 Claude Code 세션을 한 창에서 병렬로 다루기 위한 데스크톱 앱입니다. 분할 Pane, 세션별 격리된 git worktree, 진행 상태 표시를 하나의 워크스페이스에서 제공합니다.

---

## 스크린샷

<div align="center">
  <img width="1392" height="912" alt="Acorn 메인 워크스페이스" src="https://github.com/user-attachments/assets/0405cb4e-f178-4ccd-8c72-83b8fb17c14a" />
  <br/>
  <sub>메인 워크스페이스 — 사이드바 + 분할 Pane + 우측 패널</sub>
  <br/><br/>
  <img width="1392" height="912" alt="screenshot1" src="https://github.com/user-attachments/assets/35c29493-6585-445f-8409-c0ce1e5e01fa" />
</div>

---

## 주요 기능

### 🪟 다중 Pane 워크스페이스
- 가로/세로 분할 + 자유로운 크기 조절
- Pane 간 세션 드래그-드롭, 탭 이동·복제·재배치
- 빈 Pane 더블 클릭으로 새 세션 생성

### 🌳 프로젝트 + 격리된 git Worktree
- 프로젝트별 사이드바 그룹핑, 드래그 재정렬
- 세션마다 별도 worktree로 동일 저장소를 안전하게 동시 작업
- 세션 종료 시 worktree 정리 옵션

### 💻 PTY 터미널
- 네이티브 PTY 기반 셸 세션
- 세션 재오픈 시 스크롤백 자동 복원
- 단축키로 세션·프로젝트 빠른 순회

### 🤖 Claude Code 세션 통합
- 세션 ID 기반으로 새 세션 / 이어가기 자동 분기
- 사이드바에 **유휴 / 입력 대기 / 작업 중** 라이브 상태 표시
- 우측 패널에서 현재 세션의 todo 리스트 확인

### 🛰️ Control session — 에이전트가 형제 세션을 조작 (preview)
- 한 control session에서 같은 프로젝트의 다른 세션들을 조작하는 오케스트레이션 좌석
- 시작: `⌘⌥⇧T` 또는 커맨드 팔레트 → **New control session** (사이드바에 🤖 아이콘)
- 안에서 띄운 에이전트는 자동으로 priming됨 — `ACORN_SESSION_ID` / `ACORN_IPC_SOCKET` 환경변수, Claude Code의 `--append-system-prompt` 주입, `.acorn-control.md` 마커
- 번들된 `acorn-ipc` CLI가 PTY의 PATH에 자동 prepend → **control session 안에선 설치 단계 없이 바로 사용 가능**
- 6가지 명령: `list-sessions`, `send-keys`, `read-buffer`, `new-session`, `select-session`, `kill-session`
- 권한: control session만 발신 가능, 같은 프로젝트 내부로 스코프 제한 (`Unauthorized` / `OutOfScope`)
- 외부 셸에서 호출하려면 Settings → Sessions → "Control sessions"의 install pill 사용
- 자세한 사용법 + 보안 모델: [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md)
- 플랫폼: macOS / Linux (Unix 도메인 소켓 기반, Windows 미지원)

### 🎯 우측 패널
- **Todos** — Claude Code가 진행 중인 작업
- **Commits** — 현재 worktree의 커밋 + Diff 모달
- **Staged** — 스테이징된 변경
- **Pull Requests** — 저장소 PR 리스트, 체크 상태 배지, 상세 보기에서 머지/클로즈
  - 머지 메시지를 AI(Anthropic / OpenAI / Gemini)로 자동 생성

### 🔍 Diff 뷰어
- 통합 / 분할 모드 토글
- 신택스 하이라이팅

### ⌨️ 커맨드 팔레트 + 단축키
| Action | Shortcut |
| --- | --- |
| 커맨드 팔레트 | `⌘P` |
| 새 세션 | `⌘T` |
| 새 control session | `⌘⌥⇧T` |
| Pane 분할 (세로/가로) | `⌘D` / `⌘⇧D` |
| 탭 닫기 | `⌘W` |
| 사이드바 / 메인 / 우측 패널 포커스 | `⌘1` / `⌘2` / `⌘3` |
| Todos / Commits / Staged 토글 | `⌘⇧T` / `⌘⇧C` / `⌘⇧S` |
| 다음/이전 세션 | `Ctrl+Tab` / `Ctrl+⇧+Tab` |
| 다음/이전 프로젝트 | `Ctrl+Alt+Tab` / `Ctrl+Alt+⇧+Tab` |
| 터미널 클리어 | `⌘K` |
| 설정 | `⌘,` |

### 🔔 네이티브 알림
- 입력 대기 / 실패 / 완료 이벤트별 토글

### ♻️ 자동 업데이트 (macOS)
- 새 버전 감지 시 상단 배너로 안내
- 강제 업데이트 없음, 사용자가 적용 시점 선택

### 🎛️ 설정
- 터미널 폰트 / 사이즈 / weight 커스터마이즈
- 세션 시작 명령 선택 (`claude` / `$SHELL` / 사용자 정의)
- "Open in editor" 외부 명령 지정
- AI 기능의 공급자 통합 선택
- Storage 정리 — orphan worktree, 캐시

### 📊 상태 표시줄
- 메모리 사용량 + 프로세스별 Memory Breakdown
- 현재 worktree 브랜치 + GitHub 계정 배지

---

## 설치 / 실행

### 릴리스 DMG로 설치 (macOS)

[Releases](https://github.com/im-ian/acorn/releases/latest)에서 `Acorn_*_aarch64.dmg`(Apple Silicon) 또는 `Acorn_*_x64.dmg`(Intel)를 받아 `Applications`로 복사한 뒤, 처음 한 번 quarantine 속성을 제거해주세요:

```bash
xattr -dr com.apple.quarantine /Applications/Acorn.app
```

> Acorn은 Apple Developer ID로 서명·공증되지 않은 ad-hoc 서명 빌드입니다. 위 명령은 OS 정책(Gatekeeper)의 quarantine 플래그만 떼는 단계로, 앱 무결성에는 영향이 없습니다.

### 소스에서 빌드

요구사항: **Bun** ≥ 1.x, **Rust** stable, **Xcode CLT** (macOS) 또는 OS 별 Tauri 사전 요구사항.

```bash
bun install
bun run tauri dev      # 개발 모드
bun run tauri build    # 프로덕션 빌드
```

> ⚠️ Acorn은 `claude` 바이너리가 `$PATH`에 있어야 기본 모드로 세션을 스폰합니다. 없는 경우 설정에서 시작 모드를 `terminal` 또는 `custom`으로 바꾸세요.

### 테스트

```bash
bun run test       # Vitest
bun run test:e2e   # Playwright
```

기여 가이드는 [`CLAUDE.md`](CLAUDE.md) 참고.

---

## 제작자

🐿️ by [@im-ian](https://github.com/im-ian) — issues / PRs welcome.
