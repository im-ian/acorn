<div align="center">

<img src="./assets/acorn.png" width="120" height="120" alt="Acorn" />

# Acorn 🌰

**병렬 Claude Code 세션을 한 창에서.**
*Parallel Claude Code sessions in one window — split panes, isolated git worktrees, native PTY terminals.*

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## 개요

Acorn은 여러 개의 Claude Code 세션을 한 창에서 병렬로 다루기 위한 데스크톱 앱입니다. 분할 Pane, 세션별 격리된 git worktree, 트랜스크립트 기반 상태 표시를 하나의 워크스페이스에서 다룹니다.

> Tauri 2 + React 19 + Vite + Bun, PTY는 `portable-pty`, 터미널은 xterm.js, 상태는 Zustand, 단축키는 tinykeys.

---

## 스크린샷

<div align="center">
  <img width="1348" alt="Acorn 메인 워크스페이스" src="https://github.com/user-attachments/assets/9a4d6c4a-1d33-43af-a39b-8da5eee929f1" />
  <br/>
  <sub>메인 워크스페이스 — 사이드바 + 분할 Pane + 우측 패널</sub>
</div>

---

## 주요 기능

### 🪟 다중 Pane 워크스페이스
- 가로/세로 분할, Pane 간 세션 드래그-드롭
- 빈 Pane 더블 클릭으로 새 세션 생성
- 탭 단위 이동·복제·재배치

### 🌳 프로젝트 + 격리된 git Worktree
- 프로젝트별 사이드바 그룹핑, 드래그 재정렬
- 세션마다 별도 worktree → 같은 저장소를 동시에 작업해도 인덱스가 분리됨
- 세션 제거 시 worktree 정리 여부 선택

### 💻 PTY 터미널
- `portable-pty` + `xterm.js`
- WKWebView CJK IME 조합 중 입력이 끊기는 문제 우회
- 세션 종료 후 재오픈 시 스크롤백 복원 (이벤트 단위로 디스크에 저장)
- `Ctrl+Tab` / `Ctrl+Shift+Tab` 으로 세션 순회, `Ctrl+Alt+Tab` 으로 프로젝트 순회

### 🤖 Claude Code 세션 통합
- 세션 ID 기반으로 `claude --session-id` (신규) / `claude --resume` (이어가기) 자동 분기
  - `~/.claude/projects/*/{session-id}.jsonl` 트랜스크립트 유무로 판단
- 트랜스크립트를 파싱해 사이드바에 **유휴 / 입력 대기 / 작업 중** 상태 표시
- 우측 패널에서 현재 세션의 todo 리스트 추출
  - 레거시 `TodoWrite` 스냅샷과 신형 `TaskCreate` / `TaskUpdate` 이벤트 모두 처리

### 🎯 우측 패널
- **Todos** — Claude Code가 진행 중인 작업 목록
- **Commits** — 현재 worktree HEAD 이후의 커밋, 더블 클릭으로 펼침 + Diff 모달
- **Staged** — 스테이징된 변경 한눈에 보기
- **Pull Requests** — 저장소의 PR 리스트, 체크 상태 배지, 상세 보기에서 머지/클로즈
  - 머지 시 머지 메시지를 AI로 생성 가능 (Anthropic / OpenAI / Gemini 중 선택)

### 🔍 Diff 뷰어
- 통합/분할 모드 토글
- `shiki` 신택스 하이라이팅

### ⌨️ 커맨드 팔레트 + 단축키
| Action | Shortcut |
| --- | --- |
| 커맨드 팔레트 | `⌘P` |
| 새 세션 | `⌘T` |
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
- Tauri `plugin-notification`

### ♻️ 자동 업데이트 (macOS)
- 새 버전 감지 시 상단 배너로 안내
- 사용자가 직접 적용 — 강제 업데이트 없음

### 🎛️ 설정
- 터미널 폰트 패밀리 / 사이즈 / weight (regular + bold 분리)
- 세션 시작 명령: `claude` (기본) / `$SHELL` 터미널 / 사용자 정의
- "Open in editor" 외부 명령 (예: `code --wait`)
- 비격리 세션 제거 시 확인 다이얼로그 토글
- 단일 AI Agents 탭에서 PR 머지 메시지 등 AI 기능의 공급자 통합 선택
- Storage 탭 — orphan worktree / 캐시 정리

