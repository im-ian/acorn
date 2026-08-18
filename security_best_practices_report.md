# Acorn Security Best-Practices Report

검토 기준일: 2026-08-18

대상: Acorn 데스크톱 앱, Rust/Tauri 백엔드, React 렌더러, 로컬 IPC/데몬,
PTY·AI CLI 연동, 파일·트랜스크립트 처리, GitHub 연동, 설치·릴리스 파이프라인

## Executive summary

이번 검토는 악성 저장소/파일/원격 콘텐츠뿐 아니라 **일반 권한의 악성 동일 UID
로컬 프로세스**도 공격자로 포함했다. 확인된 인증·권한·TOCTOU·명령 실행·무제한
입출력·콘텐츠 렌더링·업데이트 공급망 문제는 공통 경계로 재구성해 완화했다.

현재 모델 안에서 재현 가능한 Critical/High 취약점은 남아 있지 않다. 다만 다음 세
가지는 코드만으로 닫을 수 없는 명시적 잔여 위험이다.

1. Apple Developer ID와 Windows Authenticode 인증서가 없어 OS가 배포자의 신원을
   증명하지 못한다. 따라서 새 버전은 앱 안에서 설치하지 않고 공식 GitHub 릴리스
   페이지만 연다.
2. 동일 UID 공격자가 디버거 연결, 프로세스 메모리 읽기/주입, 환경·파일 감시 권한을
   이미 가진 OS에서는 앱 내부 capability만으로 완전 격리할 수 없다. 이번 변경은
   소켓 스푸핑·재사용·교차 프로젝트 명령을 차단하지만 커널/디버거 경계를 대체하지
   않는다.
3. 비배포 Linux 빌드의 Tauri 2 → GTK3 전이 의존성에는 `glib 0.18.5`
   `RUSTSEC-2024-0429`와 유지보수 종료 경고가 남는다. 현재 릴리스 대상인 macOS와
   Windows에는 GTK3가 포함되지 않으며, 근본 해결은 Tauri 3/GTK4 전환이다.

## Severity model

| 등급 | 의미 |
| --- | --- |
| Critical | 사용자 상호작용 없이 임의 명령/권한 획득 또는 릴리스 공급망 장악 가능 |
| High | 프로젝트·세션 경계 우회, 민감 파일 접근, 지속적 코드 실행 가능 |
| Medium | 제한적 정보 노출, 서비스 거부, 콘텐츠 기반 오작동 가능 |
| Low | 방어 심층화 또는 운영상 오용 방지 |

## Findings

### SBP-001 — 로컬 IPC의 세션 사칭과 권한 상승

- 이전 위험: 같은 사용자로 실행되는 프로세스가 세션 UUID만 알면 제어 세션으로
  자신을 승격하거나 다른 프로젝트 세션에 명령을 보낼 수 있었다.
- 등급: Critical.
- 상태: **Resolved**, 동일 UID 디버거/주입 한계는 SBP-013에 별도 기록.
- 조치:
  - 프로토콜 v2 envelope에 세션별 UUID capability를 필수화했다
    (`src-tauri/crates/acorn-ipc/src/proto.rs:23-42`).
  - 서버가 capability를 한 번 바인딩하고 교체를 거부한다
    (`src-tauri/src/ipc/server.rs:490-522`).
  - 커널이 보고한 peer PID, 실제 실행 파일, PTY 루트의 프로세스 조상을 함께
    검증한다 (`src-tauri/src/ipc/server.rs:237-292`).
  - 일반 세션의 self-promotion을 제거하고 Acorn UI가 만든 Control 세션만 명령
    권한을 가진다. 대상 조회·명령은 같은 프로젝트로 제한된다
    (`src-tauri/src/ipc/server.rs:550-613`, `docs/CONTROL_SESSIONS.md:316-355`).
  - 요청/응답 프레임과 연결 수, 읽기/쓰기 시간을 제한했다
    (`src-tauri/crates/acorn-ipc/src/proto.rs:23-28`,
    `src-tauri/crates/acorn-ipc/src/bin/acorn-ipc.rs:499-588`).

### SBP-002 — 데몬 소켓 탈취, 중복 데몬, 전역 제어 노출

