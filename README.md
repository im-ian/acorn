<div align="center">

<img src="./assets/acorn.svg" width="120" height="120" alt="Acorn" />

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

Acorn은 여러 개의 Claude Code 세션을 한 창에서 병렬로 다루기 위한 데스크톱 앱입니다. 분할 페인, 드래그-드롭 탭, 세션별 격리된 git worktree, 트랜스크립트 기반 라이브 상태를 한곳에 묶었습니다.

> Tauri 2 + React 19 + Vite + Bun, PTY는 `portable-pty` 기반, 터미널은 xterm.js, 상태는 Zustand, 단축키는 tinykeys.

---

## 스크린샷

<div align="center">
  <img width="1348" alt="Acorn 메인 워크스페이스" src="https://github.com/user-attachments/assets/9a4d6c4a-1d33-43af-a39b-8da5eee929f1" />
  <br/>
  <sub>메인 워크스페이스 — 사이드바 + 분할 페인 + 우측 패널</sub>
</div>

---

## 주요 기능

### 🪟 다중 페인 워크스페이스
- 가로/세로 분할, 어느 페인에든 세션을 드래그-드롭
- 빈 페인 더블 클릭으로 새 세션 즉시 스폰
- 탭 단위 이동·복제·재배치
- `react-resizable-panels` 기반의 부드러운 리사이즈

### 🌳 프로젝트 + 격리된 git Worktree
- 프로젝트별 사이드바 그룹핑·드래그 재정렬
- 세션마다 별도 worktree 생성 → 한 저장소를 동시 다발로 작업해도 인덱스 충돌 없음
- 세션 제거 시 worktree 정리 여부 선택

### 💻 PTY 터미널
- `portable-pty` 백엔드 + `xterm.js` 프론트
- WKWebView CJK IME 종결자 처리 (조합 중 한글/일본어/중국어가 끊기는 문제 우회)
- `cmd+arrow` 라인 점프, 공백 중복 처리, 미리보기 리렌더 등 macOS 친화 패치
- `Ctrl+Tab` / `Ctrl+Shift+Tab` 으로 세션 순회, `Ctrl+Alt+Tab` 으로 프로젝트 순회

### 🤖 Claude Code 세션 통합
- 세션 ID로 `claude --session-id` (신규) / `claude --resume` (이어가기) 자동 분기
  - `~/.claude/projects/*/{session-id}.jsonl` 트랜스크립트 존재 여부로 판단
- 트랜스크립트를 파싱해 사이드바에 **유휴/대기/작업 중** 상태 라이브 표시
- 우측 패널에서 현재 세션의 todo 리스트 실시간 추출
  - 레거시 `TodoWrite` 스냅샷 + 신형 `TaskCreate` / `TaskUpdate` 이벤트 모두 재생

### 🎯 우측 패널 (Right Panel)
- **Todos** — Claude Code가 진행 중인 작업 목록
- **Commits** — 현재 worktree HEAD부터의 커밋 로그, 더블 클릭으로 펼침 + Diff 모달
- **Staged** — 스테이징된 변경사항 한눈에

### 🔍 Diff 뷰어
- 통합/분할 모드 토글
- `shiki` 기반 신택스 하이라이팅
- `react-diff-viewer-continued` 위에 가벼운 래퍼

### ⌨️ 커맨드 팔레트 + 단축키
| Action | Shortcut |
| --- | --- |
| 커맨드 팔레트 열기 | `⌘P` |
| 새 세션 | `⌘T` |
| 페인 분할 (세로/가로) | `⌘D` / `⌘⇧D` |
| 탭 닫기 | `⌘W` |
| 사이드바 / 메인 / 우측 패널 포커스 | `⌘1` / `⌘2` / `⌘3` |
| Todos / Commits / Staged 토글 | `⌘⇧T` / `⌘⇧C` / `⌘⇧S` |
| 다음/이전 세션 | `Ctrl+Tab` / `Ctrl+⇧+Tab` |
| 다음/이전 프로젝트 | `Ctrl+Alt+Tab` / `Ctrl+Alt+⇧+Tab` |
| 터미널 클리어 | `⌘K` |
| 설정 | `⌘,` |

### 🔔 네이티브 알림
- "입력 대기 / 실패 / 완료" 이벤트별 토글
- Tauri `plugin-notification` 사용

### 🎛️ 설정
- 터미널 폰트 패밀리 / 사이즈 / weight (regular + bold 분리)
- 세션 시작 명령: `claude` (기본) / `$SHELL` 터미널 / 사용자 정의 명령
- "Open in editor" 외부 명령 (예: `code --wait`)
- 비격리 세션 제거 시 확인 다이얼로그 토글

### 📊 상태 표시줄
- 메모리 프로브 + 클릭 시 프로세스별 분해(Memory Breakdown)

---

## 설치 / 실행

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