### 📊 상태 표시줄
- 메모리 사용량 + 클릭 시 프로세스별 Memory Breakdown
- 우측에 현재 worktree 브랜치와 GitHub 계정 배지

---

## 설치 / 실행

### 릴리스 DMG로 설치 (macOS)

[Releases](https://github.com/im-ian/acorn/releases/latest)에서 `Acorn_*_aarch64.dmg`(Apple Silicon) 또는 `Acorn_*_x64.dmg`(Intel)를 받아 `Applications`로 복사한 뒤, 처음 한 번은 터미널에서 quarantine 속성을 제거해주세요:

```bash
xattr -dr com.apple.quarantine /Applications/Acorn.app
```

> Acorn은 Apple Developer ID로 서명·공증되지 않은 ad-hoc 서명 빌드입니다. macOS Gatekeeper는 브라우저로 받은 ad-hoc 앱을 처음 실행할 때 *"손상되었기 때문에 열 수 없습니다"* 로 막는데, 위 명령으로 quarantine 플래그만 떼주면 정상 실행됩니다 (앱 무결성과 별개의 OS 정책).

### 소스에서 빌드

요구사항: **Bun** ≥ 1.x, **Rust** stable, **Xcode CLT** (macOS) 또는 OS 별 Tauri 사전 요구사항.

```bash
# 의존성 설치
bun install

# 개발 모드 (Vite + Tauri dev 윈도우)
bun run tauri dev

# 프로덕션 빌드
bun run tauri build
```

> ⚠️ Acorn은 `claude` 바이너리가 `$PATH`에 있어야 기본 모드로 세션을 스폰합니다. 없는 경우 설정에서 시작 모드를 `terminal` 또는 `custom`으로 바꾸세요.

---

## 아키텍처 한눈에

```
┌──────────────────────────── React 19 (Vite + Tailwind 4) ────────────────────────────┐
│                                                                                       │
│   Sidebar  ─┐                                                                         │
│             ├──→  store (zustand)  ──→  Pane / LayoutRenderer / Terminal (xterm.js)    │
│   TopBar  ──┘                                            │                            │
│                                                          ▼                            │
│                                              src/lib/api.ts (invoke 래퍼)              │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │ Tauri IPC
┌──────────────────────────────────────────▼────────────────────────────────────────────┐
│                                  Rust (tauri 2 / src-tauri)                            │
│                                                                                       │
│   commands.rs  ──→  pty.rs (portable-pty)        worktree.rs (git2)                    │
│        │                                          git_ops.rs (commits / diffs)        │
│        ├──→  todos.rs  ←── ~/.claude/projects/*/<id>.jsonl 파서                        │
│        ├──→  session_status.rs (트랜스크립트 기반 라이브 상태)                          │
│        └──→  persistence.rs (~/Library/Application Support/io.im-ian.acorn/*.json)    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 폴더 구조

```
acorn/
├── assets/                # 로고/아이콘 (SVG)
├── screenshots/           # README용 PNG (직접 추가)
├── src/                   # React 프론트엔드
│   ├── components/        # Sidebar, Pane, Terminal, DiffView, ... (UI 단위)
│   ├── lib/               # api / dnd / hotkeys / settings / diff / ...
│   └── store.ts           # zustand 전역 상태
├── src-tauri/
│   ├── src/
│   │   ├── commands.rs        # IPC 커맨드 정의
│   │   ├── pty.rs             # PTY 라이프사이클
│   │   ├── session.rs         # 세션 스토어
│   │   ├── session_status.rs  # 트랜스크립트 → 상태 추론
│   │   ├── todos.rs           # TodoWrite + Task* 이벤트 재생
│   │   ├── git_ops.rs         # 커밋/Diff
│   │   ├── worktree.rs        # 격리 worktree
│   │   └── persistence.rs     # 디스크 영속화
│   ├── Cargo.toml
│   └── tauri.conf.json
└── docs/                  # 디자인 노트, 스펙
```

---

## 제작자

🐿️ by [@im-ian](https://github.com/im-ian) — issues / PRs welcome.