- 이전 위험: PID 파일 경쟁, 가짜 로컬 소켓, 무인증 CLI가 세션 목록·종료 등
  데몬 전역 상태를 조작할 수 있었다.
- 등급: Critical.
- 상태: **Resolved**.
- 조치:
  - `fs2` 커널 락을 데몬 수명 동안 보유한다
    (`src-tauri/crates/acorn-daemon/src/lifecycle.rs:32-88`).
  - 소유자 전용 인증 토큰을 안전한 일반 파일로 생성·검증한다
    (`src-tauri/crates/acorn-daemon/src/auth.rs:15-59`).
  - 양방향 peer PID/실행 파일 검사, 세션 capability·조상·생존성·프로젝트 범위를
    검증한다 (`src-tauri/crates/acorn-daemon/src/server.rs:195-237`,
    `src-tauri/crates/acorn-daemon/src/server.rs:641-761`).
  - 세션 권한으로 Status/Shutdown을 호출할 수 없고 외부 shutdown CLI도 제거했다.
  - 프레임, 연결 수, 소켓 I/O deadline을 공통 제한으로 적용했다
    (`src-tauri/crates/acorn-daemon/src/wire.rs:13-35`).

### SBP-003 — 수동 보조 AI 작업이 에이전트 권한을 상속

- 이전 위험: 세션 제목·커밋 메시지 같은 자동 생성이 저장소 지침, 도구, 브라우저,
  지속 세션과 `ACORN_*` 권한 환경을 사용할 수 있었다.
- 등급: High.
- 상태: **Resolved**.
- 조치:
  - 수동 보조 작업 전용 `resolve_passive_text`/`run_passive_text` 경계를 만들었다
    (`src-tauri/src/ai.rs:145-205`, `src-tauri/src/ai.rs:288-310`).
  - Claude는 tool-free/safe/non-persistent 모드, LLM은 no-log/no-stream만 허용하고,
    안전한 비에이전트 모드를 확인할 수 없는 Codex·Antigravity·Grok은 거부한다.
  - prompt는 argv가 아닌 stdin으로만 전달하고 빈 private cwd에서 실행하며 모든
    `ACORN_*` 환경을 제거한다 (`src-tauri/src/ai.rs:358-439`).
  - 출력·시간·프로세스 트리는 제한된 one-shot 경로에서 종료한다.

### SBP-004 — 파일 TOCTOU, symlink 추적, 무제한 파일/미디어 읽기

- 이전 위험: 경로 검사 후 파일 교체, symlink/hardlink 우회, 큰 파일·PDF·이미지로
  메모리 고갈, 원본 경로를 WebView asset protocol에 직접 노출할 수 있었다.
- 등급: High.
- 상태: **Resolved**, 동일 UID가 OS 권한으로 snapshot 파일을 읽는 문제는
  SBP-013의 플랫폼 한계에 포함.
- 조치:
  - 공통 `open_regular_nofollow`가 no-follow open 뒤 실제 regular-file metadata를
    재검증한다 (`src-tauri/crates/acorn-platform/src/fs.rs:13-42`).
  - 저장소·외부 grant 범위를 canonical path와 descriptor로 다시 확인한다.
  - media/PDF는 검증된 descriptor에서 private read-only snapshot으로 복사하고,
    capability 단위로 Tauri asset scope를 추가·회수한다
    (`src-tauri/src/fs_explorer.rs:1212-1464`).
  - 이미지/PDF 64 MiB, 오디오/비디오 512 MiB, 활성 snapshot 총 1 GiB/64개로
    제한하고 PDF magic을 확인한다.
  - 상태, scrollback, transcript, theme, clipboard attachment, diff/image preview에
    파일·줄·디렉터리 엔트리·총합 제한을 적용했다.

### SBP-005 — 자식 프로세스 무기한 실행과 stdout/stderr 메모리 고갈

- 이전 위험: `Command::output`과 순차 pipe 읽기가 timeout 없이 대용량 출력을
  수집하거나 fork 후 pipe를 보유한 자식 때문에 영구 대기할 수 있었다.
