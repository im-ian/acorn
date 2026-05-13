<div align="center">

<img src="./assets/acorn.png" width="120" height="120" alt="Acorn" />

# Acorn 🌰

**병렬 AI 에이전트 세션을 한 창에서.**
*Parallel AI coding agent sessions in one window — split panes, isolated git worktrees, native PTY terminals.*

AI는 강력하고 똑똑하지만, 결정과 책임은 결국 사람의 몫이죠. Acorn은 AI와 사람이 자연스럽게 협업하기 위해 만들어진 도구입니다.

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## 개요

Acorn은 여러 AI 코딩 에이전트(Claude Code / Codex / Gemini / Ollama / llm 등) 세션을 한 창에서 병렬로 다루기 위한 데스크톱 앱입니다. 분할 Pane, 세션별 격리된 git worktree, 진행 상태 표시를 하나의 워크스페이스에서 제공합니다.

---

## 스크린샷

<div align="center">
  <img width="1392" height="912" alt="Acorn 메인 워크스페이스" src="https://github.com/user-attachments/assets/0405cb4e-f178-4ccd-8c72-83b8fb17c14a" />
  <br/>
  <sub>메인 워크스페이스 — 사이드바 + 분할 Pane + 우측 패널</sub>
  <br/><br/>
  <img width="1392" height="912" alt="Acorn PR 상세 모달" src="https://github.com/user-attachments/assets/35c29493-6585-445f-8409-c0ce1e5e01fa" />
  <br/>
  <sub>PR 상세 모달 — 체크 상태 + 변경 사항 + 머지 옵션</sub>
  <br/><br/>
  <img width="1552" height="916" alt="Acorn control session — acorn-ipc" src="https://github.com/user-attachments/assets/b7c4ae60-622c-4f62-9a15-fb2522f287a5" />
  <br/>
  <sub>Control session — `acorn-ipc`로 형제 세션 조작</sub>
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

### 🤖 AI 에이전트 세션
- 세션은 항상 `$SHELL`로 시작 — 그 안에서 원하는 AI CLI(`claude` / `codex` / `gemini` / `ollama` / `llm` 등)를 직접 실행
- 다음 항목은 **Claude Code 전용** — Claude Code의 JSONL transcript(`~/.claude/projects/`) 파싱에 의존:
  - 사이드바의 **유휴 / 입력 대기 / 작업 중** 라이브 상태 표시
  - 우측 패널의 todo 리스트

### 💾 에이전트 대화 영속화
- Acorn 세션에서 `claude` / `codex`를 띄운 뒤 앱을 껐다 켜도 **이전 대화 그대로 이어서** 사용 가능
- 별도 설정 / 설치 단계 없음 — 그냥 `claude` 또는 `codex` 치면 자동 적용
- 사용자가 직접 옵션이나 서브커맨드를 지정한 호출은 그대로 통과

### 🛏️ Background sessions
- Acorn 앱을 종료·재시작해도 **PTY 세션이 그대로 살아 있음** — 다시 열면 화면도 복원
- 기본 ON. 끄면 기존 동작(앱 종료 시 세션 같이 종료)으로 폴백
- Settings → Sessions에서 상태 확인, 재시작·종료 제어
- 상태 표시줄 아이콘 → 드롭다운으로 서비스 상태 한눈에 확인

### 🛰️ Control session — 에이전트가 형제 세션을 조작
- 한 세션 안의 AI 에이전트가 같은 프로젝트의 다른 세션을 직접 조작 (입력 전송, 화면 읽기, 새 세션 생성, 선택, 종료)
- 시작: `⌘⌥⇧T` 또는 커맨드 팔레트 → **New control session** (사이드바에 🤖 아이콘)
- 같은 프로젝트 내부로 권한 자동 스코프
- 자세한 사용법 + 보안 모델: [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md)
- 플랫폼: macOS / Linux (Windows 미지원)

### 🎯 우측 패널
- **Todos** — 진행 중인 작업 (**Claude Code 전용** — transcript의 `TodoWrite` 이벤트 파싱)
- **Commits** — 현재 worktree의 커밋 + Diff 모달
- **Staged** — 스테이징된 변경
- **Pull Requests** — 저장소 PR 리스트, 체크 상태 배지, 상세 보기에서 머지/클로즈
  - 머지 메시지를 설치된 AI CLI(`claude` / `codex` / `gemini` / `ollama` / `llm`)로 자동 생성

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
- Appearance에서 빌트인/custom theme, 배경 이미지(fit/opacity/blur), 터미널 폰트 3-slot fallback 설정
- AI 기능(머지 메시지 등)에 쓸 공급자(`claude` / `codex` / `gemini` / `ollama` / `llm` / 커스텀) 선택
- "Open in editor" 외부 명령 지정
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
bun run build:sidecar  # acorn-ipc + acornd 사이드카 빌드 (최초 1회 + IPC/daemon 변경 시)
bun run tauri dev      # 개발 모드
bun run tauri build    # 프로덕션 빌드
```

> ℹ️ `bun run tauri dev` / `tauri build`는 Tauri의 `externalBin` 규약에 따라 `src-tauri/binaries/acorn-ipc-<target-triple>`, `acornd-<target-triple>` 파일이 존재해야 시작합니다. 이 경로는 `.gitignore`에 포함돼 있어 fresh checkout(특히 `git worktree add`로 만들어진 worktree)에서는 비어 있고, 미리 빌드해두지 않으면 `resource path 'binaries/...' doesn't exist` 에러로 빌드가 실패합니다. `bun run build:sidecar`가 호스트 타깃에 맞는 두 바이너리를 빌드하고 올바른 위치에 stage합니다.

### 테스트

```bash
bun run test       # Vitest
bun run test:e2e   # Playwright
```

기여 가이드는 [`CLAUDE.md`](CLAUDE.md) 참고.

---

## 제작자

🐿️ by [@im-ian](https://github.com/im-ian) — issues / PRs welcome.