- 등급: High.
- 상태: **Resolved**.
- 조치:
  - 공통 `run_bounded`가 stdin/stdout/stderr 크기, wall-clock deadline, 동시 pipe
    drain, 프로세스 트리 종료·reap을 제공한다
    (`src-tauri/crates/acorn-platform/src/process.rs:73-191`).
  - CLI resolver, shell 환경 탐지, GitHub CLI body 입력, git identity, sqlite usage,
    OS 권한 probe를 같은 경계로 이관했다
    (`src-tauri/src/cli_resolver.rs:46-60`, `src-tauri/src/shell_env.rs:90-104`).
  - 저장소가 제어하는 SSH alias에서 `ssh -G`의 `Match exec`가 실행되지 않도록,
    `~/.ssh/config`의 단순 literal `Host` → `HostName`만 bounded/no-follow 파싱한다
    (`src-tauri/src/git_ops.rs:333-396`).

### SBP-006 — 원격 URL·Markdown·로그 문자열의 권한 스킴/콘텐츠 주입

- 이전 위험: `javascript:`, `file:`, userinfo URL, 모호한 역슬래시/개행 URL,
  원격 Markdown 링크·이미지, terminal control/bidi 문자가 OS opener나 로그로
  전달될 수 있었다.
- 등급: High.
- 상태: **Resolved**.
- 조치:
  - Rust가 원문을 strict parse해 HTTP(S)와 제한된 mailto만 허용하고 OS opener를
    호출한다 (`src-tauri/src/external_url.rs:15-79`).
  - 모든 React 호출부는 `openSafeUrl` 단일 경계를 사용한다
    (`src/lib/safeOpenUrl.ts:1-63`).
  - Markdown 링크는 버튼으로 안전하게 열고, 원격 이미지는 명시적 사용자 load
    전까지 요청하지 않으며, HTML 주입을 허용하지 않는다.
  - GitHub/데몬/IPC에서 표시되는 이름과 오류의 control/bidi 문자를 제거하고 길이를
    제한한다.

### SBP-007 — 인증서 없는 앱 내 자동 업데이트 설치

- 이전 위험: minisign/Tauri signature가 artifact 무결성은 확인해도 Apple/Windows
  publisher identity를 증명하지 못하는 상태에서 앱이 다운로드·설치·재시작했다.
- 등급: High.
- 상태: **Mitigated; publisher identity residual**.
- 조치:
  - runtime updater/process 플러그인과 download/install/relaunch 권한을 제거했다
    (`src-tauri/capabilities/default.json:6-48`).
  - 앱은 bounded GitHub release metadata를 확인하고 정확한 정식 semver가 새 버전일
    때 공식 릴리스 페이지만 연다 (`src/lib/updater.ts:49-88`).
  - `latest.json`과 서명 파일은 구버전 호환 및 독립 검증을 위해 유지하지만, 새 앱은
    설치하지 않는다 (`.github/workflows/release.yml:506-520`).
  - 인증서가 확보되기 전에는 수동 설치 경고를 계속 표시해야 한다.

### SBP-008 — 릴리스·설치 공급망의 변조와 캐시 오염

- 이전 위험: 움직일 수 있는 tag/asset, 재실행 덮어쓰기, 권한 잡의 mutable cache,
  미검증 installer URL·아키텍처·bundle identity가 악성 artifact를 배포할 수 있었다.
- 등급: Critical.
- 상태: **Resolved except OS publisher identity**.
- 조치:
  - 액션을 full commit SHA로 pin하고, 최소 권한·immutable commit/tag·main ancestry,
    기존 asset 거부, `overwrite_files: false`를 적용했다.
  - 모든 release job에서 setup-node package-manager cache를 명시적으로 껐다
    (`.github/workflows/release.yml:53-56`, `:121-124`, `:247-250`, `:332-335`,
    `:391-398`).
  - publish 전에 세 플랫폼 artifact의 minisign 서명을 bounded/no-follow verifier로
    검증한다 (`.github/workflows/release.yml:407-422`,
    `src-tauri/crates/acorn-updater-verify/src/main.rs:17-57`).
  - macOS installer는 HTTPS-only/TLS 1.2+, canonical GitHub URL, GitHub SHA-256 digest,
    DMG·codesign·bundle ID·아키텍처를 확인한다 (`scripts/install-macos.sh:66-147`).
  - 인증서가 없다는 경고를 모든 release notes에 추가한다
    (`.github/workflows/release.yml:481-501`).

### SBP-009 — GitHub CLI/API 인자·GraphQL·응답 크기 주입

- 이전 위험: slug/OID/path가 GraphQL 또는 REST 경로에 보간되고, `gh`가 prompt를
  열거나 큰 JSON/blob을 메모리에 적재할 수 있었다.
- 등급: High.
- 상태: **Resolved**.
- 조치:
  - owner/repository, commit OID, login, numeric ID를 strict validate한다.
  - GraphQL 값은 variables로 보내고 REST path component는 percent encode한다.
  - `GH_PROMPT_DISABLED`, `--`, stdin body와 공통 bounded runner를 사용한다.
  - API JSON, comment/body, diff, commit graph, image/blob의 개별·총합·페이지 제한을
    적용했다 (`src-tauri/src/pull_requests.rs`, `src-tauri/src/git_ops.rs`).

### SBP-010 — transcript/hook/persistence 기반 symlink·DoS·상태 위조

- 이전 위험: 에이전트가 쓸 수 있는 transcript/marker/spool 경로에서 symlink,
  과대 JSONL line, 무제한 디렉터리 순회, 오래된 lifecycle 이벤트가 앱 상태를
  오염시킬 수 있었다.
- 등급: High.
- 상태: **Resolved within ordinary-process model**.
- 조치:
  - 모든 provider history에 root·depth·entry·file·line·byte budget을 공유한다.
  - marker/ack/spool/scrollback/state는 regular/no-follow·atomic replace·owner-only
    권한·revision fence를 사용한다.
  - hook HTTP에는 random token, header/body cap, connection cap, serialized side effect,
    owner/child/turn correlation을 적용했다.

### SBP-011 — theme/CSS, clipboard, media와 UI 계산의 자원·네트워크 오용

- 이전 위험: CSS `url`/`@import` 우회, symlink theme, 큰 clipboard image, remote avatar,
  사용자/저장소 문자열을 동적 regex로 실행해 네트워크 요청 또는 UI 정지를 유발할
  수 있었다.
- 등급: Medium.
- 상태: **Resolved**, 명시적으로 켠 로컬 regex 검색은 아래 Notes 참고.
- 조치:
  - theme catalog/metadata/CSS를 regular/no-follow·byte cap·UTF-8·timeout으로 읽고
    CSS escape 정규화 뒤 네트워크 primitive를 거부한다
    (`src/lib/themes.ts:106-180`, `:613-668`).
  - 파일 글롭을 regex가 아닌 선형 `*`/`?` matcher로 바꾸고 pattern/list 길이와
    개수를 제한했다 (`src/components/FileExplorer.tsx:159-260`).
  - clipboard·background·avatar·release response에 MIME/크기/URL/총량 제한과
    안전한 앱 로컬 파일 처리를 적용했다.

### SBP-012 — 의존성 취약점과 유지보수 종료 코드

- 이전 위험: 취약한 `quick-xml` 전이 버전과 자동 감사 부재.
- 등급: High for known vulnerability, Medium for unmaintained dependencies.
- 상태: **Known vulnerabilities resolved; warnings deferred**.
- 조치:
  - 취약 전이 의존성을 제거하고 lockfile을 갱신했다.
  - `pnpm audit`와 pinned `cargo-audit 0.22.2`를 PR/main/주간 workflow에 추가했다
    (`.github/workflows/security.yml`).
  - 2026-08-18 감사 결과 알려진 취약점 0, 허용 경고 17건. 그중
    `RUSTSEC-2024-0429`는 Tauri 2의 Linux GTK3 의존성에 묶여 있다. 나머지는 GTK3
    및 전이 유틸리티 유지보수 종료 경고다.

### SBP-013 — 동일 UID 공격자에 대한 플랫폼 한계

- 이전 위험: 로컬 소켓 파일 권한만으로 같은 UID 프로세스를 신뢰했다.
- 등급: High.
- 상태: **Partially mitigated / accepted residual**.
- 적용된 방어: kernel peer PID, 실행 파일 이름, 프로세스 조상, per-session UUID,
  daemon auth token, project scope, deadlines, one-time binding, authority revoke.
- 남는 한계: unsigned/writable 실행 파일 대체, 디버거 attach, 메모리·환경 추출,
  동일 UID 파일 읽기, 합법 프로세스에 대한 코드 주입을 OS가 허용하면 capability를
  탈취할 수 있다. 완화의 다음 단계는 publisher signing, hardened runtime,
  App Sandbox/Windows integrity boundary와 OS별 code identity 검증이다.

### SBP-014 — CI workflow injection과 권한·캐시 경계

- 이전 위험: tag/input가 shell에 직접 보간되거나 release 권한 잡이 untrusted cache를
  복원하고, third-party action tag가 이동할 수 있었다.
- 등급: High.
- 상태: **Resolved**.
- 조치: expression은 `env`로 전달 후 validate하고, 액션 SHA pin, 최소 permissions,
  `persist-credentials: false`, job timeout/concurrency, no package-manager cache를
  적용했다. Zizmor 1.22.0과 GitHub Workflow JSON schema 검증은 모두 0건이다.

## Verification evidence

| 검사 | 결과 |
| --- | --- |
| `cargo test --workspace --all-targets --locked` | 성공; root 788개 포함 전체 workspace 실패 0 |
| `cargo test -p acorn-daemon -p acorn-ipc --locked` | 성공; 58 + 20 + CLI 15, 실패 0 |
| `cargo test -p acorn-pty --locked` | 성공; tail-cap 회귀 검사를 포함한 7 tests |
| `pnpm run test` | 성공; 118 files / 1,410 tests |
| 신규 글롭·URL·theme·terminal 집중 테스트 | 성공; 4 files / 62 tests |
| `pnpm run typecheck` / `pnpm run build` | 성공 |
| `cargo check --workspace --all-targets --locked` | 성공; 기존 dead-code 경고 2건 |
| `cargo fmt --all -- --check` / `git diff --check` | 성공 |
| `cargo clippy --workspace --all-targets --locked` | 종료 코드 0; 기존 비보안 스타일 경고는 남음 |
| `pnpm audit --audit-level=low` | 알려진 취약점 0 |
| `cargo-audit 0.22.2` | 알려진 취약점 0; allowed warnings 17 |
| Semgrep default | 전체 515 files에서 finding 0; 일부 대형 기존 파일 rule timeout |
| Semgrep changed-files rerun (`--timeout 30`) | 46 files / 210 rules, timeout·finding 0 |
| Zizmor 1.22.0 | 3 workflows, finding 0 |
| GitHub Workflow JSON schema | 성공 |
| detect-secrets | 후보 전수 판별; lock integrity/public key/test fixture 외 실제 비밀 0 |

## Operational requirements and follow-up

1. Apple Developer ID와 Windows Authenticode 인증서를 확보하면 CI secret을 OIDC 또는
   최소 권한 signing service로 공급하고, notarization/SmartScreen 검증을 추가한 뒤에만
   앱 내 설치 재도입을 별도 설계 검토한다.
2. Tauri 3/GTK4가 프로젝트 요구사항을 충족하면 Linux 전이 의존성을 마이그레이션하고
   `RUSTSEC-2024-0429` 및 GTK3 유지보수 종료 경고가 실제로 사라졌는지 재감사한다.
3. 동일 UID를 강한 적대 경계로 유지하려면 macOS Hardened Runtime/App Sandbox와
   Windows publisher/process integrity 정책을 배포 문서와 함께 운영해야 한다.
4. 사용자가 직접 켜는 파일 탐색기 regex 모드는 로컬 입력·256자 제한·파일명 길이
   제한을 가진 명시적 기능이다. 저장소 콘텐츠가 pattern을 채우지 않는다. 더 강한
   CPU 상한이 필요하면 native RE2 계열 엔진 또는 worker deadline으로 교체한다.

## Conclusion

Acorn의 보안 경계는 이제 “경로/UUID를 안다”가 곧 권한이던 구조에서 descriptor,
capability, kernel peer identity, project scope, bounded I/O, explicit user action을 조합한
구조로 바뀌었다. 위 잔여 위험을 제외하면 이번 위협 모델에서 확인된 문제는 수정되고
회귀 테스트로 고정되었다.
